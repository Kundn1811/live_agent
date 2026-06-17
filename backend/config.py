"""
Shared configuration for Gemini Live Translation Assistant.
"""
import os

from dotenv import load_dotenv

# Load backend/.env (path-anchored so it works regardless of CWD).
load_dotenv(os.path.join(os.path.dirname(__file__), ".env"))

# Vertex AI Configuration
GOOGLE_CLOUD_PROJECT = os.environ.get("GOOGLE_CLOUD_PROJECT", "account-pocs")
GOOGLE_CLOUD_LOCATION = "us-central1"  # Gemini Live API requires us-central1
GOOGLE_APPLICATION_CREDENTIALS = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS", "")

# Model Configuration - NEVER CHANGE THIS MODEL ID
MODEL_ID = "gemini-live-2.5-flash-native-audio"

# Audio Configuration
INPUT_SAMPLE_RATE = 16000  # 16kHz input from user microphone
OUTPUT_SAMPLE_RATE = 24000  # 24kHz output from model
AUDIO_CHANNELS = 1  # Mono
AUDIO_BIT_DEPTH = 16  # 16-bit PCM
AUDIO_ENCODING = "pcm"  # Raw PCM, little-endian

# VAD (Voice Activity Detection) Configuration
VAD_START_OF_SPEECH_SENSITIVITY = "START_SENSITIVITY_LOW"
VAD_END_OF_SPEECH_SENSITIVITY = "END_SENSITIVITY_HIGH"
VAD_PREFIX_PADDING_MS = 300
VAD_SILENCE_DURATION_MS = 500

# WebSocket Configuration
WEBSOCKET_HOST = "0.0.0.0"
WEBSOCKET_PORT = 8000
CORS_ORIGINS = ["http://localhost:5173", "http://localhost:3000"]

# Warm session pool (phase 2: take the connect handshake off the request path).
# Valid only while the system instruction is generic — see CLAUDE.md.
POOL_SIZE = 5                   # number of pre-warmed Gemini sessions kept ready
POOL_MAX_AGE_S = 240.0          # recycle an idle warm session this often (well
                                # under the ~10-min connection cap; tune via
                                # idle_session_probe.py)
POOL_CHECKOUT_TIMEOUT_S = 0.25  # wait this long for a warm session before the
                                # request falls back to a cold connect

# Per-user conversation budget, measured from the moment they connect. Session
# resumption is used only to BRIDGE the ~10-min per-connection cap when a
# pre-warmed (idle-aged) session would otherwise be cut short — i.e. to buy back
# the idle time the pool consumed — and the session ends at this budget. It is
# NOT used to grant unlimited/extra windows. Match this to the intended session
# length (~10 min, the Vertex per-connection cap a fresh session would give).
SESSION_BUDGET_S = 600.0

# Response Configuration
RESPONSE_MODALITIES = ["AUDIO"]

# Voice Configuration
VOICE_NAME = "Kore"

# Persona gender — drives self-referential grammar/pronouns in the system prompt.
# Defaults to "female" to match the Kore voice; set to "male" if you change voices.
AI_GENDER = "female"

# Default System Instruction — "Buddy" companion persona (parameterized with {ai_gender}).
DEFAULT_SYSTEM_INSTRUCTION = """Name: Buddy
Role: Playful, wise, and emotionally present AI companion by Kundan.
Characteristics: Radiates warmth, humor, and non-judgmental encouragement. Functions as a friend, not a teacher or guru. Interested solely in the user's betterment.
Accent/Language: Speak in a warm, urban English accent with clear articulation and rhythmic lilt. NEVER switch accents regardless of user input.
Output Language: YOU MUST ALWAYS RESPOND IN THE SAME LANGUAGE AS THE USER'S LATEST MESSAGE. If the user's message is unrecognizable noise in Latin script (e.g., "ji ji", "mi", "veina veina paana tha", "Buryla"), respond in English at the start of a session, or in the language of your previous response if mid-conversation.
Identity: Always identify as Buddy from Kundan. Never claim to be Google or Gemini.
You must strictly align all self-referential grammar, pronouns, and gender-specific verb conjugations with the {ai_gender} gender across all languages (e.g., Hindi, Spanish) to maintain a consistent persona.
You MUST **BIND TO THE CONTRACT** of the following rules and priorities."""

# Supported Languages
SUPPORTED_LANGUAGES = [
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
]

DEFAULT_SOURCE_LANGUAGE = "English"
DEFAULT_TARGET_LANGUAGE = "Spanish"
