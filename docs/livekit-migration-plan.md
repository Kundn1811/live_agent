# LiveKit Migration Plan

Move the Sparrow voice agent from the custom FastAPI WebSocket relay onto the
**LiveKit Agents** framework (Python), keeping Gemini Live on Vertex AI.

> **Resuming in a new session?** Read "Handoff context" right below, then "Status".
> Convention: project context, decisions and next steps are kept in THIS file.

## Handoff context (read first)

**Owner:** Kundan. Sparrow = voice agent on Gemini Live (Vertex AI), now being moved to LiveKit Agents.

**Product direction (decided 2026-10-11)**
- **LiveKit is the default path.** Only `agent/` + `frontend/` get deployed. `backend/` (old FastAPI WS relay + warm pool + resumable wrapper) is NOT deployed, to save server resources; it is **kept in the repo permanently** (decided 2026-10-11: no deletion) and stays reachable locally at the `/legacy` route, but it gets no deploy scripts/Dockerfile. Do not modify it.
- **Terminology:** "backend" in the deploy plan = the LiveKit **agent worker + token server** (`agent/`), NOT the old `backend/` folder.
- **Frontend routes:** `/` public Sparrow (LiveKit) · `/private` access-code gate (LiveKit only) · `/legacy` old WS backend (needs `backend/` on :8000). Any other path shows a "Page not found" page (App never mounts). `?transport=ws|livekit` overrides the public route. Vercel will need an SPA rewrite so `/private` and `/legacy` load the app.
- **Dynamic persona injection (built, untested live):** a credential code → persona. `POST /token/private {code}` checks `agent/codes.json`; the room is dispatched with metadata `{persona, name, limit_s}` (ids only, prompt text never leaves the server). `agent.py` loads `personas/<id>.md`, may greet first, and ends the session at `limit_s` (default 10 min, goodbye line 20 s before). `system_instruction` is immutable per session, which is fine: one room = one session, no warm pool. Details: [agent/README.md](../agent/README.md).
- **Persona 1 — `partner` (built, private):** a personal persona for Kundan's partner, speaking on his behalf: short replies (low patience), one tiny healthy-habit step per turn, always says it is Sparrow his assistant (never claims to be him or human), safety rules kept. **All personal details (names, health context, wording) live only in local gitignored files — never put them in git, docs, code or CLAUDE.md:** `agent/personas/partner.md`, `agent/personas/partner.greeting.txt`, `agent/codes.json`. Templates (committed): `persona.example.md`, `persona.example.greeting.txt`, `codes.example.json`. Back these files up outside git; they are not recoverable from the repo.
  - Same mechanism later serves **family**: one code per person + a small persona/profile each. Build family personas only after the partner test works smoothly. Same rule: local gitignored files only.
- **Persona 2 — `interviewer` (NOT started; after v1 + deploy; local only, never deployed):** Kundan gives the question list + interview context; it also generates follow-up questions by digging into his answers; goal = make him interview-ready. Token design: **input-heavy, output-light** — all context in the system prompt, replies ≤ 2 sentences, one question per turn, no answering for him, feedback only on request/at end. Needs a longer VAD silence (~1.5–2 s) so it does not cut him off. Optional later: log answers + end-of-session scorecard.
- **Base Sparrow** stays the default persona (`DEFAULT_SYSTEM_INSTRUCTION` in `config.py`).

**Order of work**
1. ~~M0/M1/M1b~~ done and user-tested locally (public `/` + `/private` + partner persona).
2. Optional hardening before deploy: M2 (resumption >10 min, clean shutdown, logging) and M3 (latency numbers). M4 (recorder/noise) later.
3. **Pre-deploy prerequisites (all three must be done first):**
   - **P1 Hosting choice** — see "Deploy prerequisites" below.
   - **P2 Credentials** — see below. **Blocker: current local setup uses the employer GCP project/key. Must be replaced before any deploy.**
   - **P3 Public usage gate** — 3 turns per visitor on `/` only; `/private` is excluded (code + 10-min limit only). See below.
