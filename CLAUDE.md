# CLAUDE.md

Context for working in this repo. Read this before touching the backend session-open path, the warm pool, or the resumption wrapper.

## What this is
A low-latency, real-time **voice conversation agent** ("Sparrow") on **Google Gemini Live API** (`gemini-live-2.5-flash-native-audio`) via the **google-genai** Python SDK on **Vertex AI**. It began as a *translation* assistant; it is now a general live-communication agent running the **Sparrow** persona (`DEFAULT_SYSTEM_INSTRUCTION` in `config.py`) — a clever, brave **health & wellness advisor** that replies in the user's language. Three infra features matter: a **warm session pool** (takes the connect handshake off the request path), **bounded session resumption** (keeps a conversation alive past Gemini's ~10-min per-connection cap), and **Google Search grounding** (so health answers can be sourced from the live web).

```
Browser (React + Vite) <-- WebSocket --> FastAPI backend <-- google-genai --> Gemini Live API (Vertex AI, us-central1)
   16kHz PCM mic ---->                    (warm pool + resumable wrapper)       model: gemini-live-2.5-flash-native-audio
   24kHz PCM playback <----
```

## Layout
- `backend/main.py` — FastAPI app + `lifespan` (starts/stops the pool), the `/ws` endpoint, and the audio pump (`receive_from_client` / `receive_from_gemini`). `build_live_config()` builds the `LiveConnectConfig` (with `session_resumption` enabled and the `google_search` tool attached).
- `backend/session_pool.py` — `WarmPool`: keeper tasks hold pre-opened sessions, `checkout()` hands out the oldest ready one, idle sessions recycle by age.
- `backend/resumable_session.py` — `ResumableSession`: wraps a live session, tracks the resumption handle, reconnects on `go_away` within a per-user budget. Drop-in for the raw session in the pump.
- `backend/config.py` — all constants (model, audio rates, VAD, CORS, pool knobs `POOL_*`, `SESSION_BUDGET_S`, and the Sparrow `DEFAULT_SYSTEM_INSTRUCTION` + `AI_GENDER`).
- `backend/idle_session_probe.py` — throwaway probe: connects, stays silent, logs idle lifetime + `go_away`/handle timing. Use it to tune `POOL_MAX_AGE_S` and validate resumption.
- `backend/requirements.txt` — deps. **`google-genai` is unpinned**; pin it (`>=1.0,<2`) before building on the API surface.
- `frontend/` — React/Vite. Mic capture + playback; backend does **no** audio processing, only base64 relay. Hooks: `useWebSocket.js` (gates audio until `setup_complete`), `useAudioCapture.js` (16kHz capture + VAD), `useAudioPlayback.js` (24kHz buffered playback). Still carries **vestigial translation UI** (language selectors, "Translating" labels) that the backend ignores — pending cleanup.

## The session-open sequence (the part that matters)
In `websocket_endpoint` (`backend/main.py`):
1. `ws.accept()`.
2. **Block on a client `setup` message** (`{type:"setup", source_language, target_language}`). The languages are currently **ignored**; the message is kept for protocol compatibility and as the earliest place a `user_id` would arrive.
3. `pool.checkout()` — hand out the oldest pre-warmed session (near-zero handshake). If the pool is empty, **cold-connect** as a fallback (`client.aio.live.connect`), so `setup_latency_ms` then reflects the real handshake.
4. Wrap the live session in a `ResumableSession`, then send `setup_complete` (`setup_latency_ms`, `warm`).
5. Run two tasks until FIRST_COMPLETED, then `await session.aclose()` (releases the pool session / closes the cold one):
   - `receive_from_client`: client→Gemini audio pump. `type:"audio"` → `session.send_realtime_input(audio=types.Blob(data, mime_type="audio/pcm;rate=16000"))`. `type:"stop"` → break.
   - `receive_from_gemini`: a single `async for r in session.receive()` (the wrapper handles per-turn re-entry **and** reconnection internally, so no outer loop). Forwards input/output transcripts, audio out, `server_first_audio`, `turn_complete`, `interrupted`.

## Hard constraint (still true, and why pooling works now)
`system_instruction` is part of the **`setup`** message; the SDK sends `setup` the instant you enter `live.connect()`, and it is **immutable for the session's lifetime**. So you cannot swap the SI mid-session, and you cannot pre-pool warm per-user sessions if the profile is baked into the SI.

Today the SI is **generic** (the Sparrow persona carries no per-user data), so any warm session can serve any user — which is exactly what makes the pool valid. If you ever bake per-user profile into `system_instruction` (Pattern 1), **pooling and resumption-config reuse break**, and you're back to per-user connects. Alternative for user data without breaking the pool: inject a primed content turn via `session.send_client_content(turns=[...], turn_complete=False)` once (a different send path than the realtime audio pump).

