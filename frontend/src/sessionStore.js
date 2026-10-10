// Past conversations, kept only in this browser (localStorage). Newest first, capped.
// Shape: { id, startedAt, endedAt, turns: [{ role: 'user' | 'model', text, ts }] }

const KEY = 'sparrow:sessions';
export const MAX_SESSIONS = 10;

export function loadSessions() {
  try {
    const list = JSON.parse(localStorage.getItem(KEY) || '[]');
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export function saveSession(session) {
  try {
    const next = [session, ...loadSessions()].slice(0, MAX_SESSIONS);
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Storage full or blocked — history is a convenience, never block the session.
  }
}

export function clearSessions() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // ignore
  }
}
