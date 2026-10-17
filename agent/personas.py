"""
Persona registry.

A persona is a system instruction plus a few session knobs. The token server
picks the persona from a credential code and passes only its *id* to the agent
(dispatch metadata); the prompt text stays server-side. `system_instruction` is
fixed for a session's lifetime, which is fine here: one room = one session.

Private personas hold personal details, so nothing about them lives in code or
git. Each one is a local file pair, both gitignored:
  personas/<id>.md            the system instruction (required)
  personas/<id>.greeting.txt  agent-first greeting instruction (optional)
`*.example.*` files are the committed templates.

In the cloud there are no such files: the same two texts come from agent secrets,
base64-encoded (a file wins when both exist):
  PERSONA_<ID>_B64            instruction        (<ID> = id upper-cased, "-" -> "_")
  PERSONA_<ID>_GREETING_B64   greeting
"""

import base64
import binascii
import os
import re
from dataclasses import dataclass

from config import AI_GENDER, BREVITY_RULES, DEFAULT_SYSTEM_INSTRUCTION

PERSONA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "personas")
DEFAULT_PERSONA = "sparrow"
_ID_RE = re.compile(r"^[a-z0-9_-]+$")  # ids come from codes.json; keep paths safe


@dataclass(frozen=True)
class Persona:
    id: str
    instructions: str
    # One-off instruction for an agent-first greeting; None = user speaks first.
    greeting: str | None = None


def _path(persona_id: str, suffix: str) -> str | None:
    if not _ID_RE.match(persona_id) or persona_id.endswith(".example"):
        return None
    return os.path.join(PERSONA_DIR, f"{persona_id}{suffix}")


def _read(path: str | None) -> str | None:
    if path and os.path.isfile(path):
        with open(path, encoding="utf-8") as f:
            return f.read().strip() or None
    return None


def _from_env(persona_id: str, greeting: bool = False) -> str | None:
    """Base64 secret fallback for hosted deploys (no persona files there)."""
    if not _ID_RE.match(persona_id):
        return None
    name = persona_id.upper().replace("-", "_")
    raw = os.environ.get(f"PERSONA_{name}{'_GREETING' if greeting else ''}_B64", "").strip()
    if not raw:
        return None
    try:
        return base64.b64decode(raw, validate=True).decode("utf-8").strip() or None
    except (binascii.Error, UnicodeDecodeError):
        return None


def load_persona(persona_id: str) -> Persona:
    """Resolve a persona id. Unknown ids and missing files fall back to Sparrow."""
    instructions = None
    if persona_id != DEFAULT_PERSONA:
        instructions = _read(_path(persona_id, ".md")) or _from_env(persona_id)
    if instructions:
        greeting = _read(_path(persona_id, ".greeting.txt")) or _from_env(persona_id, greeting=True)
        return Persona(persona_id, f"{instructions}\n{BREVITY_RULES}", greeting)
    return Persona(
        DEFAULT_PERSONA,
        f"{DEFAULT_SYSTEM_INSTRUCTION.format(ai_gender=AI_GENDER)}\n{BREVITY_RULES}",
    )


def is_valid_id(persona_id: str) -> bool:
    """True if the id is well-formed.

    The token server runs without the persona files (they live with the agent), so
    it trusts the ids in codes.json. An id with no matching persona on the agent
    falls back to Sparrow (load_persona).
    """
    return bool(_ID_RE.match(persona_id)) and not persona_id.endswith(".example")
