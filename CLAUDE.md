# CLAUDE.md

Context for working in this repo. Read this before changing the backend session-open path.

## What this is
Real-time voice agent on **Google Gemini Live API** (`gemini-live-2.5-flash-native-audio`) via the **google-genai** Python SDK on **Vertex AI**. Today it is a *translation* assistant; the active goal is to repurpose it into a general conversational "buddy" agent that knows the user's profile (see "Active goal" below).

```
Browser (React + Vite) <-- WebSocket --> FastAPI backend <-- google-genai --> Gemini Live API (Vertex AI, us-central1)
   16kHz PCM mic ---->                                                          model: gemini-live-2.5-flash-native-audio
   24kHz PCM playback <----
```

## Layout
- `backend/main.py` — FastAPI WebSocket relay. The only file with session logic.
- `backend/config.py` — all constants (model, audio rates, VAD, CORS, the system-instruction template).
- `backend/requirements.txt` — deps. **`google-genai` is unpinned** (bare name). Pin it (`>=1.0,<2`) before building on the API surface; nothing is installed locally yet.
- `frontend/` — React/Vite. Does mic capture + playback; backend does **no** audio processing, only base64 relay. Hooks: `useWebSocket.js`, `useAudioCapture.js` (16kHz capture), `useAudioPlayback.js` (24kHz buffered playback).

## The session-open sequence (the part that matters)
In `websocket_endpoint` (`backend/main.py`):
1. `ws.accept()`.
2. **Block on a client `setup` message** — frontend sends first (`{type:"setup", source_language, target_language}`). This is the only per-session input today and the earliest point a `user_id` would arrive.
3. Build `system_instruction` (template + args), build `LiveConnectConfig`.
4. Enter `async with client.aio.live.connect(model, config)` — **this line emits `setup` to Gemini.**
5. Send `setup_complete`, then run two tasks until FIRST_COMPLETED:
   - `receive_from_client`: client→Gemini audio pump. `type:"audio"` → `session.send_realtime_input(audio=types.Blob(data, mime_type="audio/pcm;rate=16000"))`. `type:"stop"` → break.
   - `receive_from_gemini`: `while True` wrapping `async for r in session.receive()` (receive() exhausts per turn, so it's re-entered). Forwards input/output transcripts, audio out, `turn_complete`, `interrupted`.

## Hard constraint (governs all design here)
`system_instruction` is part of the **`setup`** message. The SDK sends `setup` the instant you enter `live.connect()`, and it is **immutable for the session's lifetime**. Therefore:
- You **cannot** open a generic/no-prompt socket and later swap in user-specific instruction at the `system_instruction` level.
- You **cannot** pre-pool warm per-user sessions (you don't know the user until they connect) if the profile is baked into `system_instruction`.

Two honest ways to get user data into turn 1:
- **A — bake into `system_instruction`** (Pattern 1 / "Delayed Setup"): fetch profile → build config → connect. True system grounding, not poolable.
- **B — inject as a primed content turn**: connect with generic instruction (poolable), then `session.send_client_content(turns=[...], turn_complete=False)` once so the profile is in context before turn 1, no response triggered, never re-sent. Weaker grounding, uses context window. Note this is a *different* send path than the realtime audio pump.

## Latency note
For a **user-speaks-first** voice flow, the connect handshake overlaps the user's first utterance + the **800 ms** VAD silence tail (`VAD_SILENCE_DURATION_MS`), so Pattern 1 already yields sub-second time-to-first-audio measured from end-of-speech; pooling buys little. Pooling/Option B only earns its keep if the **agent speaks first** (proactive greeting on connect), where handshake + DB fetch sit on the critical path with no utterance to hide behind.

## Active goal (in progress, NOT yet implemented)
Turn this into a "buddy" agent: strip the translation prompt, add async DB profile fetch (name/location/prefs) fired the moment the user is known, build `system_instruction` with the profile baked in (Pattern 1), then connect. Sub-second TTFB with the profile present from the first turn, without re-sending it every prompt. Keep the existing `/ws` route and audio pump intact. Open design question: does the user or the agent speak first on session start — it decides A vs B above.

## Key facts
- Model id `gemini-live-2.5-flash-native-audio` is fixed (config.py marks it NEVER CHANGE). Location must be `us-central1`.
- `genai.Client(vertexai=True, ...)` is global, created once at import — auth/token reuse is already in place; per-session cost is just the connect handshake.
- Audio: input 16kHz / output 24kHz, 16-bit PCM mono little-endian. Output modality is AUDIO only (`RESPONSE_MODALITIES = ["AUDIO"]`).
- Auth: Application Default Credentials; `GOOGLE_CLOUD_PROJECT` env (default `account-pocs`).

## Run
- Backend: `cd backend && pip install -r requirements.txt && python main.py` → `:8000`.
- Frontend: `cd frontend && npm install && npm run dev` → `:5173`.
