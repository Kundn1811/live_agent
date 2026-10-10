import React from 'react';

export default function LeftPanel({
  connectionStatus,
  sessionActive,
  onStartSession,
  onStopSession,
  isMuted,
  onToggleMute,
  modelSpeaking,
  setupLatencyMs,
  perceivedFirstMs,
  perceivedLastMs,
  serverFirstAudioMs,
  deltaFirstMs,
  deltaLastMs,
  eosEdges,
  connectMs,
  rttMs,
}) {
  const fmtMs = (v) => (v != null ? `${v} ms` : '—');
  const fmtSigned = (v) => (v != null ? `${v > 0 ? '+' : ''}${v} ms` : '—');
  const fmtNum = (v) => (v != null ? `${v}` : '—');

  const statusLabel = {
    connected: 'Connected',
    connecting: 'Connecting...',
    disconnected: 'Disconnected',
  };

  const Row = ({ name, value }) => (
    <div className="latency-row">
      <span className="latency-name">{name}</span>
      <span className="latency-value">{value}</span>
    </div>
  );

  return (
    <div className="left-panel">
      <div className="panel-logo">
        <span className="logo-title">
          Developer<span className="dot">.</span>
        </span>
        <span className="logo-subtitle">live numbers</span>
      </div>

      <div className="connection-status">
        <span className={`status-dot ${connectionStatus}`} />
        <span>{statusLabel[connectionStatus]}</span>
      </div>

      {/* Session Controls */}
      <div className="control-group">
        <span className="control-label"><span className="index">01</span> Session</span>
        {!sessionActive ? (
          <button className="btn btn-start" onClick={onStartSession}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
              <polygon points="5,3 19,12 5,21" />
            </svg>
            Start talking
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

      {/* Agent status */}
      <div className="control-group">
        <span className="control-label"><span className="index">02</span> Agent</span>
        <div className={`indicator ${modelSpeaking ? 'active' : ''}`}>
          <span className={`indicator-dot ${modelSpeaking ? 'speaking' : ''}`} />
          <span>{modelSpeaking ? 'Speaking' : 'Idle'}</span>
        </div>
      </div>

      {/* Latency */}
      <div className="control-group">
        <span className="control-label"><span className="index">03</span> Latency</span>
        <div className="latency-metrics">
          <Row name="Setup handshake" value={fmtMs(setupLatencyMs)} />
          <Row name="First audio (Gemini)" value={fmtMs(serverFirstAudioMs)} />
          <Row name="Perceived (first EoS)" value={fmtMs(perceivedFirstMs)} />
          <Row name="Round-trip (RTT)" value={fmtMs(rttMs)} />
        </div>
        <details className="latency-more">
          <summary>+ experiment metrics</summary>
          <div className="latency-metrics">
            <Row name="Perceived (last EoS)" value={fmtMs(perceivedLastMs)} />
            <Row name="Δ first EoS" value={fmtSigned(deltaFirstMs)} />
            <Row name="Δ last EoS" value={fmtSigned(deltaLastMs)} />
            <Row name="EoS edges" value={fmtNum(eosEdges)} />
            <Row name="WS connect" value={fmtMs(connectMs)} />
          </div>
        </details>
      </div>

      <div className="fn-hint">
        Just speak naturally — Sparrow replies in your language. It's an AI wellness guide,
        not a doctor.
      </div>
    </div>
  );
}
