# LiveKit Migration Plan

Move the Sparrow voice agent from the custom FastAPI WebSocket relay onto the
**LiveKit Agents** framework (Python), keeping Gemini Live on Vertex AI.

## Status
Branch: `feat/livekit-agent` (from `master`). Implementation docs: [agent/README.md](../agent/README.md).

| Milestone | Status | Notes |
|---|---|---|
| M0 Spike | 🟡 code done | Console smoke run connects to Gemini. Pending: spoken test incl. a search-grounded question. |
| M1 Token server + frontend | ⬜ | Needs LiveKit Cloud creds in `agent/.env`. |
| M2 Session lifecycle | ⬜ | |
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
