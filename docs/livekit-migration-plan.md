# LiveKit Migration Plan

Move the Sparrow voice agent from the custom FastAPI WebSocket relay onto the
**LiveKit Agents** framework (Python), keeping Gemini Live on Vertex AI.

> **Resuming in a new session?** Read "Handoff context" right below, then "Status".
> Convention: project context, decisions and next steps are kept in THIS file.

## Handoff context (read first)

**Owner:** Kundan. Sparrow = voice agent on Gemini Live (Vertex AI), now being moved to LiveKit Agents.

**Product direction (decided 2026-10-11)**
- **LiveKit is the default path.** Only `agent/` + `frontend/` get deployed. `backend/` (old FastAPI WS relay + warm pool + resumable wrapper) is NOT deployed, to save server resources; it stays only as the `/legacy` route until it is deleted at M5. Do not touch `backend/` except to delete it.
- **Frontend routes:** `/` public Sparrow (LiveKit) · `/private` access-code gate (LiveKit only) · `/legacy` old WS backend (needs `backend/` on :8000). Any other path shows a "Page not found" page (App never mounts). `?transport=ws|livekit` overrides the public route. Vercel will need an SPA rewrite so `/private` and `/legacy` load the app.
- **Dynamic persona injection (built, untested live):** a credential code → persona. `POST /token/private {code}` checks `agent/codes.json`; the room is dispatched with metadata `{persona, name, limit_s}` (ids only, prompt text never leaves the server). `agent.py` loads `personas/<id>.md`, may greet first, and ends the session at `limit_s` (default 10 min, goodbye line 20 s before). `system_instruction` is immutable per session, which is fine: one room = one session, no warm pool. Details: [agent/README.md](../agent/README.md).
- **Persona 1 — `partner` (built, private):** a personal persona for Kundan's partner, speaking on his behalf: short replies (low patience), one tiny healthy-habit step per turn, always says it is Sparrow his assistant (never claims to be him or human), safety rules kept. **All personal details (names, health context, wording) live only in local gitignored files — never put them in git, docs, code or CLAUDE.md:** `agent/personas/partner.md`, `agent/personas/partner.greeting.txt`, `agent/codes.json`. Templates (committed): `persona.example.md`, `persona.example.greeting.txt`, `codes.example.json`. Back these files up outside git; they are not recoverable from the repo.
  - Same mechanism later serves **family**: one code per person + a small persona/profile each. Build family personas only after the partner test works smoothly. Same rule: local gitignored files only.
- **Persona 2 — `interviewer` (NOT started; after v1 + deploy; local only, never deployed):** Kundan gives the question list + interview context; it also generates follow-up questions by digging into his answers; goal = make him interview-ready. Token design: **input-heavy, output-light** — all context in the system prompt, replies ≤ 2 sentences, one question per turn, no answering for him, feedback only on request/at end. Needs a longer VAD silence (~1.5–2 s) so it does not cut him off. Optional later: log answers + end-of-session scorecard.
- **Base Sparrow** stays the default persona (`DEFAULT_SYSTEM_INSTRUCTION` in `config.py`).

**Order of work**
1. Finish M0/M1: put `LIVEKIT_URL/API_KEY/API_SECRET` in `agent/.env`; spoken test incl. a search-grounded question; live test of `/` and `/private` (transcripts, barge-in, persona greeting, 10-min cutoff).
2. M2 → M5 (below). M3 decision gate: cold connect ≈ 2.2–3.2 s vs the old warm pool.
3. Deploy: agent worker + token server on Cloud Run (or similar), frontend on Vercel. GCP project/credentials undecided; never use `backend/lenskart-*.json` (employer key, gitignored). Private files (`personas/*.md`, `codes.json`) are not in git → supply as secrets/env at deploy.
4. Public usage gate (no login): 3 turns per visitor — per-IP/day + global daily cap in `token_server.py`, server-side turn counter in the agent. Private-code users are not subject to it (only the 10-min session limit).
5. Interviewer persona (local). 6. Inject into the portfolio.