4. **Deploy sequence (test each step before the next):**
   1. Deploy the backend (agent worker + token server).
   2. Test the deployed backend from the **local** frontend (point `VITE_TOKEN_URL` at it).
   3. Deploy the frontend (Vercel; add SPA rewrite so `/private` and `/legacy` resolve, `CORS_ORIGINS` = the Vercel URL).
   4. Test the deployed frontend end to end (`/`, gate, `/private`).
   5. Only then send the link to her / family.
5. Interviewer persona (local only, never deployed). 6. Inject into the portfolio.

**Model change (decided 2026-10-11):** `gemini-live-2.5-flash-native-audio` retires **Dec 13, 2026** (Vertex page). Move to Gemini 3.8 Live before then; read Google's "Migrate from Gemini 2.5 Flash Live API to Gemini 3.8 Live" guide first (exact id, regions, API changes; unconfirmed whether 3.8 Live is on Vertex). Plan: superseded by the per-route backend flag (see NEXT SESSION PLAN step 1, built 2026-10-17): public route on the Gemini API free tier, private on Vertex. The Vertex id still has to move to Gemini 3.8 Live before Dec 13.

**Next session starts here (2026-10-11):** P2 + P3 done. **P1 hosting is now decided** (agent on LiveKit Cloud Build plan, token server on Cloud Run, frontend on Vercel; pipeline files are written but untested, see "Deploy pipeline" below and [deploy-setup.md](deploy-setup.md)). Remaining before deploy: do the one-time setup in deploy-setup.md, decide the `/private`-in-cloud gap, merge to `master`. Then the move to Gemini 3.8 Live before Dec 13 (the `MODEL_ID`/`USE_VERTEX` switch idea became the per-route backend flag). Emergency stop for spend: Billing → Disable billing (phone browser, desktop site). Run the agent with `agent/.venv`, restart agent + token server after code changes.

**Known issues parked:** noisy mic breaks the perceived-latency metric and delays the real response (re-test in M4 with WebRTC NS/AEC). `google-genai` pin. Cold-connect latency (M3).

## Status
Branch: `feat/livekit-agent` (from `master`). Implementation docs: [agent/README.md](../agent/README.md). Nothing from M1 onward is committed yet.

