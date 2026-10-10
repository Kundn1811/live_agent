import { useCallback, useState } from 'react';

// Developer mode lasts for this browser tab only (sessionStorage): closing the tab turns it off.
const KEY = 'sparrow:dev';

function read() {
  try {
    return sessionStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

export default function useDevMode() {
  const [devMode, setState] = useState(read);

  const setDevMode = useCallback((on) => {
    setState(on);
    try {
      if (on) sessionStorage.setItem(KEY, '1');
      else sessionStorage.removeItem(KEY);
    } catch {
      // Storage blocked — it still works for this page load.
    }
  }, []);

  return [devMode, setDevMode];
}
