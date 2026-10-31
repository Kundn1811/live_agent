import React, { useState, useCallback, useEffect, useRef } from 'react';
import config from './config.js';
import useWebSocket from './hooks/useWebSocket.js';
import useAudioCapture from './hooks/useAudioCapture.js';
import useAudioPlayback from './hooks/useAudioPlayback.js';
import useLiveKitSession from './hooks/useLiveKitSession.js';
import LeftPanel from './components/LeftPanel.jsx';
import CenterPanel from './components/CenterPanel.jsx';
import InfoTag from './components/InfoTag.jsx';
import HistoryPanel from './components/HistoryPanel.jsx';
import ConfirmDialog from './components/ConfirmDialog.jsx';
import CodeGate from './components/CodeGate.jsx';
import useDevMode from './hooks/useDevMode.js';
import useSessionRecorder from './hooks/useSessionRecorder.js';
import { loadSessions } from './sessionStore.js';
import { prefetchTurnstileToken } from './turnstile.js';
import './App.css';

// Round to 1 decimal — perceived numbers are integers but the server number
// carries a decimal, so a raw subtraction yields float noise (e.g. -615.9000001).
const round1 = (v) => Math.round(v * 10) / 10;

// Private route: the access code lives only for this tab.
const CODE_KEY = 'sparrow_code';
const readStoredCode = () => {
  if (!config.isPrivate) return '';
  try {
    return sessionStorage.getItem(CODE_KEY) || '';
  } catch {
    return '';
  }
};
const storeCode = (code) => {
  try {
    if (code) sessionStorage.setItem(CODE_KEY, code);
    else sessionStorage.removeItem(CODE_KEY);
  } catch {
    // Storage blocked: the code just won't survive a reload.
  }
};

