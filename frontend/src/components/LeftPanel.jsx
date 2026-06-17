import React from 'react';
import config from '../config.js';

export default function LeftPanel({
  connectionStatus,
  sessionActive,
  sourceLanguage,
  setSourceLanguage,
  targetLanguage,
  setTargetLanguage,
  onStartSession,
  onStopSession,
  isMuted,
  onToggleMute,
  modelSpeaking,
  setupLatencyMs,
  clientFirstAudioMs,
  serverFirstAudioMs,
  networkDeltaMs,
}) {
  const fmtMs = (v) => (v != null ? `${v} ms` : '—');
  const statusColor = {
    connected: 'var(--accent-green)',
    connecting: 'var(--accent-yellow)',
    disconnected: 'var(--accent-red)',
  };

  const statusLabel = {
    connected: 'Connected',
    connecting: 'Connecting...',
    disconnected: 'Disconnected',
  };

  const handleSwapLanguages = () => {
    if (sessionActive) return;
    const temp = sourceLanguage;
    setSourceLanguage(targetLanguage);
    setTargetLanguage(temp);
  };

  return (
    <div className="left-panel">
      <div className="panel-logo">
        <div className="logo-icon">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--accent-green)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M5 8l6 6"/>
            <path d="M4 14l6-6 2-3"/>
            <path d="M2 5h12"/>
            <path d="M7 2h1"/>
            <path d="M22 22l-5-10-5 10"/>
            <path d="M14 18h6"/>
          </svg>
        </div>
        <div className="logo-text">
          <span className="logo-title">Gemini Live</span>
          <span className="logo-subtitle">Translator</span>
        </div>
      </div>

      <div className="connection-status">
        <span
          className="status-dot"
          style={{ background: statusColor[connectionStatus] }}
        />
        <span className="status-label">{statusLabel[connectionStatus]}</span>
      </div>

      <div className="panel-divider" />

      {/* Language Selection */}
      <div className="control-group">
        <label className="control-label">Source Language</label>
        <select
          className="control-select"
          value={sourceLanguage}
          onChange={(e) => setSourceLanguage(e.target.value)}
          disabled={sessionActive}
        >
          {config.supportedLanguages.map((lang) => (
            <option key={lang} value={lang}>{lang}</option>
          ))}
        </select>
      </div>

      <button
        className="btn btn-swap"
        onClick={handleSwapLanguages}
        disabled={sessionActive}
        title="Swap languages"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="7 16 3 12 7 8"/>
          <line x1="3" y1="12" x2="21" y2="12"/>
          <polyline points="17 8 21 12 17 16"/>
        </svg>
        Swap
      </button>

      <div className="control-group">
        <label className="control-label">Target Language</label>
        <select
          className="control-select"
          value={targetLanguage}
          onChange={(e) => setTargetLanguage(e.target.value)}
          disabled={sessionActive}
        >
          {config.supportedLanguages.map((lang) => (
            <option key={lang} value={lang}>{lang}</option>
          ))}
        </select>
      </div>

      <div className="panel-divider" />

      {/* Session Controls */}
      <div className="session-controls">
        {!sessionActive ? (
          <button className="btn btn-start" onClick={onStartSession}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
              <polygon points="5,3 19,12 5,21" />
            </svg>
            Start Translating
          </button>
        ) : (
          <div className="session-active-controls">
            <button className="btn btn-stop" onClick={onStopSession}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                <rect x="4" y="4" width="16" height="16" rx="2" />
              </svg>
              Stop
            </button>
            <button
              className={`btn btn-mute ${isMuted ? 'muted' : ''}`}
              onClick={onToggleMute}
            >
              {isMuted ? (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="1" y1="1" x2="23" y2="23"/>
                  <path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"/>
                  <path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2c0 .76-.13 1.48-.35 2.17"/>
                  <line x1="12" y1="19" x2="12" y2="23"/>
                  <line x1="8" y1="23" x2="16" y2="23"/>
                </svg>
              ) : (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
                  <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
                  <line x1="12" y1="19" x2="12" y2="23"/>
                  <line x1="8" y1="23" x2="16" y2="23"/>
                </svg>
              )}
              {isMuted ? 'Unmute' : 'Mute'}
            </button>
          </div>
        )}
      </div>

      <div className="panel-divider" />

      {/* Session Status */}
      <div className="status-indicators">
        <label className="control-label">Status</label>
        <div className={`indicator ${modelSpeaking ? 'active' : ''}`}>
          <span className={`indicator-dot ${modelSpeaking ? 'speaking' : ''}`} />
          <span>Translating</span>
          {modelSpeaking && <span className="indicator-badge active-badge">Active</span>}
        </div>
      </div>

      <div className="panel-divider" />

      {/* Latency Metrics */}
      <div className="latency-metrics">
        <label className="control-label">Latency</label>
        <div className="latency-row">
          <span className="latency-name">Setup handshake</span>
          <span className="latency-value">{fmtMs(setupLatencyMs)}</span>
        </div>
        <div className="latency-row">
          <span className="latency-name">First audio · perceived (client)</span>
          <span className="latency-value">{fmtMs(clientFirstAudioMs)}</span>
        </div>
        <div className="latency-row">
          <span className="latency-name">First audio · Gemini (server)</span>
          <span className="latency-value">{fmtMs(serverFirstAudioMs)}</span>
        </div>
        <div className="latency-row">
          <span className="latency-name">Δ (VAD + network)</span>
          <span className="latency-value">{fmtMs(networkDeltaMs)}</span>
        </div>
      </div>

      {/* Hint */}
      <div className="fn-hint">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--accent-blue)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10"/>
          <line x1="12" y1="16" x2="12" y2="12"/>
          <line x1="12" y1="8" x2="12.01" y2="8"/>
        </svg>
        <div className="fn-hint-content">
          <span>Speak in {sourceLanguage} and hear the translation in {targetLanguage}. Only translation is supported — other queries will be declined.</span>
        </div>
      </div>
    </div>
  );
}