**Known issues parked:** noisy mic breaks the perceived-latency metric and delays the real response (re-test in M4 with WebRTC NS/AEC). `google-genai` pin. Cold-connect latency (M3).

## Status
Branch: `feat/livekit-agent` (from `master`). Implementation docs: [agent/README.md](../agent/README.md). Nothing from M1 onward is committed yet.

| Milestone | Status | Notes |
|---|---|---|
| M0 Spike | 🟡 code done | Console smoke run connects to Gemini. Pending: spoken test incl. a search-grounded question. |
| M1 Token server + frontend | 🟡 code done | `token_server.py` + `useLiveKitSession`; LiveKit is now the default transport (`/`), old WS at `/legacy`. Build passes, `/token` verified offline. Pending: LiveKit Cloud key/secret in `agent/.env`, then a live conversation test (transcripts, barge-in). Metrics (perceived/server first-audio) are not wired on this transport yet (M3). |
| M1b Personas + private route | 🟡 code done | `personas.py`, `partner` persona, `POST /token/private` (codes, 5-fail throttle), `/private` code gate, per-session time limit + goodbye. Token server verified offline (200/401/429, dispatch metadata); frontend build passes. Headless end-to-end run passed (code → partner persona loaded → agent-first greeting spoken). Pending: a human voice test. **After pulling code changes, restart BOTH `agent.py dev` and `token_server.py` — neither hot-reloads reliably (a stale token server gave 404 on `/token/private`).** `AGENT_NAME` env overrides the agent name, so a second worker can be tested without stealing jobs from the main one. |
| M2 Session lifecycle | 🟡 partly | Budget timer done (in `agent.py`: `enforce_budget`). Still: verify resumption across `go_away` (>10 min run), clean shutdown on client leave, per-session logging. |
| M3 Metrics + A/B | ⬜ | |
| M4 Recorder + noise | ⬜ | |
| M5 Cutover | ⬜ | |

## Decisions
- **LiveKit server:** LiveKit Cloud (free tier). Creds in `agent/.env`:
  `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`.
- **Coexistence:** side-by-side. New `agent/` dir; `backend/` stays untouched
  until LiveKit reaches latency parity, then it is deleted (M5).
- **Frontend:** adapt the existing React app (swap transport + audio hooks,
  keep the dashboard). Old WS mode stays selectable until M5.

## Target architecture
```
Browser (React + livekit-client)  <-- WebRTC (Opus, AEC/NS) -->  LiveKit Cloud
                                                                    |
                         token server (FastAPI /token)              | job dispatch
                                                                    v
                                       agent worker (livekit-agents + google plugin)
                                                                    |
                                       Gemini Live (Vertex AI, us-central1)
                                       model: gemini-live-2.5-flash-native-audio
```

## What maps to what
| Today (`backend/`) | LiveKit |
|---|---|
| `/ws` endpoint + audio pump | `AgentSession` + room audio tracks (framework) |
| base64 PCM 16k in / 24k out | WebRTC Opus; framework resamples |
| `build_live_config()` | `google.realtime.RealtimeModel(vertexai=True, location="us-central1", model=MODEL_ID, voice, instructions, realtime_input_config, input/output_audio_transcription)` |
| Google Search tool | `Agent(tools=[google.tools.GoogleSearch()])` (Vertex: one tool kind only — fine, we have no function tools) |
| `ResumableSession` (go_away + handle) | built into the plugin (handle + auto-reconnect). We only re-add the **`SESSION_BUDGET_S` cap** as a timer |
| `WarmPool` | **dropped for v1.** Plugin has no pre-connect; the Gemini handshake overlaps the client's WebRTC join. Measure in M3; rebuild only if needed |
| transcripts over WS | LiveKit text streams (`lk.transcription`), automatic |
| `server_first_audio`, `metrics` msgs, `metrics.jsonl` | `metrics_collected` / state events on the agent + data-channel topic `metrics` from client; agent appends to `metrics.jsonl` |
| frontend mic gating until `setup_complete` | agent publishes a `ready` participant attribute; client gates mic on it |
| `debug_recorder.py` | port as an `AgentSession` audio tap (M4) |
| `useWebSocket` / `useAudioCapture` / `useAudioPlayback` | `livekit-client` `Room` + `@livekit/components-react` |

