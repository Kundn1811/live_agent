import React, { useEffect, useRef } from 'react';

function formatTime(date) {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function WaveformIndicator({ label }) {
  return (
    <div className="waveform-indicator">
      <div className="waveform-bars">
        {[0, 1, 2, 3, 4].map((i) => (
          <span
            key={i}
            className="waveform-bar"
            style={{ animationDelay: `${i * 0.12}s` }}
          />
        ))}
      </div>
      <span className="waveform-label">{label}</span>
    </div>
  );
}

export default function CenterPanel({
  messages,
  userSpeaking,
  modelSpeaking,
  sourceLanguage,
  targetLanguage,
}) {
  const scrollRef = useRef(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, userSpeaking, modelSpeaking]);

  return (
    <div className="center-panel">
      <div className="center-header">
        <span className="center-title">{sourceLanguage} → {targetLanguage}</span>
        <span className="message-count">{messages.length} messages</span>
      </div>

      <div className="messages-container" ref={scrollRef}>
        {messages.length === 0 && !userSpeaking && !modelSpeaking && (
          <div className="empty-state">
            <div className="empty-icon">
              <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M5 8l6 6"/>
                <path d="M4 14l6-6 2-3"/>
                <path d="M2 5h12"/>
                <path d="M7 2h1"/>
                <path d="M22 22l-5-10-5 10"/>
                <path d="M14 18h6"/>
              </svg>
            </div>
            <p className="empty-text">Start a session to begin translating</p>
            <p className="empty-subtext">Speak in {sourceLanguage} to hear translations in {targetLanguage}</p>
          </div>
        )}

        {messages.map((msg, index) => {
          if (msg.role === 'system') {
            return (
              <div key={index} className="message-system" style={{ animationDelay: `${Math.min(index * 0.05, 0.3)}s` }}>
                <span>{msg.text}</span>
              </div>
            );
          }

          const isUser = msg.role === 'user';
          return (
            <div
              key={index}
              className={`message-row ${isUser ? 'user' : 'model'}`}
              style={{ animationDelay: `${Math.min(index * 0.05, 0.3)}s` }}
            >
              <div className={`message-bubble ${isUser ? 'user-bubble' : 'model-bubble'}`}>
                <div className="message-label">{isUser ? sourceLanguage : targetLanguage}</div>
                <div className="message-text">{msg.text}</div>
                <div className="message-time">{formatTime(msg.timestamp)}</div>
              </div>
            </div>
          );
        })}

        {userSpeaking && (
          <div className="message-row user">
            <div className="message-bubble user-bubble live-bubble">
              <WaveformIndicator label="Listening..." />
            </div>
          </div>
        )}

        {modelSpeaking && (
          <div className="message-row model">
            <div className="message-bubble model-bubble live-bubble">
              <WaveformIndicator label="Translating..." />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
