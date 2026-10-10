import React from 'react';
import VoiceOrb from './scene/VoiceOrb.jsx';
import SecretWordmark from './SecretWordmark.jsx';

function stateLabel({ connectionStatus, userSpeaking, modelSpeaking }) {
  if (connectionStatus === 'connecting') return 'Connecting';
  if (modelSpeaking) return 'Speaking';
  if (userSpeaking) return 'Listening';
  return 'Ready';
}

const iconProps = {
  width: 18,
  height: 18,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
};

export default function CenterPanel({
  sessionActive,
  connectionStatus,
  userSpeaking,
  modelSpeaking,
  muted,
  pulseRef,
  notice,
  onStart,
  onEnd,
  onToggleMute,
  devMode,
  onSecret,
}) {
  const label = stateLabel({ connectionStatus, userSpeaking, modelSpeaking });

  return (
    <div className="center-panel">
      <div className="stage-canvas">
        <VoiceOrb
          sessionActive={sessionActive}
          userSpeaking={userSpeaking}
          modelSpeaking={modelSpeaking}
          muted={muted}
          pulseRef={pulseRef}
          interactive={!sessionActive}
          onCoreTap={onStart}
        />
      </div>

      <SecretWordmark reverse={!devMode} onSequence={onSecret} />
      {devMode && <span className="dev-badge">DEV</span>}

      {/* The orb itself is a canvas mesh, so give keyboard / screen-reader users a real button. */}
      {!sessionActive && (
        <button className="sr-only" onClick={onStart}>
          Start conversation
        </button>
      )}

      <div className="stage-overlay">
        {!sessionActive && (
          <div className="empty-state">
            <h2 className="empty-title">
              Talk to <span className="text-gradient">Sparrow.</span>
            </h2>
            <p className="empty-subtext">Tap the orb to begin. Allow the mic when asked.</p>
          </div>
        )}

        <div className="stage-caption">
          {notice && <span className="stage-notice">{notice}</span>}

          {sessionActive && (
            <>
              <span className={`stage-state ${label.toLowerCase()}`}>
                <span className="stage-state-dot" />
                {label}
              </span>

              <div className="stage-controls">
                <button
                  className={`btn-icon ${muted ? 'muted' : ''}`}
                  onClick={onToggleMute}
                  aria-label={muted ? 'Unmute microphone' : 'Mute microphone'}
                  title={muted ? 'Unmute' : 'Mute'}
                >
                  {muted ? (
                    <svg {...iconProps}>
                      <line x1="1" y1="1" x2="23" y2="23" />
                      <path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6" />
                      <path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2c0 .76-.13 1.48-.35 2.17" />
                      <line x1="12" y1="19" x2="12" y2="23" />
                    </svg>
                  ) : (
                    <svg {...iconProps}>
                      <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
                      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                      <line x1="12" y1="19" x2="12" y2="23" />
                    </svg>
                  )}
                </button>
                <button
                  className="btn-icon end"
                  onClick={onEnd}
                  aria-label="End conversation"
                  title="End"
                >
                  <svg {...iconProps}>
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
