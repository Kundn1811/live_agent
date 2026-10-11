// Transport: "livekit" (default) or "ws" (old FastAPI relay in backend/).
// Routes:  /          public Sparrow on LiveKit
//          /private   access-code gate, LiveKit only (token server owns codes + personas)
//          /legacy    old WebSocket backend (kept until backend/ is deleted at M5)
// ?transport=ws|livekit or VITE_TRANSPORT can still override the public route.
const pathname =
  typeof window !== "undefined" ? window.location.pathname.replace(/\/+$/, "") : "";
const queryTransport =
  typeof window !== "undefined"
    ? new URLSearchParams(window.location.search).get("transport")
    : null;

const isPrivate = pathname === "/private";
const isLegacy = pathname === "/legacy";

const config = {
  isPrivate,
  transport: isLegacy
    ? "ws"
    : isPrivate
      ? "livekit"
      : queryTransport || import.meta.env.VITE_TRANSPORT || "livekit",
  wsUrl: import.meta.env.VITE_WS_URL || "ws://localhost:8000/ws",
  tokenUrl: import.meta.env.VITE_TOKEN_URL || "http://localhost:8001/token",

  inputSampleRate: 16000,
  outputSampleRate: 24000,
  audioChannels: 1,
  audioBitDepth: 16,

  audioBufferSize: 4096,
  playbackBufferDuration: 0.1,

  // Client VAD (end-of-speech detection for the latency experiment).
  // vadSilenceMs is time-based so it doesn't depend on audioBufferSize; kept
  // under Gemini's 500ms server VAD so the client edge fires during the pause.
  vadEnergyThreshold: 0.01, // RMS threshold; tune if silence reads as speech
  vadSilenceMs: 400,

  supportedLanguages: [
    "English",
    "Spanish",
    "French",
    "German",
    "Italian",
    "Portuguese",
    "Japanese",
    "Korean",
    "Chinese (Mandarin)",
    "Hindi",
    "Arabic",
    "Russian",
    "Dutch",
    "Swedish",
    "Turkish",
    "Thai",
    "Vietnamese",
    "Indonesian",
    "Tamil",
    "Telugu",
    "Kannada",
    "Marathi",
  ],

  defaultSourceLanguage: "English",
  defaultTargetLanguage: "Spanish",
};

export default config;
