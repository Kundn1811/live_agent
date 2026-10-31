import { useState, useRef, useCallback, useEffect } from 'react';
import { Room, RoomEvent, ParticipantEvent, Track } from 'livekit-client';
import config from '../config.js';
import { analysers, createAnalyser } from '../audioLevels.js';
import { getTurnstileToken } from '../turnstile.js';

// Agent state attribute published by the LiveKit agent on its participant.
const AGENT_STATE_ATTR = 'lk.agent.state';
const TRANSCRIPTION_TOPIC = 'lk.transcription';
const TRANSCRIPTION_FINAL_ATTR = 'lk.transcription_final';
// Set by the agent each turn: ms from the user finishing to the agent's first audio.
const REPLY_MS_ATTR = 'sparrow.reply_ms';
// Give up if the agent hasn't started listening by then (cold worker can take ~15s).
const AGENT_JOIN_TIMEOUT_MS = 40000;

// Krisp noise filter (LiveKit Cloud): much stronger than the browser's own noise suppression.
// Loaded lazily (it ships a WASM model) and in the background; if it is unsupported or fails,
// the browser's noise suppression, which is still on, carries on alone.
async function enableKrisp(micTrack) {
  try {
    const { KrispNoiseFilter, isKrispNoiseFilterSupported } = await import('@livekit/krisp-noise-filter');
    if (!isKrispNoiseFilterSupported()) return;
    await micTrack.setProcessor(KrispNoiseFilter());
    console.info('[krisp] noise filter on');
  } catch (err) {
    console.warn('[krisp] noise filter unavailable:', err);
  }
}

/**
 * LiveKit transport for the Sparrow agent: replaces useWebSocket + useAudioCapture
 * + useAudioPlayback in one hook. WebRTC handles mic capture (AEC/NS), Opus, and
 * playback; we only tap the tracks for the 3D orb's analysers.
 *
 * Callbacks mirror the WS flow: onReady (agent is listening), transcripts,
 * speaking-state flips, onError.
 */
