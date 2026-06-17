"""Throwaway probe: measure how long an IDLE Gemini Live session stays open.

Connects directly to Gemini using the exact production model + config, sends
NO input at all, and logs every server event with elapsed time until the
connection closes. This tells us:
  - the idle lifetime (when does Google close a silent connection?),
  - whether/when a GoAway arrives and its `time_left`,
  - whether session-resumption handles show up.
Those three numbers set the recycle cadence for the warm-session pool.

Run:  cd backend && python idle_session_probe.py
"""
import asyncio
import time

from google.genai import types

from config import MODEL_ID, DEFAULT_SYSTEM_INSTRUCTION, AI_GENDER
from main import client, build_live_config

START = time.perf_counter()


def el() -> float:
    return time.perf_counter() - START


async def ticker():
    """Heartbeat so we see progress even when no server events arrive."""
    while True:
        await asyncio.sleep(15)
        print(f"[{el():7.1f}s] still open, idle...", flush=True)


async def main():
    system_instruction = DEFAULT_SYSTEM_INSTRUCTION.format(ai_gender=AI_GENDER)
    config = build_live_config(system_instruction)
    # Ask for resumption updates too, so we can observe handle timing.
    try:
        config.session_resumption = types.SessionResumptionConfig()
    except Exception as e:
        print("note: could not enable session_resumption:", e, flush=True)

    print(f"[{el():7.1f}s] connecting (no input will ever be sent)...", flush=True)
    async with client.aio.live.connect(model=MODEL_ID, config=config) as session:
        print(f"[{el():7.1f}s] SESSION OPEN — handshake complete", flush=True)
        tick = asyncio.create_task(ticker())
        try:
            async for msg in session.receive():
                go = getattr(msg, "go_away", None)
                if go is not None:
                    print(
                        f"[{el():7.1f}s] >>> GoAway received. time_left="
                        f"{getattr(go, 'time_left', None)}",
                        flush=True,
                    )
                sru = getattr(msg, "session_resumption_update", None)
                if sru is not None:
                    print(
                        f"[{el():7.1f}s] session_resumption_update: "
                        f"resumable={getattr(sru, 'resumable', None)} "
                        f"handle={'set' if getattr(sru, 'new_handle', None) else 'none'}",
                        flush=True,
                    )
                sc = getattr(msg, "server_content", None)
                if sc is not None:
                    print(f"[{el():7.1f}s] server_content event (unexpected while idle)", flush=True)
        except Exception as e:
            print(f"[{el():7.1f}s] receive() ended/raised: {type(e).__name__}: {e}", flush=True)
        finally:
            tick.cancel()
    print(
        f"[{el():7.1f}s] CONNECTION CLOSED (context exited). "
        f"Idle lifetime ~= this elapsed time.",
        flush=True,
    )


if __name__ == "__main__":
    asyncio.run(main())
