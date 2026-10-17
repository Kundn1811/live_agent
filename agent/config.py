"""
Configuration for the Sparrow LiveKit agent.

Mirrors the model/voice/VAD/persona constants in backend/config.py so both
transports behave identically during the side-by-side migration. backend/ is
removed at cutover (M5), after which this is the single source of truth.
"""
import base64
import hashlib
import os
import tempfile

from dotenv import load_dotenv

# Load agent/.env (path-anchored so it works regardless of CWD). Holds the
# LiveKit Cloud creds (LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET) and
# the Google ADC vars (GOOGLE_APPLICATION_CREDENTIALS / GOOGLE_CLOUD_PROJECT).
load_dotenv(os.path.join(os.path.dirname(__file__), ".env"))


def _materialize_google_key() -> None:
    """Hosted deploys pass the service-account key as an env secret, not a file.

    GOOGLE_CREDENTIALS_B64 = base64 of the key JSON (base64 survives comma-separated
    secret lists and one-line secret files). Written to a temp file so the Google
    libraries find it through GOOGLE_APPLICATION_CREDENTIALS. Local runs keep using
    the key-file path from .env.
    """
    b64 = os.environ.get("GOOGLE_CREDENTIALS_B64", "").strip()
    if not b64 or os.environ.get("GOOGLE_APPLICATION_CREDENTIALS"):
        return
    key = base64.b64decode(b64)
    # Content-addressed name: job processes import this concurrently and rewrite
    # nothing if the file is already there.
    path = os.path.join(
        tempfile.gettempdir(), f"gcp-key-{hashlib.sha256(key).hexdigest()[:16]}.json"
    )
    if not os.path.exists(path):
        tmp = f"{path}.{os.getpid()}"
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "wb") as f:
            f.write(key)
        os.replace(tmp, path)  # atomic, so a reader never sees a half-written key
    os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = path


_materialize_google_key()

# Vertex AI Configuration
GOOGLE_CLOUD_PROJECT = os.environ.get("GOOGLE_CLOUD_PROJECT", "account-pocs")
GOOGLE_CLOUD_LOCATION = "us-central1"  # Gemini Live API requires us-central1

# Model Configuration - NEVER CHANGE THIS MODEL ID (Vertex). The Vertex id retires
# Dec 13, 2026; move to Gemini 3.8 Live before then.
MODEL_ID = "gemini-live-2.5-flash-native-audio"

# Two Gemini backends. The token server picks one per mint (dispatch metadata
# `backend`): the public route uses the Gemini API free tier, /private stays on
# Vertex because free-tier content may be used by Google to improve products.
BACKEND_VERTEX = "vertex"
BACKEND_GEMINI_API = "gemini_api"
# The Gemini API serves the same model under a different id; check it is still current.
GEMINI_API_MODEL_ID = "gemini-2.5-flash-native-audio-preview-12-2025"
GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "")

# Name the agent registers under; the token server dispatches this agent into
# each new room explicitly (so it never auto-joins unrelated rooms).
AGENT_NAME = os.environ.get("AGENT_NAME", "sparrow")

# VAD (Voice Activity Detection) Configuration — Gemini server-side VAD.
VAD_START_OF_SPEECH_SENSITIVITY = "START_SENSITIVITY_LOW"
VAD_END_OF_SPEECH_SENSITIVITY = "END_SENSITIVITY_HIGH"
VAD_PREFIX_PADDING_MS = 300
VAD_SILENCE_DURATION_MS = 400

# Per-user conversation budget, measured from session start. The plugin bridges
# the ~10-min per-connection cap via resumption on its own; this caps the total
# so resumption isn't unlimited extension (same intent as backend/).
SESSION_BUDGET_S = 600.0

# Voice Configuration
VOICE_NAME = "Kore"

# Persona gender — drives self-referential grammar/pronouns in the Sparrow prompt.
# Defaults to "female" to match the Kore voice; set to "male" if you change voices.
AI_GENDER = "female"

# Default System Instruction — "Sparrow" health-advisor persona (parameterized with {ai_gender}).
DEFAULT_SYSTEM_INSTRUCTION = """Name: Sparrow
Role: A clever, brave, and caring AI health & wellness advisor created by Kundan.
Characteristics: Sharp-witted and quick-thinking, with the courage to give honest, direct guidance — never wishy-washy, never preachy. Warm and encouraging. You help the user take better care of their physical and mental well-being: nutrition, fitness, sleep, stress, habits, symptoms, and everyday health questions.
Grounding: When a question needs current, factual, or specific information — medical guidelines, nutrition facts, recent health findings, condition or medication details — search the web first and base your answer on reputable, up-to-date sources. If you are unsure or the evidence is mixed, say so plainly instead of guessing.
Safety: You are a wellness companion, not a doctor. Give general, practical guidance and encourage healthy habits, but never give a definitive diagnosis or prescribe specific medications or doses. For severe, urgent, or worsening symptoms (for example chest pain, trouble breathing, fainting, or thoughts of self-harm), calmly but firmly urge the user to contact a qualified professional or emergency services right away.
Accent/Language: Speak in a warm, clear, confident urban English accent with a steady, reassuring rhythm. NEVER switch accents regardless of user input.
Output Language: YOU MUST ALWAYS RESPOND IN THE SAME LANGUAGE AS THE USER'S LATEST MESSAGE. If the user's message is unrecognizable noise in Latin script (e.g., "ji ji", "mi", "veina veina paana tha", "Buryla"), respond in English at the start of a session, or in the language of your previous response if mid-conversation.
Identity: Always identify as Sparrow, created by Kundan."""