export default function App() {
  const [sessionActive, setSessionActive] = useState(false);
  const [accessCode, setAccessCode] = useState(readStoredCode);
  const [gateError, setGateError] = useState('');
  const codeRef = useRef(accessCode);
  // Developer mode shows the latency / debug panel. A hidden gesture on the wordmark turns it on and off.
  const [devMode, setDevMode] = useDevMode();
  const [devPrompt, setDevPrompt] = useState(null); // null | 'enter' | 'exit'

  // Transcripts are not shown; errors surface as a one-line notice under the orb.
  const [notice, setNotice] = useState('');
  // Bumped once per output-transcript chunk (~a word) so the orb can kick on each word.
  const wordPulseRef = useRef(0);
  // Saved conversations (last 10, browser only). `historySessions` is a snapshot taken when the panel opens.
  const [historySessions, setHistorySessions] = useState(null);
  const noticeTimerRef = useRef(null);
  const { begin: beginRecording, record, finish: finishRecording } = useSessionRecorder();

  const [userSpeaking, setUserSpeaking] = useState(false);
  const [modelSpeaking, setModelSpeaking] = useState(false);

  // Latency metrics. First-audio is measured once per session (first turn only):
  // client side here, server side reported by the backend.
  const [setupLatencyMs, setSetupLatencyMs] = useState(null);
  const [serverFirstAudioMs, setServerFirstAudioMs] = useState(null);
  // Step-1 experiment: two end-of-speech anchors, NOT a fix — a comparison.
  //  - perceivedFirst is anchored to the FIRST voiced->silent edge (robust to
  //    trailing noise, but fragile to mid-sentence pauses).
  //  - perceivedLast is anchored to the LAST voiced frame (today's behavior;
  //    robust to pauses, but trailing noise drags it forward and collapses it).
  const [perceivedFirstMs, setPerceivedFirstMs] = useState(null);
  const [perceivedLastMs, setPerceivedLastMs] = useState(null);
  const [eosEdges, setEosEdges] = useState(null);
  // Step-2 experiment: network legs, currently unmeasured (setup handshake is
  // server-side pool checkout, not the client<->backend hop).
  const [connectMs, setConnectMs] = useState(null);
  const [rttMs, setRttMs] = useState(null);

  // Running last voiced-frame timestamp (performance.now).
  const lastVoicedTsRef = useRef(null);
  // Anchored last voiced frame before the FIRST / LAST silence gap of the turn.
  const eosFirstRef = useRef(null);
  const eosLastRef = useRef(null);
  // Are we currently inside a voiced run? Gates edge detection so pre-speech
  // silence and repeated silent frames don't each count as an end-of-speech.
  const inSpeechRef = useRef(false);
  // Count of voiced->silent transitions this turn (tells first/last apart).
  const eosEdgeCountRef = useRef(0);
  // True only until we've timed the first audio byte of the session's first turn.
  const awaitingFirstAudioRef = useRef(false);
  // Holds the hook's metrics sender; the audio-output handler is defined before
  // the hook returns it, so it calls through this ref to avoid the cycle.
  const sendMetricsRef = useRef(null);
  // Refs mirror the metric state so the consolidated record (assembled inside
  // the audio-output handler) reads reliable values, not stale React state.
  const setupLatencyRef = useRef(null);
  const serverFirstAudioRef = useRef(null);
  const connectMsRef = useRef(null);
  const rttLastRef = useRef(null);
  const rttMinRef = useRef(null);

  const addSystemMessage = useCallback((text) => {
    setNotice(text);
  }, []);

  const { isPlaying, queueAudio, stopPlayback, cleanup: cleanupPlayback } = useAudioPlayback();

  const handleSetupComplete = useCallback((setupLatency) => {
    if (typeof setupLatency === 'number') {
      setSetupLatencyMs(setupLatency);
      setupLatencyRef.current = setupLatency;
    }
    awaitingFirstAudioRef.current = true;
    lastVoicedTsRef.current = null;
    eosFirstRef.current = null;
    eosLastRef.current = null;
    inSpeechRef.current = false;
    eosEdgeCountRef.current = 0;
    setNotice('');
  }, []);

  const handleServerFirstAudio = useCallback((latency) => {
    if (typeof latency === 'number') {
      setServerFirstAudioMs(latency);
      serverFirstAudioRef.current = latency;
    }
  }, []);

  const handleConnectLatency = useCallback((ms) => {
    setConnectMs(ms);
    connectMsRef.current = ms;
  }, []);

  const handleRtt = useCallback((rtt) => {
    setRttMs(rtt);
    rttLastRef.current = rtt;
    if (rttMinRef.current == null || rtt < rttMinRef.current) rttMinRef.current = rtt;
  }, []);

  const handleAudioOutput = useCallback((data) => {
    // First audio byte of the session's first turn: measure two perceived
    // latencies (first-EoS anchor vs last-EoS anchor) and ship a consolidated
    // metrics record to the backend. Captured once per session (never re-armed).
    if (awaitingFirstAudioRef.current) {
      const now = performance.now();
      const aFirst = eosFirstRef.current ?? lastVoicedTsRef.current;
      const aLast = eosLastRef.current ?? lastVoicedTsRef.current;
      const pFirst = aFirst != null ? Math.round(now - aFirst) : null;
      const pLast = aLast != null ? Math.round(now - aLast) : null;
      const edges = eosEdgeCountRef.current;
      if (pFirst != null) setPerceivedFirstMs(pFirst);
      if (pLast != null) setPerceivedLastMs(pLast);
      setEosEdges(edges);
      awaitingFirstAudioRef.current = false;

      const srv = serverFirstAudioRef.current;
      sendMetricsRef.current?.({
        setup_handshake_ms: setupLatencyRef.current,
        server_first_audio_ms: srv,
        perceived_first_ms: pFirst,
        perceived_last_ms: pLast,
        eos_edge_count: edges,
        connect_ms: connectMsRef.current,
        rtt_last_ms: rttLastRef.current,
        rtt_min_ms: rttMinRef.current,
        delta_first_ms: pFirst != null && srv != null ? round1(pFirst - srv) : null,
        delta_last_ms: pLast != null && srv != null ? round1(pLast - srv) : null,
      });
    }
    queueAudio(data);
    setModelSpeaking(true);
  }, [queueAudio]);

  // The user's transcript arrives once they've finished a phrase: that's the cue to stop "listening".
  const handleInputTranscript = useCallback((text) => {
    record('user', text);
    setUserSpeaking(false);
  }, [record]);

  const handleOutputTranscript = useCallback((text) => {
    record('model', text);
    wordPulseRef.current += 1;
  }, [record]);

  const handleTurnComplete = useCallback(() => {
    setModelSpeaking(false);
  }, []);

  const handleInterrupted = useCallback(() => {
    setModelSpeaking(false);
    stopPlayback();
  }, [stopPlayback]);

  const handleError = useCallback((message) => {
    addSystemMessage(`Error: ${message}`);
  }, [addSystemMessage]);

  const ws = useWebSocket({
    onSetupComplete: handleSetupComplete,
    onServerFirstAudio: handleServerFirstAudio,
    onConnectLatency: handleConnectLatency,
    onRtt: handleRtt,
    onAudioOutput: handleAudioOutput,
    onInputTranscript: handleInputTranscript,
    onOutputTranscript: handleOutputTranscript,
    onTurnComplete: handleTurnComplete,
    onInterrupted: handleInterrupted,
    onError: handleError,
  });
  // Keep the ref pointed at the current sender so handleAudioOutput can reach it.
  sendMetricsRef.current = ws.sendMetrics;

  // LiveKit transport. Both transports' hooks always run (hook order must stay
  // fixed) but only the selected one is driven; the other stays idle.
  const useLK = config.transport === 'livekit';
  const lk = useLiveKitSession({
    onReady: handleSetupComplete,
    onInputTranscript: handleInputTranscript,
    onOutputTranscript: handleOutputTranscript,
    onUserSpeaking: setUserSpeaking,
    onModelSpeaking: setModelSpeaking,
    onError: handleError,
  });
  // Solve the bot check while the user reads the page, so the first tap connects faster.
  // Private route waits for the access code first.
  useEffect(() => {
    if (useLK && !sessionActive && (!config.isPrivate || accessCode)) prefetchTurnstileToken();
  }, [useLK, accessCode, sessionActive]);
  const connectionStatus = useLK ? lk.connectionStatus : ws.connectionStatus;
  const disconnect = useLK ? lk.disconnect : ws.disconnect;

  const handleAudioChunk = useCallback((base64Data) => {
    ws.sendAudio(base64Data);
  }, [ws.sendAudio]);

  const handleSpeechActivity = useCallback((active) => {
    setUserSpeaking(active);
    if (active) {
      // Voiced frame: advance the running last-voiced timestamp and mark that a
      // voiced run is in progress (so the next silence counts as one EoS edge).
      lastVoicedTsRef.current = performance.now();
      inSpeechRef.current = true;
    } else if (inSpeechRef.current) {
      // First silent frame after a voiced run = one end-of-speech edge. Anchor
      // it to the last voiced frame (apples-to-apples with today's metric).
      inSpeechRef.current = false;
      eosEdgeCountRef.current += 1;
      const eosTs = lastVoicedTsRef.current;
      if (eosFirstRef.current == null) eosFirstRef.current = eosTs; // freeze first
      eosLastRef.current = eosTs; // most-recent EoS keeps advancing
    }
  }, []);

  const capture = useAudioCapture({
    onAudioChunk: handleAudioChunk,
    onSpeechActivity: handleSpeechActivity,
  });
  const { start: startCapture, stop: stopCapture } = capture;
  const isMuted = useLK ? lk.isMuted : capture.isMuted;
  const toggleMute = useLK ? lk.toggleMute : capture.toggleMute;

  const startSession = useCallback(async () => {
    try {
      setNotice('');
      setModelSpeaking(false);
      setUserSpeaking(false);
      setSetupLatencyMs(null);
      setPerceivedFirstMs(null);
      setPerceivedLastMs(null);
      setEosEdges(null);
      setServerFirstAudioMs(null);
      setConnectMs(null);
      setRttMs(null);
      lastVoicedTsRef.current = null;
      eosFirstRef.current = null;
      eosLastRef.current = null;
      inSpeechRef.current = false;
      eosEdgeCountRef.current = 0;
      awaitingFirstAudioRef.current = false;
      setupLatencyRef.current = null;
      serverFirstAudioRef.current = null;
      connectMsRef.current = null;
      rttLastRef.current = null;
      rttMinRef.current = null;
      beginRecording();
      if (useLK) {
        // WebRTC owns the mic; connect() asks for permission when it publishes.
        // Flip sessionActive right away so the orb shows "connecting".
        const connecting = lk.connect(config.isPrivate ? codeRef.current : undefined);
        setSessionActive(true);
        await connecting;
        return;
      }
      await startCapture();
      // Backend still expects a setup message with languages but ignores them.
      ws.connect(config.defaultSourceLanguage, config.defaultTargetLanguage);
      setSessionActive(true);
    } catch (err) {
      finishRecording();
      setSessionActive(false);
      if (config.isPrivate && (err?.status === 401 || err?.status === 429)) {
        // Bad code (or too many tries): back to the gate with the reason.
        codeRef.current = '';
        storeCode('');
        setAccessCode('');
        setGateError(err.message);
        return;
      }
      addSystemMessage(
        err?.name === 'NotAllowedError'
          ? 'Microphone is blocked. Allow mic access, then tap the orb again.'
          : `Couldn't start: ${err.message}`,
      );
    }
  }, [useLK, lk.connect, startCapture, ws.connect, addSystemMessage, beginRecording, finishRecording]);

  // Gate submit counts as the user's tap: start right away so the browser
  // allows the mic prompt, and a wrong code shows up immediately.
  const submitCode = useCallback((code) => {
    codeRef.current = code;
    storeCode(code);
    setGateError('');
    setAccessCode(code);
    startSession();
  }, [startSession]);

  const endSession = useCallback(() => {
    finishRecording();
    if (!useLK) stopCapture();
    stopPlayback();
    disconnect();
    setSessionActive(false);
    setModelSpeaking(false);
    setUserSpeaking(false);
  }, [useLK, finishRecording, stopCapture, stopPlayback, disconnect]);

  const handleStopSession = useCallback(() => {
    endSession();
  }, [endSession]);

  // Triple-tap on the info tag lands here: open the saved sessions, or say there are none.
  const openHistory = useCallback(() => {
    const list = loadSessions();
    if (list.length) {
      setHistorySessions(list);
      return;
    }
    setNotice("You don't have any sessions yet.");
    clearTimeout(noticeTimerRef.current);
    noticeTimerRef.current = setTimeout(() => setNotice(''), 3500);
  }, []);

  // The side panel used to show a dropped connection; now the orb just goes quiet,
  // so reset to the start state and say why.
  useEffect(() => {
    if (sessionActive && connectionStatus === 'disconnected') {
      endSession();
      setNotice(
        config.isPrivate
          ? 'Session ended. Tap the orb to talk again.'
          : 'Connection lost. Tap the orb to try again.',
      );
    }
  }, [sessionActive, connectionStatus, endSession]);

  useEffect(() => {
    return () => {
      cleanupPlayback();
    };
  }, [cleanupPlayback]);

  const effectiveModelSpeaking = modelSpeaking || isPlaying;

  // Δ (perceived − server) for each anchor. Positive is the expected shape
  // (≈ VAD silence wait + network); a negative Δ·last means trailing noise
  // dragged the last-EoS anchor past Gemini's commit (the bug we're studying).
  const deltaFirstMs =
    perceivedFirstMs != null && serverFirstAudioMs != null
      ? round1(perceivedFirstMs - serverFirstAudioMs)
      : null;
  const deltaLastMs =
    perceivedLastMs != null && serverFirstAudioMs != null
      ? round1(perceivedLastMs - serverFirstAudioMs)
      : null;

  if (config.isPrivate && !accessCode) {
    return <CodeGate error={gateError} onSubmit={submitCode} />;
  }

  return (
    <div className="app-layout">
      {devMode && (
        <LeftPanel
          connectionStatus={connectionStatus}
          sessionActive={sessionActive}
          onStartSession={startSession}
          onStopSession={handleStopSession}
          isMuted={isMuted}
          onToggleMute={toggleMute}
          modelSpeaking={effectiveModelSpeaking}
          setupLatencyMs={setupLatencyMs}
          perceivedFirstMs={perceivedFirstMs}
          perceivedLastMs={perceivedLastMs}
          serverFirstAudioMs={serverFirstAudioMs}
          deltaFirstMs={deltaFirstMs}
          deltaLastMs={deltaLastMs}
          eosEdges={eosEdges}
          connectMs={connectMs}
          rttMs={rttMs}
        />
      )}
      <CenterPanel
        sessionActive={sessionActive}
        connectionStatus={connectionStatus}
        userSpeaking={userSpeaking && !isMuted}
        modelSpeaking={effectiveModelSpeaking}
        muted={isMuted}
        pulseRef={wordPulseRef}
        notice={notice}
        onStart={startSession}
        onEnd={handleStopSession}
        onToggleMute={toggleMute}
        devMode={devMode}
        onSecret={() => setDevPrompt(devMode ? 'exit' : 'enter')}
      />
      <InfoTag onTripleTap={openHistory} />
      {devPrompt && (
        <ConfirmDialog
          title={devPrompt === 'enter' ? 'Switch to developer mode?' : 'Leave developer mode?'}
          text={
            devPrompt === 'enter'
              ? 'Shows the live latency and connection numbers. It turns off when you close this tab.'
              : 'Hides the latency and connection numbers.'
          }
          confirmLabel={devPrompt === 'enter' ? 'Yes, switch' : 'Yes, leave'}
          cancelLabel={devPrompt === 'enter' ? 'Not now' : 'Stay'}
          onConfirm={() => {
            setDevMode(devPrompt === 'enter');
            setDevPrompt(null);
          }}
          onCancel={() => setDevPrompt(null)}
        />
      )}
      {historySessions && (
        <HistoryPanel
          sessions={historySessions}
          onClose={() => setHistorySessions(null)}
          onCleared={() => {
            setHistorySessions(null);
            setNotice('Sessions cleared.');
            clearTimeout(noticeTimerRef.current);
            noticeTimerRef.current = setTimeout(() => setNotice(''), 3500);
          }}
        />
      )}
    </div>
  );
}
