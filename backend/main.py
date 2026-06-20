"""
FastAPI WebSocket backend for Gemini Live Translation Assistant.
Bridges a React frontend to Google's Gemini Live streaming API via WebSocket.
"""

import asyncio
import base64
import json
import logging
import os
import time
import traceback
from contextlib import asynccontextmanager

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
    POOL_SIZE,
    POOL_MAX_AGE_S,
    POOL_CHECKOUT_TIMEOUT_S,
    SESSION_BUDGET_S,
)
from session_pool import WarmPool
from resumable_session import ResumableSession

# Log to both console and backend/server.log (path-anchored so it lands next to
# this file regardless of CWD). Timestamps + per-connection ids let us trace one
# user's connect -> consume -> disconnect -> reconnect cycle and compare latencies.
LOG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "server.log")
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s.%(msecs)03d %(levelname)s %(name)s: %(message)s",
    datefmt="%H:%M:%S",
    handlers=[
        logging.StreamHandler(),
        logging.FileHandler(LOG_PATH, mode="a", encoding="utf-8"),
    ],
)
logger = logging.getLogger(__name__)

# Warm pool of pre-opened Gemini sessions, started/stopped with the app.
pool = None

# Monotonic per-connection id so each user's lifecycle is traceable in the log.
_conn_seq = 0


@asynccontextmanager
async def lifespan(app: FastAPI):
    global pool
    warm_config = build_live_config(
        DEFAULT_SYSTEM_INSTRUCTION.format(ai_gender=AI_GENDER)
    )
    pool = WarmPool(
        client=client,
        model=MODEL_ID,
        config=warm_config,
        size=POOL_SIZE,
        max_age_s=POOL_MAX_AGE_S,
        checkout_timeout_s=POOL_CHECKOUT_TIMEOUT_S,
    )
    await pool.start()
    logger.info("Warm session pool started (size=%d)", POOL_SIZE)
    try:
        yield
    finally:
        await pool.aclose()
        logger.info("Warm session pool stopped")


app = FastAPI(title="Gemini Live Translation Assistant", lifespan=lifespan)

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


def build_live_config(
    system_instruction: str, resumption_handle: str | None = None
) -> types.LiveConnectConfig:
    start_sensitivity = getattr(
        types.StartSensitivity, VAD_START_OF_SPEECH_SENSITIVITY
    )
    end_sensitivity = getattr(
        types.EndSensitivity, VAD_END_OF_SPEECH_SENSITIVITY
    )

    return types.LiveConnectConfig(
        response_modalities=RESPONSE_MODALITIES,
        # Google Search grounding so Sparrow can base health answers on current,
        # reputable sources. In us-central1 this is handled server-side; note a
        # reported regression in some regions delivers it as a client function
        # call instead (see README), which would need a search proxy to fulfill.
        tools=[types.Tool(google_search=types.GoogleSearch())],
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
        # Enabling resumption makes the server emit SessionResumptionUpdate
        # handles. A None handle starts a new session; a real handle resumes a
        # prior one — that's how we survive the ~10-min per-connection cap.
        session_resumption=types.SessionResumptionConfig(handle=resumption_handle),
        system_instruction=system_instruction,
    )


async def send_json(ws: WebSocket, message: dict):
    try:
        await ws.send_json(message)
    except Exception:
        pass


async def receive_from_client(ws: WebSocket, session, conn_id: int):
    """Read audio from the frontend and forward to Gemini. Runs until WebSocket closes."""
    first_audio_logged = False
    try:
        while True:
            raw = await ws.receive_text()
            msg = json.loads(raw)

            if msg.get("type") == "audio":
                if not first_audio_logged:
                    first_audio_logged = True
                    logger.info("conn %d: first client audio frame received", conn_id)
                audio_bytes = base64.b64decode(msg.get("data", ""))
                await session.send_realtime_input(
                    audio=types.Blob(
                        data=audio_bytes,
                        mime_type=f"audio/pcm;rate={INPUT_SAMPLE_RATE}",
                    )
                )
            elif msg.get("type") == "stop":
                logger.info("conn %d: client requested stop", conn_id)
                break
    except WebSocketDisconnect:
        logger.info("conn %d: client WebSocket disconnected", conn_id)
    except Exception as e:
        logger.error("conn %d: receive_from_client error: %s\n%s", conn_id, e, traceback.format_exc())


async def receive_from_gemini(ws: WebSocket, session, conn_id: int):
    """Read responses from Gemini and forward to the frontend.

    `session` is a ResumableSession whose receive() spans turns and reconnects,
    so we iterate it once (no outer loop) and never see go_away/resumption msgs.
    """
    try:
        # First-turn-only server-side time-to-first-audio. We anchor to the most
        # recent input-transcription (Gemini's "finished hearing the user" proxy,
        # i.e. end-of-speech) and stop at the first audio byte of the session.
        # Sent to the client once so the dashboard can compare it against the
        # client-measured number; the gap approximates the client<->server hop.
        t_recv_start = time.perf_counter()  # ~moment the session is live/ready
        last_input_ts = None
        first_input_logged = False
        server_first_audio_sent = False
        async for response in session.receive():
            sc = response.server_content
            if sc is None:
                continue

            if sc.input_transcription and sc.input_transcription.text:
                last_input_ts = time.perf_counter()
                if not first_input_logged:
                    first_input_logged = True
                    logger.info(
                        "conn %d: first input transcription (+%.0f ms since ready)",
                        conn_id, (last_input_ts - t_recv_start) * 1000,
                    )
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
                                "conn %d: server first audio %.1f ms after end-of-speech "
                                "(+%.0f ms since ready)",
                                conn_id, server_first_audio_ms,
                                (time.perf_counter() - t_recv_start) * 1000,
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