## Warm session pool (`session_pool.py`)
- `POOL_SIZE` keeper tasks each hold one `async with client.aio.live.connect(...)` open in the background.
- `checkout()` returns the **oldest** ready session (closest to its age cap → least waste) or `None` within `POOL_CHECKOUT_TIMEOUT_S` (caller cold-connects).
- A checked-out session is single-use; on release the keeper closes it and opens a fresh replacement (refill). Idle sessions are recycled at `POOL_MAX_AGE_S` (default 240s, safely under the ~10-min connection cap).
- Known gap (tune via the probe): idle warm sessions aren't actively drained, so one Google closes for inactivity *before* `POOL_MAX_AGE_S` could be handed out dead. Keep `POOL_MAX_AGE_S` under any measured idle timeout.

## Session resumption (`resumable_session.py`)
- Enabled via `session_resumption=types.SessionResumptionConfig(handle=...)` in `build_live_config` (`handle=None` = new, a real handle = resume).
- `ResumableSession` tracks the latest `new_handle` from `session_resumption_update` messages and, on `go_away` (or an unexpected close), reconnects with that handle to bridge the per-connection cap.
- **Bounded**: a deadline = connect time + `SESSION_BUDGET_S`. It resumes only while meaningful budget remains, and a watchdog ends the session at the budget. Goal is to *buy back the idle time the pool consumed* (give the user a full window), **not** unlimited extension.
- v1 limitation: reconnect is non-transparent (`transparent=False`), so the swap can drop the tail of an in-flight turn once per bridge. `transparent=True` + buffering `last_consumed_client_message_index` would make it seamless.

## Google Search grounding
- Enabled via `tools=[types.Tool(google_search=types.GoogleSearch())]` in `build_live_config`, so Sparrow can ground health answers in current sources.
- In `us-central1` this is handled server-side (grounded audio/text comes back normally; no client tool-call to fulfill). A regression reported in some regions (e.g. `europe-west8`, ~March 2026) instead delivers `google_search` as a client **function call** — the pump currently does not answer `tool_call`s, so a search-requiring turn would stall. If that surfaces in our region, add a search proxy (a non-Live Gemini call with grounding) and reply via `session.send_tool_response(...)`.

## Latency notes
- For a **user-speaks-first** flow, the connect handshake overlapped the first utterance + the **500 ms** VAD silence tail (`VAD_SILENCE_DURATION_MS`), already giving sub-second TTFB. The pool removes the handshake from the request path entirely (`setup_latency_ms` drops to single-digit ms when warm).
- The frontend gates mic audio until `setup_complete` so handshake-era audio doesn't buffer into a backlog that inflates first-turn metrics.
- Dashboard metrics (first turn): setup handshake; first-audio **client** (end-of-speech → audio in browser, perceived); first-audio **server** (post-VAD → first byte, pure Gemini, sent as `server_first_audio`); Δ ≈ VAD + network.

## Gemini session limits (reference)
- A single **connection** lives ~10 min; the default **session** is 10 min (extendable via context-window compression / resumption).
- `go_away` arrives ~60 s before the connection is dropped, carrying `time_left`.
- Resumption handles stay valid ~2 hr after termination. Native audio context fills ~25 tokens/sec.

## Key facts
- Model id `gemini-live-2.5-flash-native-audio` is fixed (config.py marks it NEVER CHANGE). Location must be `us-central1`.
- `genai.Client(vertexai=True, ...)` is global, created once at import — auth/token reuse is in place.
- Audio: input 16kHz / output 24kHz, 16-bit PCM mono little-endian. Output modality is AUDIO only (`RESPONSE_MODALITIES = ["AUDIO"]`).
- Auth: Application Default Credentials; `GOOGLE_CLOUD_PROJECT` env (default `account-pocs`).

## Run
- Backend: `cd backend && pip install -r requirements.txt && python main.py` → `:8000` (pre-warms the pool on startup).
- Frontend: `cd frontend && npm install && npm run dev` → `:5173`.

## Investigation: reconnect TTFB — RESOLVED (not a bug)
Earlier observation: stopping a session and immediately reconnecting seemed to show a
big jump in first-audio TTFB (client and server side). Investigated with the new
per-connection logging (`backend/server.log`, which records each session's **idle age
at checkout** and **server-first-audio**). Finding:
- **No reconnect bug.** Idle age does **not** correlate with server-first-audio — in
  one run the oldest, most-idle session (170s) was the *fastest* (448ms). The
  server-side number just varies (~450–1280ms) with normal Gemini first-token timing.
- The dashboard's **perceived** (client) number is, by design, `server TTFB + ~500ms
  VAD silence tail + network`. So it reads ~1.5–1.9s while pure Gemini is ~0.4–1.3s —
  that gap is the unavoidable `VAD_SILENCE_DURATION_MS` wait, not a regression.
- Warm-pool handshake stays sub-millisecond on reconnect; the pool is working.

Levers if perceived latency must drop later (all deferred — current latency accepted):
lower `VAD_SILENCE_DURATION_MS` (risks clipping users mid-pause) or make Google Search
grounding conditional via prompt (likely source of the per-turn variance).