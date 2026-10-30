# Sparrow agent (LiveKit)

LiveKit Agents implementation of the Sparrow voice agent. Runs side-by-side with
the legacy FastAPI WebSocket backend (`backend/`) (kept in the repo, never deployed).
Migration plan + milestone status: [docs/livekit-migration-plan.md](../docs/livekit-migration-plan.md).

```
Browser --WebRTC--> LiveKit Cloud --job dispatch--> agent worker (this dir) --google-genai--> Gemini Live (Vertex, us-central1)
```

## Files
| File | Purpose |
|---|---|
| `agent.py` | `AgentServer` entrypoint (`agent_name="sparrow"`), `build_realtime_model()`, `Sparrow` agent (persona + Google Search tool), per-turn logging. |
| `config.py` | Model, Vertex location, VAD, voice, `SESSION_BUDGET_S`, Sparrow system instruction. Mirrors `backend/config.py`. |
| `token_server.py` | FastAPI (:8001). `GET /token` (public) and `POST /token/private` (access code). Mints a room JWT (10-min TTL) and dispatches the `sparrow` agent into a fresh `sparrow-<id>` room, with persona metadata. Public usage gate lives here (see "Public usage gate"). |
| `personas.py`, `personas/` | Persona registry + prompt files (private ones gitignored). |
| `codes.json` | Access codes → persona/limit (gitignored; see `codes.example.json`). |
| `requirements.txt` | `livekit-agents[google]~=1.8.5` (tested on 1.8.5). |
| `Dockerfile`, `.dockerignore` | Agent image, built by LiveKit Cloud on `lk agent deploy`. |
| `Dockerfile.token`, `requirements-token.txt` | Token server image for Cloud Run (staged by the deploy workflow). |
| `livekit.toml` | Created once by `lk agent create` (agent id); commit it. |
| `.env.example` | Required env vars. Copy to `.env` (gitignored). |

## How it works
- **Session:** each LiveKit room dispatch runs `entrypoint()` → `AgentSession(llm=RealtimeModel)` → `session.start(room, Sparrow())`. User speaks first (no greeting).
- **Model config:** `google.realtime.RealtimeModel(model=MODEL_ID, vertexai=True, location="us-central1", voice="Kore", realtime_input_config=<Gemini server VAD>, input/output transcription on)`. Same settings as `backend/main.py:build_live_config`. `build_realtime_model(backend)` picks the backend per room from the dispatch metadata: `gemini_api` (public `/token`: Gemini API key, free tier, model `GEMINI_API_MODEL_ID`) or `vertex` (private; also the default for a missing flag).
- **Google Search:** `Agent(tools=[google.tools.GoogleSearch()])`. The plugin forwards provider tools into the Live config. Vertex allows one tool kind per session — adding a `function_tool` would silently drop search (plugin logs a warning).
- **Resumption:** handled by the plugin — always enables `SessionResumptionConfig`, stores the latest `new_handle`, restarts the connection on `go_away`. Non-transparent (a turn in flight at swap time may be cut), same as the legacy wrapper. Replaces `backend/resumable_session.py`.
- **Warm pool:** none. The plugin has no pre-connect hook; the Gemini handshake happens at `session.start`. See M3 gate in the plan.
- **Transcripts:** published by LiveKit automatically on the `lk.transcription` text stream.
- **Metrics:** per-turn `ChatMessage.metrics` logged on `conversation_item_added` (full parity is M3). `metrics_collected` is deprecated in 1.8 — don't use it.

## Run
```powershell
cd agent
python -m venv .venv; .venv\Scripts\pip install -r requirements.txt
copy .env.example .env   # fill LiveKit Cloud + Google ADC vars

.venv\Scripts\python agent.py console   # local mic/speaker, no LiveKit room
.venv\Scripts\python agent.py dev       # register with LiveKit Cloud (hot reload)
```
Full local stack (three terminals):
```powershell
cd agent;    .venv\Scripts\python agent.py dev          # agent worker
cd agent;    .venv\Scripts\python token_server.py       # :8001
cd frontend; npm run dev                                # open http://localhost:5173/
```
Routes: `/` public Sparrow (LiveKit), `/private` access-code gate (LiveKit, persona by code), `/legacy` old WS backend (needs `backend/` running on :8000).
Frontend env (optional): `VITE_TOKEN_URL`, `VITE_TRANSPORT` (overrides the public route only).

