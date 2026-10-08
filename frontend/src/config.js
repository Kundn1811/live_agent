const config = {
  wsUrl: "ws://localhost:8000/ws",

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
