"""
Debug audio recorder (developer aid).

Captures, per WebSocket session, exactly the PCM we exchange with Gemini so you
can play back "what did the user actually send" vs. "what did Gemini reply" and
line one up against the other. Gated by DEBUG_AUDIO_RECORDING in config.py.

Design / requirements this meets:
- Only the MOST RECENT session is kept. Constructing a recorder wipes the debug
  dir first, so invoking a new session clears the previous session's audio.
- Input (16kHz) and output (24kHz) are streamed to raw .pcm files as bytes
  arrive — raw PCM has no header to corrupt, so a mid-session disconnect still
  leaves a usable partial recording.
- On close() the raw streams are muxed into WAV files:
    input.wav     - user mic, 16kHz, exactly the bytes we forwarded to Gemini
    output.wav    - Gemini audio, 24kHz
    combined.wav  - input (resampled to 24kHz) followed by output, so the whole
                    query and then the whole response play in one file.
  (combined.wav concatenates the full session's input then output. For a single
  query/response that is exactly query->response; for a multi-turn session it is
  all-queries then all-responses.)

close() reads the raw files back and resamples, which can take a beat on a long
session — call it via asyncio.to_thread so it never blocks the event loop.
"""
import array
import logging
import os
import shutil
import sys
import wave

from config import (
    DEBUG_AUDIO_RECORDING,
    DEBUG_AUDIO_DIR,
    INPUT_SAMPLE_RATE,
    OUTPUT_SAMPLE_RATE,
)

logger = logging.getLogger(__name__)

_SAMPLE_WIDTH = 2  # 16-bit PCM
_CHANNELS = 1


class DebugRecorder:
    def __init__(self, debug_dir: str, conn_id: int):
        self._dir = debug_dir
        self._conn_id = conn_id
        self._closed = False
        self._in_bytes = 0
        self._out_bytes = 0
        self._in_f = None
        self._out_f = None
        # Wipe the previous session's audio, then start fresh.
        try:
            if os.path.isdir(self._dir):
                shutil.rmtree(self._dir)
            os.makedirs(self._dir, exist_ok=True)
            self._in_f = open(os.path.join(self._dir, "input.pcm"), "wb")
            self._out_f = open(os.path.join(self._dir, "output.pcm"), "wb")
            logger.info("conn %d: debug recorder -> %s", conn_id, self._dir)
        except Exception as e:
            logger.error("conn %d: debug recorder init failed: %s", conn_id, e)

    def add_input(self, pcm: bytes):
        """Append a chunk of 16kHz mic PCM (as forwarded to Gemini)."""
        if self._in_f is None or self._closed:
            return
        try:
            self._in_f.write(pcm)
            self._in_bytes += len(pcm)
        except Exception:
            pass

    def add_output(self, pcm: bytes):
        """Append a chunk of 24kHz Gemini response PCM."""
        if self._out_f is None or self._closed:
            return
        try:
            self._out_f.write(pcm)
            self._out_bytes += len(pcm)
        except Exception:
            pass

    def close(self):
        """Finalize: mux the raw PCM streams into WAV files. Idempotent."""
        if self._closed:
            return
        self._closed = True
        for f in (self._in_f, self._out_f):
            try:
                if f is not None:
                    f.close()
            except Exception:
                pass
        if self._in_f is None and self._out_f is None:
            return
        try:
            in_pcm = _read(os.path.join(self._dir, "input.pcm"))
            out_pcm = _read(os.path.join(self._dir, "output.pcm"))
            _write_wav(os.path.join(self._dir, "input.wav"), in_pcm, INPUT_SAMPLE_RATE)
            _write_wav(os.path.join(self._dir, "output.wav"), out_pcm, OUTPUT_SAMPLE_RATE)
            combined = _resample_16k_to_24k(in_pcm) + out_pcm
            _write_wav(os.path.join(self._dir, "combined.wav"), combined, OUTPUT_SAMPLE_RATE)
            logger.info(
                "conn %d: debug audio saved (input %.1fs, output %.1fs) -> %s",
                self._conn_id,
                self._in_bytes / (INPUT_SAMPLE_RATE * _SAMPLE_WIDTH),
                self._out_bytes / (OUTPUT_SAMPLE_RATE * _SAMPLE_WIDTH),
                self._dir,
            )
        except Exception as e:
            logger.error("conn %d: debug recorder close failed: %s", self._conn_id, e)


class NullRecorder:
    """No-op recorder used when DEBUG_AUDIO_RECORDING is disabled."""

    def add_input(self, pcm: bytes):
        pass

    def add_output(self, pcm: bytes):
        pass

    def close(self):
        pass


def make_recorder(conn_id: int):
    """Return a real recorder if debug recording is on, else a no-op."""
    if DEBUG_AUDIO_RECORDING:
        return DebugRecorder(DEBUG_AUDIO_DIR, conn_id)
    return NullRecorder()


def _read(path: str) -> bytes:
    try:
        with open(path, "rb") as f:
            return f.read()
    except Exception:
        return b""


def _write_wav(path: str, pcm: bytes, rate: int):
    with wave.open(path, "wb") as w:
        w.setnchannels(_CHANNELS)
        w.setsampwidth(_SAMPLE_WIDTH)
        w.setframerate(rate)
        w.writeframes(pcm)


def _resample_16k_to_24k(pcm16: bytes) -> bytes:
    """Linear-interpolation upsample of mono 16-bit PCM, 16000 -> 24000 Hz.

    Debug-quality (no anti-alias filter); good enough to hear the query, and
    keeps the combined file at the output rate so it plays as one clip.
    """
    if not pcm16:
        return b""
    if len(pcm16) % _SAMPLE_WIDTH:
        pcm16 = pcm16[: -(len(pcm16) % _SAMPLE_WIDTH)]
    src = array.array("h")
    src.frombytes(pcm16)
    if sys.byteorder == "big":
        src.byteswap()
    n = len(src)
    if n == 0:
        return b""
    out_n = (n * OUTPUT_SAMPLE_RATE) // INPUT_SAMPLE_RATE
    out = array.array("h", bytes(_SAMPLE_WIDTH * out_n))
    step = INPUT_SAMPLE_RATE / OUTPUT_SAMPLE_RATE
    for j in range(out_n):
        pos = j * step
        i = int(pos)
        frac = pos - i
        s0 = src[i]
        s1 = src[i + 1] if i + 1 < n else s0
        out[j] = int(s0 + (s1 - s0) * frac)
    if sys.byteorder == "big":
        out.byteswap()
    return out.tobytes()
