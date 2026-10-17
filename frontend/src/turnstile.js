// Cloudflare Turnstile bot check. Without VITE_TURNSTILE_SITE_KEY it is skipped (local dev).
// The widget is invisible; it only shows a small box if Cloudflare wants a click.
const SITE_KEY = import.meta.env.VITE_TURNSTILE_SITE_KEY;
const SCRIPT_URL = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
const TIMEOUT_MS = 20000;

let scriptPromise = null;

function loadScript() {
  if (window.turnstile) return Promise.resolve();
  if (!scriptPromise) {
    scriptPromise = new Promise((resolve, reject) => {
      const el = document.createElement("script");
      el.src = SCRIPT_URL;
      el.async = true;
      el.onload = resolve;
      el.onerror = () => {
        scriptPromise = null;
        reject(new Error("Could not load the bot check. Please try again."));
      };
      document.head.appendChild(el);
    });
  }
  return scriptPromise;
}

/** Resolves to a one-time token for the token server, or null when the check is off. */
export async function getTurnstileToken() {
  if (!SITE_KEY) return null;
  await loadScript();

  return new Promise((resolve, reject) => {
    const box = document.createElement("div");
    box.style.cssText = "position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:1000";
    document.body.appendChild(box);

    let widgetId;
    const timer = setTimeout(() => finish(reject, new Error("Bot check timed out. Please try again.")), TIMEOUT_MS);
    function finish(fn, value) {
      clearTimeout(timer);
      try {
        window.turnstile.remove(widgetId);
      } catch {
        /* widget already gone */
      }
      box.remove();
      fn(value);
    }

    widgetId = window.turnstile.render(box, {
      sitekey: SITE_KEY,
      appearance: "interaction-only",
      callback: (token) => finish(resolve, token),
      "error-callback": () => finish(reject, new Error("Bot check failed. Please reload and try again.")),
    });
  });
}
