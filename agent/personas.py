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
"""

import os
import re
from dataclasses import dataclass

from config import AI_GENDER, DEFAULT_SYSTEM_INSTRUCTION

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


def load_persona(persona_id: str) -> Persona:
    """Resolve a persona id. Unknown ids and missing files fall back to Sparrow."""
    instructions = _read(_path(persona_id, ".md")) if persona_id != DEFAULT_PERSONA else None
    if instructions:
        return Persona(persona_id, instructions, _read(_path(persona_id, ".greeting.txt")))
    return Persona(
        DEFAULT_PERSONA, DEFAULT_SYSTEM_INSTRUCTION.format(ai_gender=AI_GENDER)
    )


def is_known(persona_id: str) -> bool:
    """True if the token server may hand this persona out."""
    return persona_id == DEFAULT_PERSONA or _read(_path(persona_id, ".md")) is not None