| Milestone | Status | Notes |
|---|---|---|
| M0 Spike | ✅ works (2026-10-11) | Console smoke run connects to Gemini. Pending: spoken test incl. a search-grounded question. |
| M1 Token server + frontend | ✅ works (2026-10-11, user-tested) | `token_server.py` + `useLiveKitSession`; LiveKit is now the default transport (`/`), old WS at `/legacy`. Build passes, `/token` verified offline. Pending: LiveKit Cloud key/secret in `agent/.env`, then a live conversation test (transcripts, barge-in). Metrics (perceived/server first-audio) are not wired on this transport yet (M3). |
| M1b Personas + private route | ✅ works (2026-10-11, user-tested; partner persona to be sent to her) | `personas.py`, `partner` persona, `POST /token/private` (codes, 5-fail throttle), `/private` code gate, per-session time limit + goodbye. Token server verified offline (200/401/429, dispatch metadata); frontend build passes. Headless end-to-end run passed (code → partner persona loaded → agent-first greeting spoken). Pending: a human voice test. **After pulling code changes, restart BOTH `agent.py dev` and `token_server.py` — neither hot-reloads reliably (a stale token server gave 404 on `/token/private`).** `AGENT_NAME` env overrides the agent name, so a second worker can be tested without stealing jobs from the main one. |
| M2 Session lifecycle | 🟡 partly | Budget timer done (in `agent.py`: `enforce_budget`). Still: verify resumption across `go_away` (>10 min run), clean shutdown on client leave, per-session logging. |
| M3 Metrics + A/B | ⬜ | |
| M4 Recorder + noise | ⬜ | |
| M5 Docs cleanup | ⬜ | `backend/` is kept (no deletion). |
| Deploy prerequisites P1–P3 | 🟡 | **P2 done (2026-10-11):** personal project `adk-rag-464418` + own key in `agent/.env`, Live session verified; paid by the Google AI Pro monthly credits (6 × ₹959.89 on the billing account; ₹500 budget alert only, no hard stop; emergency stop = Billing → Disable billing, via phone browser desktop site). **P3 done and live-tested (2026-10-11):** per-IP/global daily caps (429 verified), 3-turn cap ends the session with a spoken goodbye (mic muted during the goodbye so noise can't cut it), room is deleted at the end so the browser disconnects, `agent/agent.log` added. Before deploy: set `TRUST_PROXY=1` and review `PUBLIC_*` limits. P1 hosting still open. |
| Deploy: backend → local-frontend test → frontend → test → send link | ⬜ | See Handoff context, order of work. |

## Decisions
- **LiveKit server:** LiveKit Cloud (free tier). Creds in `agent/.env`:
  `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`.
- **Coexistence:** side-by-side. New `agent/` dir; `backend/` stays untouched
  and is kept permanently (not deployed).
- **Frontend:** adapt the existing React app (swap transport + audio hooks,
  keep the dashboard). Old WS mode stays selectable at `/legacy`.

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

### M5 — Docs cleanup (dropped deletion)
`backend/` is **not** deleted (decided 2026-10-11). Remaining: update `CLAUDE.md`/README run steps (agent worker + token server + frontend) and remove vestigial translation UI only if it is in the way. Deployment itself is tracked under "Deploy prerequisites" below.

## Deploy prerequisites (open decisions, 2026-10-11)

**P1 — Where to host the agent worker + token server (DECIDED 2026-10-11: agent on LiveKit Cloud Build plan, token server on Cloud Run, frontend on Vercel free; pipeline + one-time setup in [deploy-setup.md](deploy-setup.md))**
- The worker is a long-lived outbound connection to LiveKit Cloud, so it needs an always-on container, not scale-to-zero.
- *Option A — LiveKit Cloud agent hosting (`lk agent deploy`):* free Build plan includes one agent deployment, 5 concurrent sessions, ~1,000 agent session minutes, hard cap (service stops at the limit); cold starts of 10–20 s before the agent joins. Needs a Dockerfile; Google creds supplied as secrets. Token server still needs a small host (or move token minting to a Vercel serverless function).
- *Option B — Cloud Run:* needs min-instances ≥ 1 and CPU always allocated (otherwise throttled/scaled to zero; not confirmed in LiveKit docs, verify). Gets Google auth for free via an attached service account (no key file), which also fixes P2. Billable; may be covered by GCP credits (unverified).
- *Option C — Fly.io / Railway / small VPS:* simple always-on container; needs a key file as a secret.
- ~~Leaning (to confirm with user): decide after P2~~ Decided as above. A LiveKit-hosted agent has no attached Google service account, so Gemini auth uses a personal service-account key (Vertex AI User) passed as the secret `GOOGLE_CREDENTIALS_B64` (base64 of the key JSON); `agent/config.py` writes it to a temp file and sets `GOOGLE_APPLICATION_CREDENTIALS`. Local runs still use the key-file path in `.env`.

**Re-checked 2026-10-11 against official pages** ([Cloud Run pricing](https://cloud.google.com/run/pricing), [LiveKit pricing](https://livekit.com/pricing)): Cloud Run instance-based $0.000018/vCPU-s + $0.000002/GiB-s (0.5 vCPU/1 GiB = about $28/mo, about $23 after free tier; 1 vCPU/2 GiB about $57 / $52). Idle min-instance rate $0.0000025/vCPU-s and GiB-s (0.5 vCPU + 512 MiB kept warm = about $6.5/mo; 0.25 vCPU + 256 MiB = about $3). LiveKit Build/Ship numbers below confirmed. NOT confirmed: Gemini per-minute price (no official page found for this model id), Build's hard cap, and whether the free tier applies to always-on billing. User says the GCP credit is $10, not the ~$65 below; Gemini on Vertex is billed to the same project and can use most of it.

**P1 cost findings (2026-10-11, estimates; verify before relying):**
- LiveKit-hosted agent on Build: $0, 1,000 agent-session min, 5 concurrent, 1 deployment, cold start. Ship $50/mo: 5,000 min incl, then $0.01/min, 20 concurrent. Not payable with GCP credits.
- Cloud Run worker (always-on, instance-based billing): about $25 (0.5 vCPU/1 GiB) to $53 (1 vCPU/2 GiB) per month, rates unverified; payable with GCP credits (~$65 + ~$11/mo accrual). Transport still runs on LiveKit Cloud: agent + user = 2 WebRTC min per session-min, so Build's 5,000 WebRTC min = ~2,500 session-min, then Ship $50.
- Break-even: Cloud Run beats LiveKit-hosted only above roughly 7,500-10,000 session-min/month. Below that LiveKit-hosted is cheaper.
- Token server holds in-memory gate counters, so it needs ONE always-on instance (Cloud Run request-based, min 1, max 1; about $3-6/mo by size, see re-check above), not Vercel serverless and not scale-to-zero. Scale-to-zero would need the counters moved to an external store (e.g. free Redis).
- Gemini cost is the same on both: roughly $0.02-0.025 per conversation minute.
- Unconfirmed: whether self-hosted workers pay agent-session minutes (sources say no), and what Build does past its limits (plan notes say hard cap).

**Deploy pipeline (built 2026-10-11, untested, nothing committed yet)**
- One repo, deploy branch `master`. Push to `master` deploys per part by path filter; manual **Run workflow** also works. Frontend: Vercel's GitHub link (root dir `frontend`, `frontend/vercel.json` SPA rewrite).
- Files: `.github/workflows/deploy-agent.yml` (`livekit/deploy-action@v2.12.2` (no floating `v2` tag exists), needs `agent/livekit.toml` from a one-time `lk agent create`), `.github/workflows/deploy-token-server.yml` (Workload Identity Federation, no key file; `gcloud run deploy --source`, min=max=1 instance), `agent/Dockerfile` + `agent/.dockerignore` (agent image), `agent/Dockerfile.token` + `agent/requirements-token.txt` (token server image), `docs/deploy-setup.md` (one-time commands, secrets list, first-deploy order).
- Secret map: LiveKit key/secret/url → token server (Cloud Run Secret Manager) and agent (injected by LiveKit); Gemini key → agent only (`AGENT_SECRET_LIST` in GitHub); codes.json → token server only; frontend gets only public `VITE_TOKEN_URL`.
- **`/private` in the cloud (built 2026-10-17):** `codes.json` goes to Secret Manager `sparrow-codes` (env `CODES_JSON` on the token server; a local file wins). Persona files go to LiveKit agent secrets `PERSONA_<ID>_B64` / `PERSONA_<ID>_GREETING_B64` (base64; a local file wins). The token server only checks that the persona id is well formed (`is_valid_id`); the agent falls back to Sparrow if it has no such persona.
- Not tested: no Docker/gcloud/lk on the dev machine. Deploys only fire after the feature branch is merged into `master`.

**NEXT SESSION PLAN (decided 2026-10-11 night). UPDATE 2026-10-17: the user's Gemini API key is on a billed project (no free tier found), so step 1's saving is gone. The public route now defaults to Vertex (`PUBLIC_BACKEND` env on the token server, default `vertex`); the Gemini API path stays as an opt-in for a free-tier key. STATUS 2026-10-17: steps 1-4 are BUILT in code and docs, tested offline only (uncommitted until the user says); step 1 still needs a live voice test with a real `GEMINI_API_KEY` (voice, Google Search tool, resumption, goodbye on the Gemini API); steps 5-6 are the user's / not done.**
Context: expected traffic is 1-2 visitors a day. Gemini API pricing page (ai.google.dev, 2026-10-11): audio in $3 / audio out $12 per 1M tokens (about $0.005 + $0.018 per minute); the native-audio Live models are **free of charge on the free tier** (rate limits not listed, free-tier content may be used by Google to improve products). Vertex pricing page would not load; assume the same rates, unverified.
1. **Public route on a Gemini API key (free tier), private route on Vertex.** The token server marks each mint with a backend flag in the dispatch metadata (`gemini_api` for `/token`, `vertex` for `/token/private`); `build_realtime_model()` in `agent.py` picks `vertexai=False` + `GEMINI_API_KEY` or the current Vertex setup. Model id differs on the API: `gemini-2.5-flash-native-audio-preview-12-2025` (check it is still current; the Vertex id retires Dec 13, 2026, move to Gemini 3.8 Live, same price). Supersedes the open `MODEL_ID` / `USE_VERTEX` switch item. **Built:** `config.py` (`GEMINI_API_MODEL_ID`, `GEMINI_API_KEY`, `BACKEND_*`), `build_realtime_model(backend)` in `agent.py` (a missing or unknown flag means Vertex, so private never lands on the free tier; a missing key on the public route raises), token server sets `backend` in the dispatch metadata. Verified offline only (metadata, model ids). Test locally before deploying: voice, Google Search tool, resumption and goodbye behaviour may differ. New key from AI Studio, stored as a LiveKit agent secret; never in git. Privacy: private/partner conversations must NOT use the free tier.
2. **`/private` in the cloud via secrets.** `codes.json` is read by the **token server**, not the agent, so it goes in Cloud Run **Secret Manager** (not LiveKit secrets). Persona files (`partner.md`, greeting) are read by the **agent**, so they go in **LiveKit agent secrets** (base64). **Built:** env fallbacks in `personas.py` and `token_server.py`; `is_known()` replaced by `is_valid_id()` (the token server trusts the ids in `codes.json`; the agent falls back to Sparrow if a file is missing). Verified offline.
3. **Token server at the minimum size.** `--cpu 0.25 --memory 256Mi --concurrency 1 --max-instances 1` (raise memory to 512Mi if it runs out). With 1-2 visitors a day and the public route on the free tier, consider `--min-instances 0` (about $0; first visitor waits 1-3 s; in-memory gate counters reset on a cold start, acceptable). **Built:** workflow now 0.25 vCPU / 256Mi / concurrency 1 / max 1; min instances comes from GitHub variable `TOKEN_MIN_INSTANCES` (default 1). Still to decide: min 0 or 1. Note: min 0 resets the gate counters on every cold start, so with 1-2 visitors a day the per-IP and global caps would rarely bite; LiveKit Build's 1,000-minute hard cap is what a spammer would exhaust.
4. **Both addresses known before the first deploy (no second pass).** Vercel gives the project address at creation, and Cloud Run addresses follow `https://<service>-<project-number>.<region>.run.app` (verify after the first deploy). Set `VITE_TOKEN_URL` and `CORS_ORIGINS` up front, then deploy everything together. The agent needs neither (it connects out to LiveKit). `docs/deploy-setup.md` step 5 updated (built).
5. User does the one-time setup in `docs/deploy-setup.md` (GCP, `lk agent create`, Vercel, GitHub secrets), then merge to `master`, then test `/`, the gate and `/private`.
6. Update the Docs doc "Sparrow — Tech Document & Architecture" (cost: Gemini free tier on public route; secrets table) once 1-3 are built.
Glossary: `lk` = the LiveKit command-line tool, installed on the PC. `lk cloud auth` logs in; `lk agent create` registers the agent and does the first deploy and writes `agent/livekit.toml`. After that the GitHub Action does the deploys.

**P2 — Credentials (blocker)**
- Local `agent/.env` currently has `GOOGLE_CLOUD_PROJECT=lenskart-ajnalens` and a service-account key from `backend/` → **employer project/key**. Never deploy with it, and move local dev off it too.
- Needed: a **personal** GCP project with Vertex AI API enabled + billing/credits, and either (a) an attached service account on Cloud Run (no key), or (b) a new personal service-account key (role: Vertex AI User) stored as a host secret, never in git.
- Model id stays `gemini-live-2.5-flash-native-audio` (Vertex, us-central1); switching to a Gemini API key would mean a different model id, so avoid.

**P3 — Public usage gate (not built)**
- Applies to `/` (token route `GET /token`) only. `POST /token/private` is excluded: code + 10-min limit only.
- Token server: per-IP daily limit on token mints, global daily cap, return 429 with a friendly message.
- Agent: server-side 3-turn counter for the public persona (count user turns via `conversation_item_added`), then a spoken goodbye + `ctx.shutdown`. Counter must live on the server, not the browser. Visitor id = IP (+ optional cookie); no login.
- Needs persistence across restarts only if limits must survive redeploys (in-memory is fine for v1; note it resets on restart).

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