## Personas + private route
- `personas.py` — registry. `sparrow` = `DEFAULT_SYSTEM_INSTRUCTION`; others load `personas/<id>.md` (gitignored; template `persona.example.md`), with an optional `personas/<id>.greeting.txt` for an agent-first greeting. Personas are discovered from files; no persona names or details are in code. Hosted agents have no files: the same texts come from base64 secrets `PERSONA_<ID>_B64` and `PERSONA_<ID>_GREETING_B64` (a file wins).
- `codes.json` (gitignored; `codes.example.json` is the template) — `{code: {persona, name, limit_s}}`. Re-read per request. In the cloud there is no file: the same JSON comes from the `CODES_JSON` env (Secret Manager); a local file wins.
- `POST /token/private {code}` → 401 on a bad code, 429 after 5 wrong tries / 10 min / IP. On success the room is dispatched with metadata `{persona, name, limit_s}`; the prompt text never leaves the server.
- `agent.py` reads `ctx.job.metadata`, loads the persona, and runs `enforce_budget`: goodbye line 20 s before `limit_s`, then `ctx.shutdown`.
- Add a family member: add a code to `codes.json` (and a persona file + `_FILE_PERSONAS` entry if they need their own prompt).

## Deploying
Push to `master` deploys (agent → LiveKit Cloud, token server → Cloud Run, frontend → Vercel). One-time setup and the secrets list: [docs/deploy-setup.md](../docs/deploy-setup.md). On a hosted agent, Gemini auth comes from the env secret `GOOGLE_CREDENTIALS_B64` (base64 of the service-account key JSON); `config.py` writes it to a temp file and sets `GOOGLE_APPLICATION_CREDENTIALS`. Do not set `LIVEKIT_URL`/`LIVEKIT_API_KEY`/`LIVEKIT_API_SECRET` in the Dockerfile; LiveKit injects them.

`console` still requires non-empty `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` (any value) even though it never contacts a server.

## Known issues
- Cold connect `acquire_time` ≈ 2.2–3.2 s, plus ~1.1 s event-loop block during session creation (sync SSL context + token refresh in google-genai).

## Public usage gate (P3)
- `GET /token` only; `/token/private` is excluded. In-memory, resets on restart.
- Token server: per-IP daily limit (`PUBLIC_IP_DAILY_LIMIT`, default 3) and global daily cap (`PUBLIC_GLOBAL_DAILY_LIMIT`, default 40) over a rolling 24 h; 429 with a friendly message (the frontend shows it). Public sessions also get `PUBLIC_LIMIT_S` (default 180 s). Set `TRUST_PROXY=1` behind a proxy so the visitor IP comes from `X-Forwarded-For`.
- Agent: metadata carries `max_turns` (`PUBLIC_MAX_TURNS`, default 5). `agent.py` counts user turns, lets the reply to the last one finish, speaks a goodbye, then `ctx.shutdown`. The counter lives on the server.
- Local testing of `/` burns the per-IP limit: set `PUBLIC_IP_DAILY_LIMIT` high in `agent/.env`.
- Ending a session: `end_session` deletes the room (`ctx.delete_room()`) before `ctx.shutdown`; otherwise the visitor stays alone in the room and the browser never notices. Used by both the turn cap and the time limit.
- The spoken goodbye is best effort: Gemini sometimes cuts a `generate_reply` after a few words (and `allow_interruptions=False` is not supported with server-side turn detection). A cut under 4 s is retried once.
- Logs: `agent/agent.log` (gitignored) gets our lines and LiveKit INFO+. Run with `.venv\Scripts\python.exe agent.py dev`.
