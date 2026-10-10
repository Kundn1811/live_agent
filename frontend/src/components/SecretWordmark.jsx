import React, { useRef } from 'react';

const WORD = 'Sparrow';
// Longest allowed pause between two clicks before the sequence starts over.
const MAX_GAP_MS = 4000;

// Click-by-click trace in the browser console, so a failed attempt is easy to diagnose.
// Only in the local dev server (`npm run dev`); production builds log nothing.
const log = import.meta.env.DEV
  ? (...args) => console.log('%c[dev-gesture]', 'color:#f5a524;font-weight:bold', ...args)
  : () => {};

/**
 * The "Sparrow." wordmark. Each letter is secretly clickable: clicking the letters one by one in the
 * right order calls `onSequence` (matching is by letter, so the two r's are interchangeable). Entering developer mode = last letter to first; leaving it =
 * first letter to last. There is deliberately no feedback (no cursor change, no highlight) while
 * clicking, and a wrong letter or a long pause starts over.
 */
export default function SecretWordmark({ reverse, onSequence }) {
  const progressRef = useRef(0);
  const lastClickRef = useRef(0);

  const order = WORD.split('').map((_, i) => (reverse ? WORD.length - 1 - i : i));

  const handleClick = (index) => {
    const now = performance.now();
    const gap = now - lastClickRef.current;
    if (lastClickRef.current && gap > MAX_GAP_MS) {
      log(`pause of ${(gap / 1000).toFixed(1)}s is over ${MAX_GAP_MS / 1000}s, started over`);
      progressRef.current = 0;
    }
    lastClickRef.current = now;

    const clicked = `"${WORD[index]}" (letter ${index + 1} of ${WORD.length})`;
    const expectedIndex = order[progressRef.current];
    const expected = `"${WORD[expectedIndex]}" (letter ${expectedIndex + 1})`;
    const direction = reverse ? 'last to first' : 'first to last';

    // Compare letters, not positions: the word has two r's and either one counts.
    if (WORD[index] === WORD[expectedIndex]) {
      progressRef.current += 1;
      log(`clicked ${clicked}: correct, ${progressRef.current}/${order.length} (${direction})`);
    } else {
      progressRef.current = WORD[index] === WORD[order[0]] ? 1 : 0;
      log(
        `clicked ${clicked}: WRONG, expected ${expected}. ` +
          (progressRef.current === 1 ? 'Counted as a new start, 1/' + order.length : 'Started over, 0/' + order.length),
      );
    }

    if (progressRef.current === order.length) {
      progressRef.current = 0;
      log('sequence complete, opening the popup');
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
