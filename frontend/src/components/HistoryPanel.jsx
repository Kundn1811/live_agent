import React, { useEffect, useRef, useState } from 'react';
import { clearSessions, MAX_SESSIONS } from '../sessionStore.js';
import './HistoryPanel.css';

function fmtWhen(ts) {
  return new Date(ts).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function fmtDuration(session) {
  const s = Math.max(1, Math.round(((session.endedAt ?? session.startedAt) - session.startedAt) / 1000));
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
}

// Title = the first thing the user said (falls back to Sparrow's opening line).
function titleOf(session) {
  const first = session.turns.find((t) => t.role === 'user') ?? session.turns[0];
  return first?.text ?? 'Conversation';
}

export default function HistoryPanel({ sessions, onClose, onCleared }) {
  const [openId, setOpenId] = useState(null);
  const [confirming, setConfirming] = useState(false);
  const closeRef = useRef(null);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // "Clear all" asks twice: first press arms it, second one deletes. Disarms itself after 3s.
  useEffect(() => {
    if (!confirming) return undefined;
    const t = setTimeout(() => setConfirming(false), 3000);
    return () => clearTimeout(t);
  }, [confirming]);

  const handleClear = () => {
    if (!confirming) {
      setConfirming(true);
      return;
    }
    clearSessions();
    onCleared();
  };

  return (
    <>
      <div className="history-scrim" onClick={onClose} />
      <aside className="history-panel" role="dialog" aria-label="Past sessions">
        <header className="history-head">
          <div>
            <h2 className="history-title">
              Sessions<span className="dot">.</span>
            </h2>
            <p className="history-sub">
              Last {MAX_SESSIONS} · saved only in this browser
            </p>
          </div>
          <button ref={closeRef} className="history-close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>

        <ul className="history-list">
          {sessions.map((s) => {
            const open = openId === s.id;
            return (
              <li key={s.id} className={`history-item ${open ? 'open' : ''}`}>
                <button
                  className="history-item-head"
                  onClick={() => setOpenId(open ? null : s.id)}
                  aria-expanded={open}
                >
                  <span className="history-item-title">{titleOf(s)}</span>
                  <span className="history-item-meta">
                    {fmtWhen(s.startedAt)} · {fmtDuration(s)} · {s.turns.length} turns
                  </span>
                </button>

                {open && (
                  <div className="history-transcript">
                    {s.turns.map((t, i) => (
                      <div key={i} className={`history-turn ${t.role}`}>
                        <span className="history-who">{t.role === 'user' ? 'You' : 'Sparrow'}</span>
                        <p>{t.text}</p>
                      </div>
                    ))}
                  </div>
                )}
              </li>
            );
          })}
        </ul>

        <footer className="history-foot">
          <button className={`history-clear ${confirming ? 'armed' : ''}`} onClick={handleClear}>
            {confirming ? 'Tap again to delete all' : 'Clear all'}
          </button>
        </footer>
      </aside>
    </>
  );
}
