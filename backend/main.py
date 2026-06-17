"""
FastAPI WebSocket backend for Gemini Live Translation Assistant.
Bridges a React frontend to Google's Gemini Live streaming API via WebSocket.
"""

import asyncio
import base64
import json
import logging
import time
import traceback

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from google import genai
from google.genai import types

from config import (
    GOOGLE_CLOUD_PROJECT,
    GOOGLE_CLOUD_LOCATION,
    MODEL_ID,
    INPUT_SAMPLE_RATE,
    RESPONSE_MODALITIES,
    VOICE_NAME,
    VAD_START_OF_SPEECH_SENSITIVITY,
    VAD_END_OF_SPEECH_SENSITIVITY,
    VAD_PREFIX_PADDING_MS,
    VAD_SILENCE_DURATION_MS,
    DEFAULT_SYSTEM_INSTRUCTION,
    AI_GENDER,
    SUPPORTED_LANGUAGES,
    WEBSOCKET_HOST,
    WEBSOCKET_PORT,
    CORS_ORIGINS,
)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="Gemini Live Translation Assistant")

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

client = genai.Client(
    vertexai=True,
    project=GOOGLE_CLOUD_PROJECT,
    location=GOOGLE_CLOUD_LOCATION,
)


def build_live_config(system_instruction: str) -> types.LiveConnectConfig:
    start_sensitivity = getattr(
        types.StartSensitivity, VAD_START_OF_SPEECH_SENSITIVITY
    )
    end_sensitivity = getattr(
        types.EndSensitivity, VAD_END_OF_SPEECH_SENSITIVITY
    )

    return types.LiveConnectConfig(
        response_modalities=RESPONSE_MODALITIES,
        speech_config=types.SpeechConfig(
            voice_config=types.VoiceConfig(
                prebuilt_voice_config=types.PrebuiltVoiceConfig(
                    voice_name=VOICE_NAME
                )
            )
        ),
        realtime_input_config=types.RealtimeInputConfig(
            automatic_activity_detection=types.AutomaticActivityDetection(
                disabled=False,
                start_of_speech_sensitivity=start_sensitivity,
                end_of_speech_sensitivity=end_sensitivity,
                prefix_padding_ms=VAD_PREFIX_PADDING_MS,
                silence_duration_ms=VAD_SILENCE_DURATION_MS,
            )
        ),
        input_audio_transcription=types.AudioTranscriptionConfig(),
        output_audio_transcription=types.AudioTranscriptionConfig(),
        system_instruction=system_instruction,
    )


async def send_json(ws: WebSocket, message: dict):
    try:
        await ws.send_json(message)
    except Exception:
        pass


async def receive_from_client(ws: WebSocket, session):
    """Read audio from the frontend and forward to Gemini. Runs until WebSocket closes."""
    try:
        while True:
            raw = await ws.receive_text()
            msg = json.loads(raw)

            if msg.get("type") == "audio":
                audio_bytes = base64.b64decode(msg.get("data", ""))
                await session.send_realtime_input(
                    audio=types.Blob(
                        data=audio_bytes,
                        mime_type=f"audio/pcm;rate={INPUT_SAMPLE_RATE}",
                    )
                )
            elif msg.get("type") == "stop":
                logger.info("Client requested stop")
                break
    except WebSocketDisconnect:
        logger.info("Client WebSocket disconnected")
    except Exception as e:
        logger.error("receive_from_client error: %s\n%s", e, traceback.format_exc())


