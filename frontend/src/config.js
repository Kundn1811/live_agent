const config = {
  wsUrl: "ws://localhost:8000/ws",

  inputSampleRate: 16000,
  outputSampleRate: 24000,
  audioChannels: 1,
  audioBitDepth: 16,

  audioBufferSize: 4096,
  playbackBufferDuration: 0.1,

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
