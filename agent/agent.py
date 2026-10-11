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

from google.genai import types
from livekit.agents import Agent, AgentServer, AgentSession, JobContext, cli
from livekit.plugins import google

from config import (
    AGENT_NAME,
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


def build_realtime_model() -> google.realtime.RealtimeModel:
    """Gemini Live model with the same voice/VAD/transcription as backend/."""
    return google.realtime.RealtimeModel(
        model=MODEL_ID,
        vertexai=True,
        project=GOOGLE_CLOUD_PROJECT,
        location=GOOGLE_CLOUD_LOCATION,
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
    """Dispatch metadata set by the token server: {persona, name, limit_s}."""
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
    ctx.shutdown(reason="session budget")


@server.rtc_session(agent_name=AGENT_NAME)
async def entrypoint(ctx: JobContext):
    meta = read_job_metadata(ctx)
    persona = load_persona(meta.get("persona") or DEFAULT_PERSONA)
    limit_s = float(meta.get("limit_s") or SESSION_BUDGET_S)
    logger.info(
        "room %s: job started (persona=%s, limit=%ss)", ctx.room.name, persona.id, limit_s
    )

    session = AgentSession(llm=build_realtime_model())

    # Per-turn transcript + latency report (full metrics parity is M3).
    @session.on("conversation_item_added")
    def _on_item(ev):
        item = ev.item
        if getattr(item, "role", None) in ("user", "assistant"):
            logger.info(
                "room %s: %s: %r metrics=%s",
                ctx.room.name, item.role, item.text_content, dict(item.metrics),
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
