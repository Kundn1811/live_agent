"""
Sparrow voice agent on LiveKit Agents, backed by Gemini Live (Vertex AI).

LiveKit owns the transport (WebRTC audio in/out, transcripts over text streams)
and the google plugin owns the Gemini session — including resumption: it keeps
the latest handle and reconnects on go_away, replacing backend/'s
ResumableSession.

Run:  python agent.py dev      (registers with LiveKit Cloud from agent/.env)
      python agent.py console  (local mic/speaker, no LiveKit room needed)
"""

import logging

from google.genai import types
from livekit.agents import Agent, AgentServer, AgentSession, JobContext, cli
from livekit.plugins import google

from config import (
    AGENT_NAME,
    AI_GENDER,
    DEFAULT_SYSTEM_INSTRUCTION,
    GOOGLE_CLOUD_LOCATION,
    GOOGLE_CLOUD_PROJECT,
    MODEL_ID,
    VAD_END_OF_SPEECH_SENSITIVITY,
    VAD_PREFIX_PADDING_MS,
    VAD_SILENCE_DURATION_MS,
    VAD_START_OF_SPEECH_SENSITIVITY,
    VOICE_NAME,
)

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
    def __init__(self) -> None:
        super().__init__(
            instructions=DEFAULT_SYSTEM_INSTRUCTION.format(ai_gender=AI_GENDER),
            # Google Search grounding. On Vertex only one tool kind is allowed
            # per session — fine while Sparrow has no function tools.
            tools=[google.tools.GoogleSearch()],
        )


server = AgentServer()


@server.rtc_session(agent_name=AGENT_NAME)
async def entrypoint(ctx: JobContext):
    logger.info("room %s: job started", ctx.room.name)

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

    # User-speaks-first, same as the WS flow: no generate_reply() greeting.
    await session.start(room=ctx.room, agent=Sparrow())
    logger.info("room %s: session started", ctx.room.name)


if __name__ == "__main__":
    cli.run_app(server)