async def receive_from_gemini(ws: WebSocket, session):
    """Read responses from Gemini and forward to the frontend.

    session.receive() yields responses for one turn then exhausts.
    We re-call it in a loop so subsequent turns are picked up.
    """
    try:
        # First-turn-only server-side time-to-first-audio. We anchor to the most
        # recent input-transcription (Gemini's "finished hearing the user" proxy,
        # i.e. end-of-speech) and stop at the first audio byte of the session.
        # Sent to the client once so the dashboard can compare it against the
        # client-measured number; the gap approximates the client<->server hop.
        last_input_ts = None
        server_first_audio_sent = False
        while True:
            async for response in session.receive():
                sc = response.server_content
                if sc is None:
                    continue

                if sc.input_transcription and sc.input_transcription.text:
                    last_input_ts = time.perf_counter()
                    await send_json(ws, {
                        "type": "input_transcript",
                        "text": sc.input_transcription.text,
                    })

                if sc.model_turn:
                    for part in sc.model_turn.parts:
                        if part.inline_data:
                            if not server_first_audio_sent and last_input_ts is not None:
                                server_first_audio_ms = round(
                                    (time.perf_counter() - last_input_ts) * 1000, 1
                                )
                                server_first_audio_sent = True
                                logger.info(
                                    "Server first audio byte %.1f ms after end of user speech",
                                    server_first_audio_ms,
                                )
                                await send_json(ws, {
                                    "type": "server_first_audio",
                                    "latency_ms": server_first_audio_ms,
                                })
                            audio_b64 = base64.b64encode(
                                part.inline_data.data
                            ).decode("utf-8")
                            await send_json(ws, {
                                "type": "audio_output",
                                "data": audio_b64,
                            })

                if sc.output_transcription and sc.output_transcription.text:
                    await send_json(ws, {
                        "type": "output_transcript",
                        "text": sc.output_transcription.text,
                    })

                if sc.turn_complete:
                    await send_json(ws, {"type": "turn_complete"})

                if sc.interrupted:
                    await send_json(ws, {"type": "interrupted"})
    except Exception as e:
        logger.error("receive_from_gemini error: %s\n%s", e, traceback.format_exc())
        await send_json(ws, {"type": "error", "message": str(e)})


@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    await ws.accept()
    logger.info("WebSocket client connected")

    try:
        setup_raw = await ws.receive_text()
        setup_msg = json.loads(setup_raw)

        if setup_msg.get("type") != "setup":
            await send_json(ws, {"type": "error", "message": "Expected setup message"})
            await ws.close()
            return

        system_instruction = DEFAULT_SYSTEM_INSTRUCTION.format(ai_gender=AI_GENDER)

        logger.info("Setup: Buddy persona (ai_gender=%s)", AI_GENDER)

        config = build_live_config(system_instruction)

        # Measure the Gemini setup handshake: from initiating live.connect()
        # (which emits the `setup` message) until the session is established
        # (i.e. when we can send `setup_complete` to the client).
        connect_start = time.perf_counter()
        async with client.aio.live.connect(model=MODEL_ID, config=config) as session:
            setup_latency_ms = round((time.perf_counter() - connect_start) * 1000, 1)
            logger.info("Gemini setup_complete in %.1f ms", setup_latency_ms)
            await send_json(ws, {
                "type": "setup_complete",
                "setup_latency_ms": setup_latency_ms,
            })

            sender = asyncio.create_task(
                receive_from_client(ws, session), name="sender"
            )
            receiver = asyncio.create_task(
                receive_from_gemini(ws, session), name="receiver"
            )

            done, pending = await asyncio.wait(
                [sender, receiver], return_when=asyncio.FIRST_COMPLETED
            )

            for task in done:
                logger.info("Task '%s' finished first", task.get_name())
                if task.exception():
                    logger.error(
                        "Task '%s' raised: %s", task.get_name(), task.exception()
                    )

            for task in pending:
                task.cancel()
            await asyncio.gather(*pending, return_exceptions=True)

    except WebSocketDisconnect:
        logger.info("Client disconnected")
    except Exception as e:
        logger.error("WebSocket error: %s\n%s", e, traceback.format_exc())
        await send_json(ws, {"type": "error", "message": str(e)})
    finally:
        logger.info("WebSocket session ended")
        try:
            await ws.close()
        except Exception:
            pass


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.get("/languages")
async def languages():
    return {"languages": SUPPORTED_LANGUAGES}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host=WEBSOCKET_HOST, port=WEBSOCKET_PORT)
