import { useCallback, useEffect, useRef } from 'react';
import { saveSession } from '../sessionStore.js';

/**
 * Builds the current conversation from transcript chunks and saves it when the session ends.
 * Gemini sends transcripts in small pieces, so consecutive chunks from the same speaker are
 * joined into one turn; a turn ends when the other side starts talking.
 */
export default function useSessionRecorder() {
  const currentRef = useRef(null);

  const begin = useCallback(() => {
    currentRef.current = { id: `${Date.now()}`, startedAt: Date.now(), turns: [] };
  }, []);

  const record = useCallback((role, text) => {
    const s = currentRef.current;
    if (!s || !text) return;
    const last = s.turns[s.turns.length - 1];
    if (last && last.role === role) last.text += text;
    else s.turns.push({ role, text, ts: Date.now() });
  }, []);

  // Safe to call more than once (user stop + connection-drop effect can both fire).
  const finish = useCallback(() => {
    const s = currentRef.current;
    currentRef.current = null;
    if (!s) return;
    s.turns = s.turns
      .map((t) => ({ ...t, text: t.text.trim() }))
      .filter((t) => t.text);
    if (!s.turns.length) return; // nothing was said — don't save an empty session
    s.endedAt = Date.now();
    saveSession(s);
  }, []);

  // Closing the tab mid-conversation shouldn't lose it.
  useEffect(() => {
    window.addEventListener('pagehide', finish);
    return () => window.removeEventListener('pagehide', finish);
  }, [finish]);

  return { begin, record, finish };
}
