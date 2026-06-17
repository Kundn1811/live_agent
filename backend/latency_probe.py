"""Throwaway probe: measure the Gemini setup-handshake latency via the /ws route."""
import asyncio
import json
import time

import websockets


async def main():
    url = "ws://localhost:8000/ws"
    t_connect = time.perf_counter()
    async with websockets.connect(url) as ws:
        await ws.send(json.dumps({
            "type": "setup",
            "source_language": "English",
            "target_language": "Spanish",
        }))
        t_setup_sent = time.perf_counter()
        while True:
            raw = await asyncio.wait_for(ws.recv(), timeout=30)
            msg = json.loads(raw)
            if msg.get("type") == "setup_complete":
                t_done = time.perf_counter()
                print("backend setup_latency_ms:", msg.get("setup_latency_ms"))
                print("client setup->complete ms:",
                      round((t_done - t_setup_sent) * 1000, 1))
                print("client connect->complete ms:",
                      round((t_done - t_connect) * 1000, 1))
                break
            if msg.get("type") == "error":
                print("ERROR from backend:", msg.get("message"))
                break


asyncio.run(main())
