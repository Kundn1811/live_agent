import React, { useState, useCallback, useEffect, useRef } from 'react';
import config from './config.js';
import useWebSocket from './hooks/useWebSocket.js';
import useAudioCapture from './hooks/useAudioCapture.js';
import useAudioPlayback from './hooks/useAudioPlayback.js';
import LeftPanel from './components/LeftPanel.jsx';
import CenterPanel from './components/CenterPanel.jsx';
import './App.css';

export default function App() {
  const [sessionActive, setSessionActive] = useState(false);
  const [sourceLanguage, setSourceLanguage] = useState(config.defaultSourceLanguage);
  const [targetLanguage, setTargetLanguage] = useState(config.defaultTargetLanguage);

  const [messages, setMessages] = useState([]);

  const [userSpeaking, setUserSpeaking] = useState(false);
  const [modelSpeaking, setModelSpeaking] = useState(false);

  // Latency metrics. First-audio is measured once per session (first turn only):
  // client side here, server side reported by the backend. The gap between them
  // approximates the client<->server network overhead.
  const [setupLatencyMs, setSetupLatencyMs] = useState(null);
  const [firstAudioLatencyMs, setFirstAudioLatencyMs] = useState(null);
  const [serverFirstAudioMs, setServerFirstAudioMs] = useState(null);
  // Timestamp (performance.now) of the last voiced mic frame — our end-of-speech proxy.
  const lastVoicedTsRef = useRef(null);
  // True only until we've timed the first audio byte of the session's first turn.
  const awaitingFirstAudioRef = useRef(false);

  const addSystemMessage = useCallback((text) => {
    setMessages((prev) => [...prev, { role: 'system', text, timestamp: new Date() }]);
  }, []);

  const { isPlaying, queueAudio, stopPlayback, cleanup: cleanupPlayback } = useAudioPlayback();

  const handleSetupComplete = useCallback((setupLatency) => {
    if (typeof setupLatency === 'number') setSetupLatencyMs(setupLatency);
    awaitingFirstAudioRef.current = true;
    lastVoicedTsRef.current = null;
    addSystemMessage(`Translating: ${sourceLanguage} → ${targetLanguage}. Start speaking.`);
  }, [addSystemMessage, sourceLanguage, targetLanguage]);

  const handleServerFirstAudio = useCallback((latency) => {
    if (typeof latency === 'number') setServerFirstAudioMs(latency);
  }, []);

  const handleAudioOutput = useCallback((data) => {
    // First audio byte of the session's first turn: measure from the user's last
    // voiced frame (end-of-speech proxy) to this first chunk of translated audio.
    // We never re-arm, so this is captured once per session.
    if (awaitingFirstAudioRef.current && lastVoicedTsRef.current != null) {
      const latency = Math.round(performance.now() - lastVoicedTsRef.current);
      setFirstAudioLatencyMs(latency);
      awaitingFirstAudioRef.current = false;
    }
    queueAudio(data);
    setModelSpeaking(true);
  }, [queueAudio]);

  const handleInputTranscript = useCallback((text) => {
    setMessages((prev) => [...prev, { role: 'user', text, timestamp: new Date() }]);
    setUserSpeaking(false);
  }, []);

  const handleOutputTranscript = useCallback((text) => {
    setMessages((prev) => {
      const last = prev[prev.length - 1];
      if (last && last.role === 'model' && last._partial) {
        const updated = [...prev];
        updated[updated.length - 1] = { ...last, text: last.text + text };
        return updated;
      }
      return [...prev, { role: 'model', text, timestamp: new Date(), _partial: true }];
    });
  }, []);

  const handleTurnComplete = useCallback(() => {
    setModelSpeaking(false);
    setMessages((prev) => prev.map((m) => (m._partial ? { ...m, _partial: false } : m)));
  }, []);

  const handleInterrupted = useCallback(() => {
    setModelSpeaking(false);
    stopPlayback();
    setMessages((prev) => prev.map((m) => (m._partial ? { ...m, _partial: false } : m)));
  }, [stopPlayback]);

  const handleError = useCallback((message) => {
    addSystemMessage(`Error: ${message}`);
  }, [addSystemMessage]);

  const { connectionStatus, connect, disconnect, sendAudio } = useWebSocket({
    onSetupComplete: handleSetupComplete,
    onServerFirstAudio: handleServerFirstAudio,
    onAudioOutput: handleAudioOutput,
    onInputTranscript: handleInputTranscript,
    onOutputTranscript: handleOutputTranscript,
    onTurnComplete: handleTurnComplete,
    onInterrupted: handleInterrupted,
    onError: handleError,
  });

  const handleAudioChunk = useCallback((base64Data) => {
    sendAudio(base64Data);
  }, [sendAudio]);

  const handleSpeechActivity = useCallback((active) => {
    setUserSpeaking(active);
    // Every voiced frame advances the end-of-speech proxy; once speech stops,
    // this holds the timestamp of the user's final voiced frame.
    if (active) lastVoicedTsRef.current = performance.now();
  }, []);

  const { isMuted, start: startCapture, stop: stopCapture, toggleMute } = useAudioCapture({
    onAudioChunk: handleAudioChunk,
    onSpeechActivity: handleSpeechActivity,
  });

  const startSession = useCallback(async () => {
    try {
      setMessages([]);
      setModelSpeaking(false);
      setUserSpeaking(false);
      setSetupLatencyMs(null);
      setFirstAudioLatencyMs(null);
      setServerFirstAudioMs(null);
      lastVoicedTsRef.current = null;
      awaitingFirstAudioRef.current = false;
      await startCapture();
      connect(sourceLanguage, targetLanguage);
      setSessionActive(true);
    } catch (err) {
      addSystemMessage(`Failed to start session: ${err.message}`);
    }
  }, [startCapture, connect, sourceLanguage, targetLanguage, addSystemMessage]);

  const endSession = useCallback(() => {
    stopCapture();
    stopPlayback();
    disconnect();
    setSessionActive(false);
    setModelSpeaking(false);
    setUserSpeaking(false);
  }, [stopCapture, stopPlayback, disconnect]);

  const handleStopSession = useCallback(() => {
    addSystemMessage('Session ended.');
    endSession();
  }, [addSystemMessage, endSession]);

  useEffect(() => {
    return () => {
      cleanupPlayback();
    };
  }, [cleanupPlayback]);

  const effectiveModelSpeaking = modelSpeaking || isPlaying;

  // Perceived (client) is anchored to the user's real end-of-speech; Gemini
  // (server) is anchored post-VAD-commit. So this gap ≈ the 800ms VAD silence
  // wait + the client<->server network legs — not pure network.
  const networkDeltaMs =
    firstAudioLatencyMs != null && serverFirstAudioMs != null
      ? firstAudioLatencyMs - serverFirstAudioMs
      : null;

  return (
    <div className="app-layout">
      <LeftPanel
        connectionStatus={connectionStatus}
        sessionActive={sessionActive}
        sourceLanguage={sourceLanguage}
        setSourceLanguage={setSourceLanguage}
        targetLanguage={targetLanguage}
        setTargetLanguage={setTargetLanguage}
        onStartSession={startSession}
        onStopSession={handleStopSession}
        isMuted={isMuted}
        onToggleMute={toggleMute}
        modelSpeaking={effectiveModelSpeaking}
        setupLatencyMs={setupLatencyMs}
        clientFirstAudioMs={firstAudioLatencyMs}
        serverFirstAudioMs={serverFirstAudioMs}
        networkDeltaMs={networkDeltaMs}
      />
      <CenterPanel
        messages={messages}
        userSpeaking={userSpeaking && !isMuted}
        modelSpeaking={effectiveModelSpeaking}
        sourceLanguage={sourceLanguage}
        targetLanguage={targetLanguage}
      />
    </div>
  );
}
