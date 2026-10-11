import { useState, useRef, useCallback, useEffect } from 'react';
import { Room, RoomEvent, ParticipantEvent, Track } from 'livekit-client';
import config from '../config.js';
import { analysers, createAnalyser } from '../audioLevels.js';

// Agent state attribute published by the LiveKit agent on its participant.
const AGENT_STATE_ATTR = 'lk.agent.state';
const TRANSCRIPTION_TOPIC = 'lk.transcription';
const TRANSCRIPTION_FINAL_ATTR = 'lk.transcription_final';
// Give up if the agent hasn't started listening by then (cold worker can take ~15s).
const AGENT_JOIN_TIMEOUT_MS = 40000;

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
}) {
  const [connectionStatus, setConnectionStatus] = useState('disconnected');
  const [isMuted, setIsMuted] = useState(false);
  const roomRef = useRef(null);
  const audioCtxRef = useRef(null);
  const attachedRef = useRef([]); // <audio> elements we created for remote tracks
  const readyRef = useRef(false);
  const mutedRef = useRef(false);
  const readyTimerRef = useRef(null);
  const tConnectRef = useRef(0);

  // Latest callbacks, so the room handlers (bound once per connect) never go stale.
  const cbRef = useRef({});
  cbRef.current = {
    onReady, onInputTranscript, onOutputTranscript, onUserSpeaking, onModelSpeaking, onError,
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

  const teardown = useCallback(() => {
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

    try {
      const res = code
        ? await fetch(`${config.tokenUrl}/private`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code }),
          })
        : await fetch(config.tokenUrl);
      if (!res.ok) {
        const detail = await res.json().then((b) => b.detail).catch(() => '');
        const err = new Error(detail || `Token request failed (${res.status})`);
        err.status = res.status;
        throw err;
      }
      const { url, token } = await res.json();

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
          cbRef.current.onReady?.(Math.round(performance.now() - tConnectRef.current));
        }
        if (readyRef.current) cbRef.current.onModelSpeaking?.(state === 'speaking');
      };

      room.on(RoomEvent.ParticipantAttributesChanged, (changed, participant) => {
        if (participant.isLocal || !(AGENT_STATE_ATTR in changed)) return;
        applyAgentState(changed[AGENT_STATE_ATTR]);
      });
      // The agent may already be listening when its join reaches us (no change event).
      room.on(RoomEvent.ParticipantConnected, (participant) => {
        applyAgentState(participant.attributes?.[AGENT_STATE_ATTR]);
      });

      room.localParticipant.on(ParticipantEvent.IsSpeakingChanged, (speaking) => {
        cbRef.current.onUserSpeaking?.(speaking);
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
      await room.localParticipant.setMicrophoneEnabled(true);
      const micTrack = room.localParticipant.getTrackPublication(Track.Source.Microphone)?.track;
      if (micTrack?.mediaStream) tapStream(micTrack.mediaStream, 'input');

      room.remoteParticipants.forEach((p) => applyAgentState(p.attributes?.[AGENT_STATE_ATTR]));
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
  }, [disconnect, teardown, tapStream]);

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

  return { connectionStatus, isMuted, connect, disconnect, toggleMute };
}
