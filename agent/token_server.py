"""
Token server for the Sparrow LiveKit agent.

The browser asks `GET /token` for a short-lived room JWT. Each call mints a fresh
room and dispatches the `sparrow` agent into it explicitly, so one visitor = one
room = one agent session. The usage gate (per-IP / global caps) will sit here.

Run:  python token_server.py      # :8001
"""

import asyncio
import hmac
import json
import os
import time
import urllib.parse
import urllib.request
import uuid
from datetime import timedelta

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from livekit import api
from pydantic import BaseModel

from config import AGENT_NAME, SESSION_BUDGET_S
from config import BACKEND_GEMINI_API, BACKEND_VERTEX
from personas import DEFAULT_PERSONA, is_valid_id

HERE = os.path.dirname(os.path.abspath(__file__))
load_dotenv(os.path.join(HERE, ".env"))

CODES_PATH = os.path.join(HERE, "codes.json")
# Hosted deploys have no codes.json: the same JSON comes from the CODES_JSON secret.
# A local file wins when present.
# Wrong-code throttle, per client IP (in-memory; resets on restart).
MAX_FAILS = 5
FAIL_WINDOW_S = 600
_failures: dict[str, list[float]] = {}

# Public-route gate (GET /token only; /token/private is excluded). In-memory, so
# the counters reset on restart. Tune via env.
PUBLIC_IP_DAILY_LIMIT = int(os.environ.get("PUBLIC_IP_DAILY_LIMIT", "3"))
PUBLIC_GLOBAL_DAILY_LIMIT = int(os.environ.get("PUBLIC_GLOBAL_DAILY_LIMIT", "40"))
PUBLIC_MAX_TURNS = int(os.environ.get("PUBLIC_MAX_TURNS", "3"))
PUBLIC_LIMIT_S = float(os.environ.get("PUBLIC_LIMIT_S", "180"))
TRUST_PROXY = os.environ.get("TRUST_PROXY", "") == "1"
# Cloudflare Turnstile bot check on both token routes. Unset = check off (local dev).
TURNSTILE_SECRET = os.environ.get("TURNSTILE_SECRET", "")
TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify"
# Gemini backend for the public route: "vertex" (default) or "gemini_api" (needs a FREE-tier
# key in the agent's GEMINI_API_KEY; a billed key costs the same as Vertex, so no gain).
PUBLIC_BACKEND = os.environ.get("PUBLIC_BACKEND", BACKEND_VERTEX)
_public_mints: list[tuple[float, str]] = []  # (monotonic time, ip)

# Private-route cap: sessions per code over a rolling 24 h. A code can override it with
# "daily_sessions" in codes.json. In-memory, so it resets on restart.
PRIVATE_DAILY_SESSIONS = int(os.environ.get("PRIVATE_DAILY_SESSIONS", "10"))
_private_mints: dict[str, list[float]] = {}

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