def _resume_config(handle: str) -> types.LiveConnectConfig:
    """Config to resume a conversation onto a fresh connection."""
    return build_live_config(
        DEFAULT_SYSTEM_INSTRUCTION.format(ai_gender=AI_GENDER),
        resumption_handle=handle,
    )


async def _run_session(ws: WebSocket, session, setup_latency_ms: float, warm: bool,
                       conn_id: int):
    """Send setup_complete, then pump audio both directions until a side ends."""
    logger.info("conn %d: session ready (warm=%s) in %.1f ms", conn_id, warm, setup_latency_ms)
    await send_json(ws, {
        "type": "setup_complete",
        "setup_latency_ms": setup_latency_ms,
        "warm": warm,
    })

    sender = asyncio.create_task(receive_from_client(ws, session, conn_id), name="sender")
    receiver = asyncio.create_task(receive_from_gemini(ws, session, conn_id), name="receiver")

    done, pending = await asyncio.wait(
        [sender, receiver], return_when=asyncio.FIRST_COMPLETED
    )

    for task in done:
        logger.info("conn %d: task '%s' finished first", conn_id, task.get_name())
        if task.exception():
            logger.error("conn %d: task '%s' raised: %s", conn_id, task.get_name(), task.exception())

    for task in pending:
        task.cancel()
    await asyncio.gather(*pending, return_exceptions=True)


@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    global _conn_seq
    _conn_seq += 1
    conn_id = _conn_seq
    t_accept = time.perf_counter()
    await ws.accept()
    logger.info("conn %d: WebSocket client connected", conn_id)

    try:
        setup_raw = await ws.receive_text()
        setup_msg = json.loads(setup_raw)
        logger.info(
            "conn %d: setup message received (+%.0f ms after accept)",
            conn_id, (time.perf_counter() - t_accept) * 1000,
        )

        if setup_msg.get("type") != "setup":
            await send_json(ws, {"type": "error", "message": "Expected setup message"})
            await ws.close()
            return

        # Phase 2: hand out a pre-warmed session (near-zero handshake). If the
        # pool is momentarily empty, cold-connect so we still serve the user —
        # `setup_latency_ms` then reflects the real handshake instead of ~0.
        # Either way the live session is wrapped in a ResumableSession so the
        # conversation survives the ~10-min per-connection cap.
        checkout_start = time.perf_counter()
        slot = await pool.checkout() if pool is not None else None

        if slot is not None:
            setup_latency_ms = round((time.perf_counter() - checkout_start) * 1000, 1)
            logger.info(
                "conn %d: WARM checkout -> session %d, handshake %.1f ms",
                conn_id, slot.id, setup_latency_ms,
            )

            async def _dispose_pool():
                pool.release(slot)

            session = ResumableSession(
                client, MODEL_ID, _resume_config, slot.session, _dispose_pool,
                budget_s=SESSION_BUDGET_S,
            )
            try:
                await _run_session(ws, session, setup_latency_ms, warm=True,
                                   conn_id=conn_id)
            finally:
                await session.aclose()
        else:
            logger.warning("conn %d: warm pool empty — COLD-connecting", conn_id)
            config = build_live_config(
                DEFAULT_SYSTEM_INSTRUCTION.format(ai_gender=AI_GENDER)
            )
            connect_start = time.perf_counter()
            cm = client.aio.live.connect(model=MODEL_ID, config=config)
            cold_session = await cm.__aenter__()
            setup_latency_ms = round((time.perf_counter() - connect_start) * 1000, 1)
            logger.info(
                "conn %d: COLD connect ready, handshake %.1f ms",
                conn_id, setup_latency_ms,
            )

            async def _dispose_cold():
                await cm.__aexit__(None, None, None)

            session = ResumableSession(
                client, MODEL_ID, _resume_config, cold_session, _dispose_cold,
                budget_s=SESSION_BUDGET_S,
            )
            try:
                await _run_session(ws, session, setup_latency_ms, warm=False,
                                   conn_id=conn_id)
            finally:
                await session.aclose()

    except WebSocketDisconnect:
        logger.info("conn %d: client disconnected", conn_id)
    except Exception as e:
        logger.error("conn %d: WebSocket error: %s\n%s", conn_id, e, traceback.format_exc())
        await send_json(ws, {"type": "error", "message": str(e)})
    finally:
        logger.info(
            "conn %d: session ended, lived %.1f s",
            conn_id, time.perf_counter() - t_accept,
        )
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