export default function useLiveKitSession({
  onReady,
  onInputTranscript,
  onOutputTranscript,
  onUserSpeaking,
  onModelSpeaking,
  onError,
  onMetrics, // developer mode: latency numbers ({ perceivedFirstMs, serverFirstAudioMs, rttMs, ... })
  onConnectMarks, // developer mode: seconds-since-tap for each connect step
  devMetrics = false,
  recordMic = false, // developer mode: keep a local recording of what the mic sent
}) {
  const [connectionStatus, setConnectionStatus] = useState('disconnected');
  const [recordingUrl, setRecordingUrl] = useState(null);
  const recorderRef = useRef(null);
  const recordMicRef = useRef(recordMic);
  recordMicRef.current = recordMic;
  const [isMuted, setIsMuted] = useState(false);
  const roomRef = useRef(null);
  const audioCtxRef = useRef(null);
  const attachedRef = useRef([]); // <audio> elements we created for remote tracks
  const readyRef = useRef(false);
  const mutedRef = useRef(false);
  const readyTimerRef = useRef(null);
  const tConnectRef = useRef(0);
  const statsTimerRef = useRef(null);
  const devMetricsRef = useRef(devMetrics);
  devMetricsRef.current = devMetrics;

  // Latest callbacks, so the room handlers (bound once per connect) never go stale.
  const cbRef = useRef({});
  cbRef.current = {
    onReady, onInputTranscript, onOutputTranscript, onUserSpeaking, onModelSpeaking, onError,
    onMetrics, onConnectMarks,
  };

  const getCtx = useCallback(() => {
    if (!audioCtxRef.current || audioCtxRef.current.state === 'closed') {
      audioCtxRef.current = new AudioContext();
    }
    if (audioCtxRef.current.state === 'suspended') audioCtxRef.current.resume();
    return audioCtxRef.current;
  }, []);

  // Feed a MediaStream to an analyser for the orb. Never routed to the speakers —
  // playback itself goes through the <audio> element LiveKit attaches.
  const tapStream = useCallback((stream, slot) => {
    try {
      const ctx = getCtx();
      const analyser = createAnalyser(ctx);
      ctx.createMediaStreamSource(stream).connect(analyser);
      analysers[slot] = analyser;
    } catch (err) {
      console.warn('analyser tap failed:', err);
    }
  }, [getCtx]);

  // Records the published mic track (after noise filtering), from "ready" until the session
  // ends. The file stays in this browser; it is never uploaded.
  const startRecording = useCallback((room) => {
    try {
      const track = room.localParticipant.getTrackPublication(Track.Source.Microphone)?.track;
      if (!track?.mediaStreamTrack || typeof MediaRecorder === 'undefined') return;
      const chunks = [];
      const recorder = new MediaRecorder(new MediaStream([track.mediaStreamTrack]));
      recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      recorder.onstop = () => {
        if (!chunks.length) return;
        const url = URL.createObjectURL(new Blob(chunks, { type: recorder.mimeType }));
        setRecordingUrl((old) => {
          if (old) URL.revokeObjectURL(old);
          return url;
        });
      };
      recorder.start(1000);
      recorderRef.current = recorder;
    } catch (err) {
      console.warn('mic recording failed:', err);
    }
  }, []);

  // Round-trip time to LiveKit, polled from the mic sender's WebRTC stats (developer mode).
  const startStats = useCallback((room) => {
    clearInterval(statsTimerRef.current);
    statsTimerRef.current = setInterval(async () => {
      try {
        const track = room.localParticipant.getTrackPublication(Track.Source.Microphone)?.track;
        const stats = await track?.getSenderStats();
        if (stats?.roundTripTime != null) {
          cbRef.current.onMetrics?.({ rttMs: Math.round(stats.roundTripTime * 1000) });
        }
      } catch {
        /* stats not available yet */
      }
    }, 2000);
  }, []);

  const teardown = useCallback(() => {
    clearInterval(statsTimerRef.current);
    const recorder = recorderRef.current;
    recorderRef.current = null;
    if (recorder && recorder.state !== 'inactive') recorder.stop();
    analysers.input = null;
    analysers.output = null;
    attachedRef.current.forEach((el) => el.remove());
    attachedRef.current = [];
    if (audioCtxRef.current && audioCtxRef.current.state !== 'closed') {
      audioCtxRef.current.close();
    }
    audioCtxRef.current = null;
    readyRef.current = false;
  }, []);

  const disconnect = useCallback(() => {
    clearTimeout(readyTimerRef.current);
    const room = roomRef.current;
    roomRef.current = null;
    if (room) {
      room.removeAllListeners();
      room.disconnect();
    }
    teardown();
    mutedRef.current = false;
    setIsMuted(false);
    setConnectionStatus('disconnected');
  }, [teardown]);

  // `code` selects the private route; without it the public Sparrow is used.
  const connect = useCallback(async (code) => {
    if (roomRef.current) disconnect();
    setConnectionStatus('connecting');
    readyRef.current = false;
    tConnectRef.current = performance.now();

    // Developer-mode timing: seconds since the tap for each connect step.
    const marks = {};
    const mark = (name) => {
      if (!(name in marks)) marks[name] = Math.round(performance.now() - tConnectRef.current);
    };
    // Turn-latency anchors: when the user's speech ended (falling edges), and the agent's last state.
    const eos = { first: null, last: null, edges: 0 };
    let prevAgentState = null;

    try {
      const botToken = await getTurnstileToken();
      mark('bot');
      const botHeader = botToken ? { 'X-Turnstile-Token': botToken } : {};
      const res = code
        ? await fetch(`${config.tokenUrl}/private`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...botHeader },
            body: JSON.stringify({ code }),
          })
        : await fetch(config.tokenUrl, { headers: botHeader });
      if (!res.ok) {
        const detail = await res.json().then((b) => b.detail).catch(() => '');
        const err = new Error(detail || `Token request failed (${res.status})`);
        err.status = res.status;
        throw err;
      }
      const { url, token } = await res.json();
      mark('ticket');

      const room = new Room({
        adaptiveStream: false,
        dynacast: false,
        audioCaptureDefaults: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      roomRef.current = room;

      room.on(RoomEvent.TrackSubscribed, (track) => {
        if (track.kind !== Track.Kind.Audio) return;
        const el = track.attach();
        el.style.display = 'none';
        document.body.appendChild(el);
        attachedRef.current.push(el);
        if (track.mediaStream) tapStream(track.mediaStream, 'output');
      });

      room.on(RoomEvent.TrackUnsubscribed, (track) => {
        track.detach().forEach((el) => el.remove());
      });

      room.on(RoomEvent.Disconnected, () => {
        if (roomRef.current !== room) return; // we initiated this one
        roomRef.current = null;
        teardown();
        setConnectionStatus('disconnected');
      });

      // The agent's state attribute drives "ready" and the speaking flag. The
      // agent takes several seconds to start (worker spin-up + Gemini connect),
      // so the UI stays on "Connecting" until it reports `listening`; otherwise
      // the user starts talking before anyone can hear them.
      const applyAgentState = (state) => {
        if (state === 'listening' && !readyRef.current) {
          readyRef.current = true;
          clearTimeout(readyTimerRef.current);
          setConnectionStatus('connected');
          if (recordMicRef.current) startRecording(room);
          const readyMs = Math.round(performance.now() - tConnectRef.current);
          mark('ready');
          if (devMetricsRef.current) {
            cbRef.current.onConnectMarks?.({ ...marks });
            console.info('[connect steps, ms since tap]', { ...marks });
            startStats(room);
          }
          cbRef.current.onReady?.(readyMs);
        }
        if (readyRef.current) cbRef.current.onModelSpeaking?.(state === 'speaking');

        // Perceived latency: the user's speech ended -> the agent's voice starts.
        if (readyRef.current && state === 'speaking' && prevAgentState !== 'speaking' && eos.last != null) {
          const now = performance.now();
          if (devMetricsRef.current) {
            cbRef.current.onMetrics?.({
              perceivedFirstMs: Math.round(now - eos.first),
              perceivedLastMs: Math.round(now - eos.last),
              eosEdges: eos.edges,
            });
          }
          eos.first = null;
          eos.last = null;
          eos.edges = 0;
        }
        if (state) prevAgentState = state;
      };

      room.on(RoomEvent.ParticipantAttributesChanged, (changed, participant) => {
        if (participant.isLocal) return;
        // The agent reports its own end-of-user-speech -> first-audio time per turn.
        if (REPLY_MS_ATTR in changed && devMetricsRef.current) {
          const ms = Number(changed[REPLY_MS_ATTR]);
          if (Number.isFinite(ms)) cbRef.current.onMetrics?.({ serverFirstAudioMs: ms });
        }
        if (AGENT_STATE_ATTR in changed) applyAgentState(changed[AGENT_STATE_ATTR]);
      });
      // The agent may already be listening when its join reaches us (no change event).
      room.on(RoomEvent.ParticipantConnected, (participant) => {
        mark('agent');
        applyAgentState(participant.attributes?.[AGENT_STATE_ATTR]);
      });

      room.localParticipant.on(ParticipantEvent.IsSpeakingChanged, (speaking) => {
        cbRef.current.onUserSpeaking?.(speaking);
        if (!speaking && readyRef.current) {
          const now = performance.now();
          eos.first ??= now;
          eos.last = now;
          eos.edges += 1;
        }
      });

      // Transcripts. Agent text arrives as a delta stream (chunk ≈ a word); user
      // text arrives as whole segments, so only the final one is recorded.
      room.registerTextStreamHandler(TRANSCRIPTION_TOPIC, async (reader, participantInfo) => {
        const isUser = participantInfo.identity === room.localParticipant.identity;
        if (isUser) {
          const text = await reader.readAll();
          if (reader.info.attributes?.[TRANSCRIPTION_FINAL_ATTR] === 'true' && text.trim()) {
            cbRef.current.onInputTranscript?.(`${text.trim()} `);
          }
          return;
        }
        for await (const chunk of reader) {
          cbRef.current.onOutputTranscript?.(chunk);
        }
      });

      await room.connect(url, token);
      mark('join');
      await room.localParticipant.setMicrophoneEnabled(true);
      const micTrack = room.localParticipant.getTrackPublication(Track.Source.Microphone)?.track;
      if (micTrack?.mediaStream) tapStream(micTrack.mediaStream, 'input');
      if (micTrack) enableKrisp(micTrack);

      room.remoteParticipants.forEach((p) => {
        mark('agent');
        applyAgentState(p.attributes?.[AGENT_STATE_ATTR]);
      });
      if (!readyRef.current) {
        readyTimerRef.current = setTimeout(() => {
          if (roomRef.current === room && !readyRef.current) {
            disconnect();
            cbRef.current.onError?.('Sparrow took too long to join. Try again.');
          }
        }, AGENT_JOIN_TIMEOUT_MS);
      }
    } catch (err) {
      disconnect();
      cbRef.current.onError?.(err.message || 'Could not connect');
      throw err;
    }
  }, [disconnect, teardown, tapStream, startRecording, startStats]);

  const toggleMute = useCallback(() => {
    const room = roomRef.current;
    if (!room) return;
    const next = !mutedRef.current;
    mutedRef.current = next;
    setIsMuted(next);
    room.localParticipant.setMicrophoneEnabled(!next);
  }, []);

  useEffect(() => () => {
    const room = roomRef.current;
    roomRef.current = null;
    if (room) {
      room.removeAllListeners();
      room.disconnect();
    }
    teardown();
  }, [teardown]);

  return { connectionStatus, isMuted, connect, disconnect, toggleMute, recordingUrl };
}
