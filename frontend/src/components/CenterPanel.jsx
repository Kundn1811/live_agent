import React from 'react';
import VoiceOrb from './scene/VoiceOrb.jsx';

function stateLabel({ sessionActive, connectionStatus, userSpeaking, modelSpeaking }) {
  if (!sessionActive) return 'Offline';
  if (connectionStatus === 'connecting') return 'Connecting';
  if (modelSpeaking) return 'Speaking';
  if (userSpeaking) return 'Listening';
  return 'Ready';
}

export default function CenterPanel({
  sessionActive,
  connectionStatus,
  userSpeaking,
  modelSpeaking,
  muted,
  pulseRef,
  notice,
}) {
  const label = stateLabel({ sessionActive, connectionStatus, userSpeaking, modelSpeaking });

  return (
    <div className="center-panel">
      <div className="center-header">
        <span className="center-title">Sparrow</span>
        <span className="message-count">{label.toLowerCase()}</span>
      </div>

      <div className="stage">
        <div className="stage-canvas">
          <VoiceOrb
            sessionActive={sessionActive}
            userSpeaking={userSpeaking}
            modelSpeaking={modelSpeaking}
            muted={muted}
            pulseRef={pulseRef}
          />
        </div>

        <div className="stage-overlay">
          {!sessionActive && (
            <div className="empty-state">
              <h2 className="empty-title">
                Talk to <span className="text-gradient">Sparrow.</span>
              </h2>
              <p className="empty-subtext">
                Press “Start talking”, allow the mic, and ask about health or wellness.
              </p>
            </div>
          )}

          <div className="stage-caption">
            {notice && <span className="stage-notice">{notice}</span>}
            {sessionActive && (
              <span className={`stage-state ${label.toLowerCase()}`}>
                <span className="stage-state-dot" />
                {label}
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
