# Sparrow agent (LiveKit)

LiveKit Agents implementation of the Sparrow voice agent. Runs side-by-side with
the legacy FastAPI WebSocket backend (`backend/`) until cutover (M5).
Migration plan + milestone status: [docs/livekit-migration-plan.md](../docs/livekit-migration-plan.md).

```
Browser --WebRTC--> LiveKit Cloud --job dispatch--> agent worker (this dir) --google-genai--> Gemini Live (Vertex, us-central1)
```

## Files
| File | Purpose |
|---|---|
| `agent.py` | `AgentServer` entrypoint (`agent_name="sparrow"`), `build_realtime_model()`, `Sparrow` agent (persona + Google Search tool), per-turn logging. |
| `config.py` | Model, Vertex location, VAD, voice, `SESSION_BUDGET_S`, Sparrow system instruction. Mirrors `backend/config.py` until M5. |
| `requirements.txt` | `livekit-agents[google]~=1.8.5` (tested on 1.8.5). |
| `.env.example` | Required env vars. Copy to `.env` (gitignored). |

## How it works
- **Session:** each LiveKit room dispatch runs `entrypoint()` → `AgentSession(llm=RealtimeModel)` → `session.start(room, Sparrow())`. User speaks first (no greeting).
- **Model config:** `google.realtime.RealtimeModel(model=MODEL_ID, vertexai=True, location="us-central1", voice="Kore", realtime_input_config=<Gemini server VAD>, input/output transcription on)`. Same settings as `backend/main.py:build_live_config`.
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
`console` still requires non-empty `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` (any value) even though it never contacts a server.

## Known issues
- Cold connect `acquire_time` ≈ 2.2–3.2 s, plus ~1.1 s event-loop block during session creation (sync SSL context + token refresh in google-genai).
