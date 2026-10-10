import React, { useCallback, useEffect, useRef, useState } from 'react';
import './InfoTag.css';

const SEEN_KEY = 'sparrow:info-seen';
const NUDGE_DELAY_MS = 1200;
const NUDGE_DURATION_MS = 9000;
const TAP_GAP_MS = 600;

function readSeen() {
  try {
    return localStorage.getItem(SEEN_KEY) === '1';
  } catch {
    return false;
  }
}

function markSeen() {
  try {
    localStorage.setItem(SEEN_KEY, '1');
  } catch {
    // Private mode etc. — the nudge just shows again next visit.
  }
}

/**
 * Corner "i" tag: tap for a short note on what this is. First-time visitors also get a small
 * poking arrow for a few seconds. It stops when they tap the tag or when it times out, and
 * either way it's marked seen so it never comes back.
 */
export default function InfoTag({ onTripleTap }) {
  const [open, setOpen] = useState(false);
  const [nudge, setNudge] = useState(false);
  const rootRef = useRef(null);
  // Timestamps of the current run of quick taps (each within TAP_GAP_MS of the last).
  const tapsRef = useRef([]);

  useEffect(() => {
    if (readSeen()) return undefined;
    const show = setTimeout(() => setNudge(true), NUDGE_DELAY_MS);
    const hide = setTimeout(() => {
      setNudge(false);
      markSeen();
    }, NUDGE_DELAY_MS + NUDGE_DURATION_MS);
    return () => {
      clearTimeout(show);
      clearTimeout(hide);
    };
  }, []);

  const toggle = useCallback(() => {
    setNudge(false);
    markSeen();

    // Three quick taps in a row = open the saved sessions instead of toggling the card.
    const now = performance.now();
    const taps = tapsRef.current;
    tapsRef.current = taps.length && now - taps[taps.length - 1] <= TAP_GAP_MS ? [...taps, now] : [now];
    if (tapsRef.current.length >= 3) {
      tapsRef.current = [];
      setOpen(false);
      onTripleTap?.();
      return;
    }
    setOpen((o) => !o);
  }, [onTripleTap]);

  // Close on outside press or Escape.
  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="info-root" ref={rootRef}>
      <button
        className={`info-tag ${nudge ? 'nudge' : ''} ${open ? 'open' : ''}`}
        onClick={toggle}
        aria-label="About Sparrow"
        aria-expanded={open}
        aria-controls="info-card"
      >
        {/* Drawn rather than typeset: the display font's "i" is too thin to read as bold. */}
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <circle cx="12" cy="5.5" r="2.4" fill="currentColor" />
          <path d="M12 10.5V19" stroke="currentColor" strokeWidth="4" strokeLinecap="round" />
        </svg>
      </button>

      {nudge && !open && (
        <div className="info-nudge" aria-hidden="true">
          <svg className="info-arrow" width="22" height="26" viewBox="0 0 22 26" fill="none">
            <path
              d="M11 24V3M3 11l8-8 8 8"
              stroke="currentColor"
              strokeWidth="2.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          <span className="info-nudge-label">What is this?</span>
        </div>
      )}

      {open && (
        <div id="info-card" className="info-card" role="dialog" aria-label="About Sparrow">
          <h2 className="info-title">
            About Sparrow<span className="dot">.</span>
          </h2>
          <p className="info-text">
            Sparrow is a live voice agent: a health &amp; wellness guide you can talk to. It
            listens, answers out loud in real time, and replies in your language.
          </p>

          <ol className="info-steps">
            <li>Tap the orb to start.</li>
            <li>Allow the microphone when asked.</li>
            <li>Just speak. Cut in any time.</li>
          </ol>

          <div className="info-tags">
            <span>Gemini Live</span>
            <span>React Three Fiber</span>
            <span>FastAPI</span>
          </div>

          <p className="info-history">
            Your last 10 conversations are saved in this browser only. To read them, tap the{' '}
            <b>i</b> three times, quickly.
          </p>

          <p className="info-note">Sparrow is an AI, not a doctor. Not for emergencies.</p>
        </div>
      )}
    </div>
  );
}
