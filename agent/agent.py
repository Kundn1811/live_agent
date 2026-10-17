"""
Sparrow voice agent on LiveKit Agents, backed by Gemini Live (Vertex AI).

LiveKit owns the transport (WebRTC audio in/out, transcripts over text streams)
and the google plugin owns the Gemini session — including resumption: it keeps
the latest handle and reconnects on go_away, replacing backend/'s
ResumableSession.

Run:  python agent.py dev      (registers with LiveKit Cloud from agent/.env)
      python agent.py console  (local mic/speaker, no LiveKit room needed)
"""

import asyncio
import json
import logging
import os
import time

from google.genai import types
from livekit.agents import Agent, AgentServer, AgentSession, JobContext, cli
from livekit.plugins import google

from config import (
    AGENT_NAME,
    BACKEND_GEMINI_API,
    GEMINI_API_KEY,
    GEMINI_API_MODEL_ID,
    GOOGLE_CLOUD_LOCATION,
    GOOGLE_CLOUD_PROJECT,
    MODEL_ID,
    SESSION_BUDGET_S,
    VAD_END_OF_SPEECH_SENSITIVITY,
    VAD_PREFIX_PADDING_MS,
    VAD_SILENCE_DURATION_MS,
    VAD_START_OF_SPEECH_SENSITIVITY,
    VOICE_NAME,
)
from personas import DEFAULT_PERSONA, load_persona

logger = logging.getLogger("sparrow")

# Also write our own lines and LiveKit's INFO+ to agent/agent.log (gitignored, plain
# text, no colour codes) so a run can be shared without copying the terminal.
_file_log = logging.FileHandler(
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "agent.log"), encoding="utf-8"
)
_file_log.setLevel(logging.INFO)
_file_log.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s %(message)s"))
for _name in ("sparrow", "livekit.agents"):
    logging.getLogger(_name).addHandler(_file_log)


def build_realtime_model(backend: str) -> google.realtime.RealtimeModel:
    """Gemini Live model with the same voice/VAD/transcription as backend/.

    `backend` is BACKEND_GEMINI_API (free tier, public route) or BACKEND_VERTEX.
    Anything else counts as Vertex, so a missing flag never lands private
    conversations on the free tier.
    """
    if backend == BACKEND_GEMINI_API:
        if not GEMINI_API_KEY:
            raise RuntimeError("GEMINI_API_KEY is not set (needed for the public route)")
        target = {"model": GEMINI_API_MODEL_ID, "vertexai": False, "api_key": GEMINI_API_KEY}
    else:
        target = {
            "model": MODEL_ID,
            "vertexai": True,
            "project": GOOGLE_CLOUD_PROJECT,
            "location": GOOGLE_CLOUD_LOCATION,
        }
    return google.realtime.RealtimeModel(
        **target,
        voice=VOICE_NAME,
        modalities=[types.Modality.AUDIO],
        realtime_input_config=types.RealtimeInputConfig(
            automatic_activity_detection=types.AutomaticActivityDetection(
                disabled=False,
                start_of_speech_sensitivity=getattr(
                    types.StartSensitivity, VAD_START_OF_SPEECH_SENSITIVITY
                ),
                end_of_speech_sensitivity=getattr(
                    types.EndSensitivity, VAD_END_OF_SPEECH_SENSITIVITY
                ),
                prefix_padding_ms=VAD_PREFIX_PADDING_MS,
                silence_duration_ms=VAD_SILENCE_DURATION_MS,
            )
        ),
        input_audio_transcription=types.AudioTranscriptionConfig(),
        output_audio_transcription=types.AudioTranscriptionConfig(),
    )


class Sparrow(Agent):
    def __init__(self, instructions: str) -> None:
        super().__init__(
            instructions=instructions,
            # Google Search grounding. On Vertex only one tool kind is allowed
            # per session — fine while Sparrow has no function tools.
            tools=[google.tools.GoogleSearch()],
        )


server = AgentServer()

# Time left when the agent says goodbye before the hard stop.
WRAP_UP_LEAD_S = 20.0


def read_job_metadata(ctx: JobContext) -> dict:
    """Dispatch metadata set by the token server: {persona, name, limit_s, max_turns, backend}."""
    try:
        meta = json.loads(ctx.job.metadata or "{}")
        return meta if isinstance(meta, dict) else {}
    except json.JSONDecodeError:
        return {}


async def enforce_budget(ctx: JobContext, session: AgentSession, limit_s: float) -> None:
    """End the session at its limit, with a short spoken goodbye just before."""
    await asyncio.sleep(max(limit_s - WRAP_UP_LEAD_S, 0))
    try:
        session.generate_reply(
            instructions="Time is almost up. Say a warm one-sentence goodbye now."
        )
    except Exception:
        logger.exception("room %s: wrap-up failed", ctx.room.name)
    await asyncio.sleep(WRAP_UP_LEAD_S)
    logger.info("room %s: session budget reached", ctx.room.name)
    await end_session(ctx, "session budget")


