# Sparrow — Real-Time Live Voice Agent

A low-latency, real-time **voice conversation agent** ("Sparrow") powered by Google's Gemini Live API (`gemini-live-2.5-flash-native-audio`) on Vertex AI. Sparrow is a clever, brave **health & wellness advisor** you talk to out loud — with the connect handshake taken off the request path, long conversations kept alive past Gemini's per-connection limit, and answers grounded in live web search.

> This project began as a speech translator and is now a general live-communication agent. The backend runs the **"Sparrow"** health-advisor persona — a clever, brave wellness companion that uses Google Search to ground its answers and replies in whatever language you speak. It is a wellness companion, not a doctor: it gives general guidance and points you to professional care for serious symptoms. Some translation-era controls still linger in the UI — see [Notes](#notes--known-cleanup).

## Highlights

- **Low latency** — a pool of pre-warmed Gemini sessions removes the ~2.5 s connect handshake from the request path. Time-to-first-audio is measured live on the dashboard.
- **Session resumption** — conversations survive Gemini's ~10-min per-connection cap by transparently reconnecting, **bounded to a per-user budget** so a pre-warmed (idle-aged) session still delivers a full window.
- **Grounded answers** — Google Search grounding is enabled on the session so Sparrow can base health guidance on current, reputable sources.
- **Native audio** — 16 kHz mic in, 24 kHz speech out, server-side VAD.

## Architecture

```
Browser (React + Vite)  <-- WebSocket -->  FastAPI Backend  <-- google-genai SDK -->  Gemini Live API (Vertex AI)
      16kHz PCM mic ---->                   (warm session pool                          (us-central1)
      24kHz PCM playback <----               + resumption wrapper)                      model: gemini-live-2.5-flash-native-audio
```

- **Frontend**: React app capturing 16 kHz 16-bit PCM mono audio, encoding to base64, sending over WebSocket. Receives 24 kHz PCM audio from the model and plays it back via the Web Audio API with buffer-queue scheduling. Shows a live latency dashboard.
- **Backend**: FastAPI server bridging the frontend WebSocket to the Gemini Live API via the `google-genai` Python SDK. Maintains a warm pool of pre-opened sessions and wraps each active session so the conversation can resume across Gemini's connection cap.

## How It Works

1. Press **Start** and speak naturally — the user speaks first.
2. Sparrow listens, responds with audio + text, and replies in the same language you used.
3. Behind the scenes the request is served by a pre-warmed session (near-zero handshake), and the conversation is kept alive up to a per-user time budget even though a single Gemini connection only lasts ~10 minutes.

## Low Latency: warm session pool

The connect handshake (~2.5 s) is the dominant cold-start cost, so it is kept off the request path:

- `POOL_SIZE` Gemini sessions are pre-opened and held ready in background keeper tasks.
- On connect, the **oldest** ready session is handed out (near-zero handshake) and a replacement is opened in the background.
- Idle sessions are recycled at `POOL_MAX_AGE_S`, safely under the ~10-min connection cap.
- If the pool is momentarily empty, the request **cold-connects** as a fallback (you simply see the full handshake time that once).

This is valid only because the system instruction is **generic** (the Sparrow persona carries no per-user data), so any warm session can serve any user.

## Long Conversations: session resumption

A Gemini *connection* lives only ~10 minutes; the server sends a `go_away` warning ~60 s before it drops. A pre-warmed session may already be several minutes into that budget when it is handed out, which would cut the user short. So each session is wrapped in a `ResumableSession`:

- It tracks the rolling **resumption handle** the server emits.
- On `go_away` it opens a fresh connection seeded with that handle and continues the conversation — bridging the connection cap.
- This is **bounded** by `SESSION_BUDGET_S` (measured from when the user connects): resumption only buys back the idle time the pool consumed, and a watchdog ends the session at the budget. It does **not** grant unlimited windows.

> v1 limitation: reconnect is non-transparent, so the ~handshake-long swap can drop the tail of an in-flight turn (once per bridge). `transparent=True` + client-message buffering would close that gap.

## Latency Dashboard

The left panel reports per-session timing (first turn only):

| Metric | Meaning |
|---|---|
| **Setup handshake** | Time to obtain a session — a few ms when served from the warm pool, the full handshake on a cold fallback. |
| **First audio · perceived (client)** | Your end-of-speech (mic VAD) → first audio chunk in the browser. The human-felt wait. |
| **First audio · Gemini (server)** | Gemini's end-of-speech (post-VAD) → first audio byte at the backend. Pure model time. |
| **Δ (VAD + network)** | client − server ≈ the VAD silence wait plus the client↔server hops. |

The frontend gates microphone audio until `setup_complete`, so audio captured during the handshake never buffers into a backlog that would inflate the first-turn numbers.

## Setup

### Prerequisites

- Python 3.10+
- Node.js 18+
- Google Cloud project with Vertex AI API enabled
- Application Default Credentials (ADC) configured

### Backend

```bash
cd backend
pip install -r requirements.txt
python main.py
```

The backend starts on `http://localhost:8000` and pre-warms the session pool on startup (look for `Warm session pool started`).

**Environment variables:**

| Variable | Description | Default |
|---|---|---|
| `GOOGLE_CLOUD_PROJECT` | GCP project ID | `account-pocs` |
| `GOOGLE_APPLICATION_CREDENTIALS` | Path to service account key JSON | (none) |

The location is hardcoded to `us-central1` as required by the Gemini Live API.

### Frontend

```bash
cd frontend
npm install
npm run dev
```

The frontend starts on `http://localhost:5173`.

### Tuning knobs (`backend/config.py`)

| Constant | Default | Purpose |
|---|---|---|
| `POOL_SIZE` | `5` | Number of pre-warmed sessions kept ready |
| `POOL_MAX_AGE_S` | `240` | Recycle an idle warm session this often (under the ~10-min cap) |
| `POOL_CHECKOUT_TIMEOUT_S` | `0.25` | Wait for a warm session before cold-connecting |
| `SESSION_BUDGET_S` | `600` | Per-user conversation budget; resumption bridges up to this, then the session ends |

`backend/idle_session_probe.py` is a throwaway probe that connects, stays silent, and logs the idle lifetime + `go_away` timing — run it to tune `POOL_MAX_AGE_S` and confirm resumption behavior.

## Audio

| Direction | Sample Rate | Format | Encoding |
|---|---|---|---|
| User to Model | 16,000 Hz | 16-bit PCM | Little-endian, mono |
| Model to User | 24,000 Hz | 16-bit PCM | Little-endian, mono |

Audio capture uses `AudioContext` with `ScriptProcessorNode`. Playback uses a buffer queue with `AudioBufferSourceNode` scheduling for seamless output.

## Voice Activity Detection (VAD)

Server-side VAD is configured on the Gemini Live API session:

| Parameter | Value | Description |
|---|---|---|
| `start_of_speech_sensitivity` | `LOW` | Less sensitive to speech onset — reduces false triggers |
| `end_of_speech_sensitivity` | `HIGH` | More sensitive to speech end — detects pauses quickly |
| `prefix_padding_ms` | `300` | 300 ms of audio buffered before detected speech start |
| `silence_duration_ms` | `500` | 500 ms of silence before speech is considered ended |

## WebSocket Protocol

### Frontend to Backend

| Message | Fields | Description |
|---|---|---|
| `setup` | `source_language`, `target_language` | Sent once after the WebSocket connects. Still emitted by the UI; the backend currently **ignores** the language fields (Sparrow replies in the user's language). |
| `audio` | `data` (base64) | 16 kHz PCM audio chunk from the microphone (sent only after `setup_complete`). |
| `stop` | (none) | Client requests session termination. |

### Backend to Frontend

| Message | Fields | Description |
|---|---|---|
| `setup_complete` | `setup_latency_ms`, `warm` | Session is ready. `warm=true` means it came from the pool; `setup_latency_ms` is the time to obtain it. |
| `server_first_audio` | `latency_ms` | Server-measured time-to-first-audio for the first turn. |
| `audio_output` | `data` (base64) | 24 kHz PCM audio chunk from the model. |
| `input_transcript` | `text` | Transcription of user speech. |
| `output_transcript` | `text` | Transcription of model speech. |
| `turn_complete` | (none) | Model finished its turn. |
| `interrupted` | (none) | User interrupted the model. |
| `error` | `message` | Error message. |

## API Endpoints

| Endpoint | Method | Description |
|---|---|---|
| `/ws` | WebSocket | Main live conversation session endpoint |
| `/health` | GET | Health check |
| `/languages` | GET | Returns the (legacy) list of languages used by the UI selectors |

## Project Structure

```
gemini-live-translator/
  backend/
    config.py              # Constants: model, audio, VAD, pool + budget knobs, Sparrow persona
    main.py                # FastAPI app, lifespan (pool start/stop), /ws, audio pump
    session_pool.py        # WarmPool: pre-opened sessions, oldest-first checkout, recycle
    resumable_session.py   # ResumableSession: handle tracking, budget-bounded resumption
    idle_session_probe.py  # Throwaway probe: idle lifetime / go_away timing
    requirements.txt       # Python dependencies
  frontend/
    src/
      config.js            # Frontend configuration
      App.jsx              # Main app, session management, latency metrics
      App.css              # Dark theme styles
      index.css            # CSS variables, fonts, animations
      main.jsx             # React entry point
      components/
        LeftPanel.jsx      # Controls, connection status, latency dashboard
        CenterPanel.jsx    # Conversation transcript display
      hooks/
        useWebSocket.js     # WebSocket connection, message routing, audio gating
        useAudioCapture.js  # 16kHz mic capture, PCM encoding, speech detection
        useAudioPlayback.js # 24kHz buffered audio playback
    index.html
    package.json
    vite.config.js
```

## Notes / known cleanup

- The frontend still carries **translation-era UI**: source/target language selectors, a "Translating" status label, and source/target transcript bubbles. The backend no longer translates — it runs the Sparrow persona and replies in the user's language — so these controls are vestigial and pending a UI refresh.
- **Google Search grounding** is configured via `tools=[Tool(google_search=GoogleSearch())]` in `build_live_config`. In `us-central1` this is handled server-side automatically. A regression reported in some regions (e.g. `europe-west8`, ~March 2026) instead delivers `google_search` to the client as a **function call**; if that surfaces here, search-dependent turns won't be grounded (and could stall) until a search proxy is added to fulfill the call. Watch for this when testing.
- `backend/requirements.txt` leaves `google-genai` unpinned; pin it (`>=1.0,<2`) before relying on the API surface.
