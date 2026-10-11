"""
Token server for the Sparrow LiveKit agent.

The browser asks `GET /token` for a short-lived room JWT. Each call mints a fresh
room and dispatches the `sparrow` agent into it explicitly, so one visitor = one
room = one agent session. The usage gate (per-IP / global caps) will sit here.

Run:  python token_server.py      # :8001
"""

import hmac
import json
import os
import time
import uuid
from datetime import timedelta

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from livekit import api
from pydantic import BaseModel

from config import AGENT_NAME, SESSION_BUDGET_S
from personas import DEFAULT_PERSONA, is_known

HERE = os.path.dirname(os.path.abspath(__file__))
load_dotenv(os.path.join(HERE, ".env"))

CODES_PATH = os.path.join(HERE, "codes.json")
# Wrong-code throttle, per client IP (in-memory; resets on restart).
MAX_FAILS = 5
FAIL_WINDOW_S = 600
_failures: dict[str, list[float]] = {}

LIVEKIT_URL = os.environ.get("LIVEKIT_URL", "")
LIVEKIT_API_KEY = os.environ.get("LIVEKIT_API_KEY", "")
LIVEKIT_API_SECRET = os.environ.get("LIVEKIT_API_SECRET", "")
TOKEN_SERVER_PORT = int(os.environ.get("TOKEN_SERVER_PORT", "8001"))
CORS_ORIGINS = [
    o.strip()
    for o in os.environ.get(
        "CORS_ORIGINS", "http://localhost:5173,http://localhost:3000"
    ).split(",")
    if o.strip()
]

app = FastAPI(title="Sparrow token server")
app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


def _mint(persona: str, name: str | None = None, limit_s: float | None = None) -> dict:
    """Fresh room + join token, with the agent dispatched carrying the persona id."""
    if not (LIVEKIT_URL and LIVEKIT_API_KEY and LIVEKIT_API_SECRET):
        raise HTTPException(500, "LiveKit credentials are not configured")

    room = f"sparrow-{uuid.uuid4().hex[:12]}"
    identity = f"user-{uuid.uuid4().hex[:8]}"
    # Only ids and numbers go to the agent; prompt text never leaves the server.
    metadata = json.dumps({"persona": persona, "name": name, "limit_s": limit_s})

    jwt = (
        api.AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET)
        .with_identity(identity)
        .with_ttl(timedelta(minutes=10))
        .with_grants(api.VideoGrants(room_join=True, room=room))
        .with_room_config(
            api.RoomConfiguration(
                agents=[api.RoomAgentDispatch(agent_name=AGENT_NAME, metadata=metadata)]
            )
        )
        .to_jwt()
    )
    return {"url": LIVEKIT_URL, "token": jwt, "room": room, "identity": identity}


@app.get("/token")
async def token():
    """Public route: default Sparrow, no credential."""
    return _mint(DEFAULT_PERSONA)


def _load_codes() -> dict:
    # Re-read per request so codes can be added without restarting the server.
    try:
        with open(CODES_PATH, encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def _check_rate_limit(ip: str) -> None:
    now = time.monotonic()
    recent = [t for t in _failures.get(ip, []) if now - t < FAIL_WINDOW_S]
    _failures[ip] = recent
    if len(recent) >= MAX_FAILS:
        raise HTTPException(429, "Too many wrong codes. Try again later.")


class PrivateRequest(BaseModel):
    code: str


@app.post("/token/private")
async def token_private(body: PrivateRequest, request: Request):
    """Private route: a credential code picks the persona and the session limit."""
    ip = request.client.host if request.client else "unknown"
    _check_rate_limit(ip)

    submitted = body.code.strip()
    entry = None
    for code, value in _load_codes().items():
        # Compare every code in constant time; no early exit on a match.
        if hmac.compare_digest(code.encode(), submitted.encode()):
            entry = value
    if entry is None or not is_known(entry.get("persona", "")):
        _failures.setdefault(ip, []).append(time.monotonic())
        raise HTTPException(401, "That code did not work.")

    limit_s = float(entry.get("limit_s", SESSION_BUDGET_S))
    return _mint(entry["persona"], entry.get("name"), limit_s)


@app.get("/health")
async def health():
    return {"status": "ok"}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=TOKEN_SERVER_PORT)