## Milestones
Each one ends with a working, runnable state and its own commit.

### M0 — Spike: agent talks via LiveKit playground (½ day)
- `agent/` with `requirements.txt` (`livekit-agents[google]~=1.8`, pinned), `config.py` (reuse backend constants), `agent.py`.
- Sparrow persona + Kore voice + VAD settings + Google Search on the Vertex model.
- **Exit:** `python agent.py dev` → talk to Sparrow from the LiveKit Agents Playground; a search-grounded health question works (no `tool_call` stall).

### M1 — Token server + frontend transport (1 day)
- `agent/token_server.py`: `GET /token?identity=` → room JWT with agent dispatch.
- Frontend: `useLiveKitSession` hook (connect, publish mic, play agent track, receive transcripts, `ready` gating). Transport toggle (WS | LiveKit) in the UI.
- **Exit:** full conversation in our own UI over LiveKit with live transcripts; interruption (barge-in) works.

### M2 — Session lifecycle parity (½ day)
- `SESSION_BUDGET_S` watchdog → graceful end + client notice.
- Verify plugin resumption across `go_away`: shorten connection life or run a >10 min session; log handle/reconnect.
- Clean shutdown on client leave; per-session logging (`server.log` equivalent, conn ids = room names).
- **Exit:** 12-min session survives the connection cap and ends at budget.

### M3 — Metrics parity + latency A/B (1 day)
- Agent: capture setup/connect time, server-first-audio (end-of-speech → first audio frame), `RealtimeModelMetrics.ttft`; send to client on data topic.
- Client: perceived first-audio, RTT (LiveKit exposes it); ship consolidated record → agent → `metrics.jsonl` with `transport` field.
- Run N sessions per transport, compare.
- **Decision gate:** if LiveKit setup/first-audio regresses materially vs warm-pool WS, scope a pre-connect (agent dispatched on page load, session started before user speaks) as M3b.

### M4 — Debug recorder + noise check (½ day)
- Port PCM recorder to tap agent input/output frames.
- Re-test the noisy-mic case (WebRTC NS/AEC may fix the known issue).

### M5 — Cutover + cleanup (½ day)
- Remove `backend/` WS path, pool, resumable wrapper, old hooks, vestigial translation UI.
- Update `CLAUDE.md` and README (new run steps: agent worker + token server + frontend).

## M0 findings (livekit-agents 1.8.5)
- Model id + Vertex accepted; Gemini session connects (console smoke run).
- Search: `create_tools_config` forwards `GeminiTool` provider tools to the Live
  config — verified in plugin source; needs a spoken grounded question to confirm.
- Resumption: plugin always sets `SessionResumptionConfig(handle=...)`, tracks
  `new_handle`, restarts on `go_away` (non-transparent, like our v1 wrapper).
- **Cold connect `acquire_time` ≈ 2.2–3.2 s**, plus ~1.1 s event-loop block on
  session creation (sync SSL ctx + token refresh inside google-genai). This is
  the handshake the warm pool hid → central question for the M3 gate.
- `metrics_collected` is deprecated → use `ChatMessage.metrics` / `session_usage_updated`.
- `python agent.py console` needs any non-empty `LIVEKIT_API_KEY/SECRET` even offline.

## Risks
- **Search on realtime + Vertex:** forwarded per source; if Gemini rejects it at runtime, fall back to a `function_tool` search proxy (non-Live grounded Gemini call).
- **Lost warm-pool advantage:** measured, not assumed (M3 gate).
- **Metric comparability:** WebRTC adds jitter buffer + Opus; "perceived" numbers aren't apples-to-apples with WS. Compare server-side first-audio as the primary metric.