app = FastAPI(
    title="Sparrow token server", docs_url=None, redoc_url=None, openapi_url=None
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


def _client_ip(request: Request) -> str:
    # Behind a proxy (Cloud Run, Fly...) the socket peer is the proxy, so read
    # X-Forwarded-For. Take the LAST hop: the proxy appends the real peer there, while
    # anything before it is client-supplied and would let a caller dodge the per-IP caps.
    # Only enable TRUST_PROXY when actually behind exactly one such proxy.
    if TRUST_PROXY:
        fwd = request.headers.get("x-forwarded-for", "")
        if fwd:
            return fwd.split(",")[-1].strip()
    return request.client.host if request.client else "unknown"


def _check_private_cap(code: str, limit: int) -> None:
    now = time.monotonic()
    recent = [t for t in _private_mints.get(code, []) if now - t < 86400]
    if len(recent) >= limit:
        _private_mints[code] = recent
        raise HTTPException(429, "That is enough for today. Please come back tomorrow.")
    recent.append(now)
    _private_mints[code] = recent


def _turnstile_ok(token: str, ip: str) -> bool:
    data = urllib.parse.urlencode(
        {"secret": TURNSTILE_SECRET, "response": token, "remoteip": ip}
    ).encode()
    try:
        with urllib.request.urlopen(
            urllib.request.Request(TURNSTILE_VERIFY_URL, data=data), timeout=5
        ) as resp:
            return bool(json.load(resp).get("success"))
    except (OSError, ValueError):
        return False  # fail closed: no verdict, no token


async def _check_bot(request: Request, ip: str) -> None:
    """Reject requests without a valid Turnstile token (a bot, or a script calling us directly)."""
    if not TURNSTILE_SECRET:
        return
    token = request.headers.get("x-turnstile-token", "")
    if not token or not await asyncio.to_thread(_turnstile_ok, token, ip):
        raise HTTPException(403, "Bot check failed. Please reload and try again.")


def _check_public_gate(ip: str) -> None:
    """Spend guard for the public route: per-IP and global caps over a rolling 24 h."""
    now = time.monotonic()
    cutoff = now - 86400
    _public_mints[:] = [(t, i) for t, i in _public_mints if t > cutoff]
    if len(_public_mints) >= PUBLIC_GLOBAL_DAILY_LIMIT:
        raise HTTPException(429, "Sparrow is resting for today. Please come back tomorrow.")
    if sum(1 for _, i in _public_mints if i == ip) >= PUBLIC_IP_DAILY_LIMIT:
        raise HTTPException(
            429, "You have used today's free chats. Please come back tomorrow."
        )
    _public_mints.append((now, ip))


def _mint(
    persona: str,
    name: str | None = None,
    limit_s: float | None = None,
    max_turns: int | None = None,
    backend: str = BACKEND_VERTEX,
) -> dict:
    """Fresh room + join token, with the agent dispatched carrying the persona id."""
    if not (LIVEKIT_URL and LIVEKIT_API_KEY and LIVEKIT_API_SECRET):
        raise HTTPException(500, "LiveKit credentials are not configured")

    room = f"sparrow-{uuid.uuid4().hex[:12]}"
    identity = f"user-{uuid.uuid4().hex[:8]}"
    # Only ids and numbers go to the agent; prompt text never leaves the server.
    metadata = json.dumps(
        {
            "persona": persona,
            "name": name,
            "limit_s": limit_s,
            "max_turns": max_turns,
            "backend": backend,
        }
    )

    jwt = (
        api.AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET)
        .with_identity(identity)
        # Short TTL: a token can re-create its room (and re-dispatch the agent) until it
        # expires, so a long TTL lets one mint buy many sessions. The browser joins at once.
        .with_ttl(timedelta(seconds=60))
        # Mic only: no video/screen share, no data messages from the visitor.
        .with_grants(
            api.VideoGrants(
                room_join=True,
                room=room,
                can_publish_sources=["microphone"],
                can_publish_data=False,
            )
        )
        .with_room_config(
            api.RoomConfiguration(
                agents=[api.RoomAgentDispatch(agent_name=AGENT_NAME, metadata=metadata)]
            )
        )
        .to_jwt()
    )
    return {"url": LIVEKIT_URL, "token": jwt, "room": room, "identity": identity}


@app.get("/token")
async def token(request: Request):
    """Public route: default Sparrow, no credential, gated per IP / globally.

    The turn cap is enforced by the agent (server side); the short time limit
    here also bounds a visitor who stays silent and just holds the session.
    """
    ip = _client_ip(request)
    await _check_bot(request, ip)  # before the gate, so bots don't use up the daily caps
    _check_public_gate(ip)
    # The free-tier Gemini API (if enabled) is fine for the public demo, never for private chats.
    return _mint(
        DEFAULT_PERSONA,
        limit_s=PUBLIC_LIMIT_S,
        max_turns=PUBLIC_MAX_TURNS,
        backend=PUBLIC_BACKEND if PUBLIC_BACKEND == BACKEND_GEMINI_API else BACKEND_VERTEX,
    )


def _load_codes() -> dict:
    # Re-read per request so codes can be added without restarting the server.
    try:
        if os.path.isfile(CODES_PATH):
            with open(CODES_PATH, encoding="utf-8") as f:
                data = json.load(f)
        else:
            data = json.loads(os.environ.get("CODES_JSON", "") or "{}")
    except json.JSONDecodeError:
        return {}
    return data if isinstance(data, dict) else {}


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
    ip = _client_ip(request)
    await _check_bot(request, ip)
    _check_rate_limit(ip)

    submitted = body.code.strip()
    entry = None
    matched = ""
    for code, value in _load_codes().items():
        # Compare every code in constant time; no early exit on a match.
        if hmac.compare_digest(code.encode(), submitted.encode()):
            entry = value
            matched = code
    if (
        not isinstance(entry, dict)
        or not isinstance(entry.get("persona"), str)
        or not is_valid_id(entry["persona"])
    ):
        _failures.setdefault(ip, []).append(time.monotonic())
        raise HTTPException(401, "That code did not work.")

    _check_private_cap(matched, int(entry.get("daily_sessions", PRIVATE_DAILY_SESSIONS)))
    limit_s = float(entry.get("limit_s", SESSION_BUDGET_S))
    return _mint(entry["persona"], entry.get("name"), limit_s, backend=BACKEND_VERTEX)


@app.get("/health")
async def health():
    return {"status": "ok"}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=TOKEN_SERVER_PORT)