async def end_session(ctx: JobContext, reason: str) -> None:
    """Close the room for everyone, then stop the job.

    Shutting down the agent alone leaves the visitor alone in the room, and the
    browser only reacts to its own disconnect, so it would sit in "Ready" forever.
    """
    try:
        await ctx.delete_room()
    except Exception:
        logger.exception("room %s: delete_room failed", ctx.room.name)
    ctx.shutdown(reason=reason)


async def end_after_last_turn(
    ctx: JobContext,
    session: AgentSession,
    answered: asyncio.Event,
    answer_started: asyncio.Event,
) -> None:
    """Public turn cap: let the reply to the last allowed turn finish, then say goodbye and end."""
    # The user's transcript can land after the reply already started (or even ended),
    # so first work out whether an answer is still coming.
    if session.agent_state not in ("speaking", "thinking") and not answer_started.is_set():
        await asyncio.sleep(3)
    if session.agent_state in ("speaking", "thinking") or answer_started.is_set():
        try:
            # Replies can run 20+ s; the cap only guards against a stuck state.
            await asyncio.wait_for(answered.wait(), timeout=90)
        except asyncio.TimeoutError:
            logger.warning("room %s: last reply never finished", ctx.room.name)
    logger.info("room %s: turn limit reached, saying goodbye", ctx.room.name)
    # Stop sending mic audio so room/fan noise cannot trigger Gemini's server-side
    # VAD and cut the goodbye (allow_interruptions=False is unsupported with it).
    session.input.set_audio_enabled(False)
    try:
        # Gemini sometimes cuts this reply after a word or two; retry once only
        # if it was cut very short (a nearly-finished goodbye is not repeated).
        for attempt in (1, 2):
            t0 = time.monotonic()
            handle = session.generate_reply(
                instructions=(
                    "That was the visitor's last free turn. Say a warm one-sentence goodbye "
                    "and tell them they can ask Kundan for full access."
                )
            )
            # Bounded: the session must end even if the goodbye never plays.
            await asyncio.wait_for(handle.wait_for_playout(), timeout=20)
            took = time.monotonic() - t0
            logger.info(
                "room %s: goodbye attempt %d done (interrupted=%s, %.1fs)",
                ctx.room.name, attempt, handle.interrupted, took,
            )
            if not (handle.interrupted and took < 4):
                break
    except Exception:
        logger.exception("room %s: turn-limit goodbye failed", ctx.room.name)
    finally:
        await end_session(ctx, "turn limit")


@server.rtc_session(agent_name=AGENT_NAME)
async def entrypoint(ctx: JobContext):
    meta = read_job_metadata(ctx)
    persona = load_persona(meta.get("persona") or DEFAULT_PERSONA)
    limit_s = float(meta.get("limit_s") or SESSION_BUDGET_S)
    max_turns = int(meta.get("max_turns") or 0)  # 0 = unlimited (private routes)
    backend = meta.get("backend") or ""
    logger.info(
        "room %s: job started (persona=%s, limit=%ss, max_turns=%s, backend=%s)",
        ctx.room.name, persona.id, limit_s, max_turns or "none", backend or "vertex",
    )

    session = AgentSession(llm=build_realtime_model(backend))

    # Turn cap lives here (server side), not in the browser.
    user_turns = 0
    closing = False
    answered = asyncio.Event()  # the agent finished answering after the last allowed turn
    answer_started = asyncio.Event()  # ...and started to
    closer: list[asyncio.Task] = []  # keeps the closing task referenced

    @session.on("agent_state_changed")
    def _on_state(ev):
        if not closing:
            return
        if ev.new_state == "speaking":
            answer_started.set()
        elif ev.old_state == "speaking":
            answered.set()

    # Per-turn transcript + latency report (full metrics parity is M3).
    @session.on("conversation_item_added")
    def _on_item(ev):
        nonlocal user_turns, closing
        item = ev.item
        if getattr(item, "role", None) in ("user", "assistant"):
            logger.info(
                "room %s: %s: %r metrics=%s",
                ctx.room.name, item.role, item.text_content, dict(item.metrics),
            )
        if max_turns and getattr(item, "role", None) == "user":
            user_turns += 1
            if user_turns >= max_turns and not closing:
                closing = True
                logger.info("room %s: last allowed turn (%d)", ctx.room.name, user_turns)
                closer.append(
                    asyncio.create_task(
                        end_after_last_turn(ctx, session, answered, answer_started)
                    )
                )

    await session.start(room=ctx.room, agent=Sparrow(persona.instructions))
    logger.info("room %s: session started", ctx.room.name)

    # User-speaks-first by default (same as the WS flow); a persona may greet first.
    if persona.greeting:
        session.generate_reply(instructions=persona.greeting)

    budget = asyncio.create_task(enforce_budget(ctx, session, limit_s))
    ctx.add_shutdown_callback(lambda: _cancel(budget))


async def _cancel(task: asyncio.Task) -> None:
    task.cancel()


if __name__ == "__main__":
    cli.run_app(server)
