import React, { useRef } from 'react';

const WORD = 'Sparrow';
// Longest allowed pause between two clicks before the sequence starts over.
const MAX_GAP_MS = 4000;

/**
 * The "Sparrow." wordmark. Each letter is secretly clickable: clicking them one by one in the
 * right order calls `onSequence`. Entering developer mode = last letter to first; leaving it =
 * first letter to last. There is deliberately no feedback (no cursor change, no highlight) while
 * clicking, and a wrong letter or a long pause starts over.
 */
export default function SecretWordmark({ reverse, onSequence }) {
  const progressRef = useRef(0);
  const lastClickRef = useRef(0);

  const order = WORD.split('').map((_, i) => (reverse ? WORD.length - 1 - i : i));

  const handleClick = (index) => {
    const now = performance.now();
    if (now - lastClickRef.current > MAX_GAP_MS) progressRef.current = 0;
    lastClickRef.current = now;

    if (index === order[progressRef.current]) {
      progressRef.current += 1;
    } else {
      // Wrong letter: start over, but let this click count if it is a valid first letter.
      progressRef.current = index === order[0] ? 1 : 0;
    }

    if (progressRef.current === order.length) {
      progressRef.current = 0;
      onSequence();
    }
  };

  return (
    <div className="brand" aria-label="Sparrow" role="img">
      {WORD.split('').map((ch, i) => (
        <span key={i} className="brand-letter" aria-hidden="true" onClick={() => handleClick(i)}>
          {ch}
        </span>
      ))}
      <span className="dot" aria-hidden="true">
        .
      </span>
    </div>
  );
}
