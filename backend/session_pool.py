"""Warm Gemini Live session pool.

Eliminates the ~2.5s connect handshake from the request path by keeping a set
of Gemini Live sessions pre-opened in the background. This is valid ONLY because
the system instruction is generic (no per-user data) — see CLAUDE.md. If profile
data is ever baked into system_instruction, pooling is no longer correct.

Each keeper task owns one session through this lifecycle:
    open session -> publish as READY -> wait for checkout OR age-cap
      - checked out: hand the live session to the request, wait for release,
        then close it (its conversation context is now polluted) and open a
        fresh replacement.
      - aged out (idle too long, but still under the ~10-min connection cap):
        close and reopen a fresh session.

checkout() returns the OLDEST ready session — the one closest to its age cap, so
recycling wastes the least — or None if none is ready within the timeout, in
which case the caller cold-connects as a fallback.

Note (intentional, tune-after-probe): idle sessions are NOT actively drained, so
a session that Google closes for inactivity *before* `max_age_s` could in theory
be handed out dead. Keep `max_age_s` safely below any measured idle timeout; the
idle_session_probe.py run tells us that number.
"""
import asyncio
import logging
import time
from dataclasses import dataclass, field

logger = logging.getLogger(__name__)


@dataclass
class _Slot:
    id: int
    session: object = None
    opened_at: float = 0.0
    # connecting | ready | checked_out | recycling
    state: str = "connecting"
    handoff: asyncio.Event = field(default_factory=asyncio.Event)
    released: asyncio.Event = field(default_factory=asyncio.Event)


class WarmPool:
    def __init__(self, client, model, config, *, size=5, max_age_s=240.0,
                 checkout_timeout_s=0.25, reopen_backoff_s=0.5):
        self._client = client
        self._model = model
        self._config = config
        self._size = size
        self._max_age_s = max_age_s
        self._checkout_timeout_s = checkout_timeout_s
        self._reopen_backoff_s = reopen_backoff_s

        # _cond guards all reads/writes of _ready; it also signals checkout()
        # waiters when a new session becomes ready.
        self._cond = asyncio.Condition()
        self._ready: dict[int, _Slot] = {}   # only READY slots live here
        self._keepers: list[asyncio.Task] = []
        self._closing = False
        self._id_counter = 0

    async def start(self):
        for k in range(self._size):
            self._keepers.append(
                asyncio.create_task(self._keeper(k), name=f"pool-keeper-{k}")
            )

    async def aclose(self):
        self._closing = True
        for t in self._keepers:
            t.cancel()
        await asyncio.gather(*self._keepers, return_exceptions=True)
        self._keepers.clear()

    def _next_id(self) -> int:
        self._id_counter += 1
        return self._id_counter

    async def _publish_ready(self, slot: _Slot):
        async with self._cond:
            slot.state = "ready"
            self._ready[slot.id] = slot
            self._cond.notify()

    async def _drop(self, slot: _Slot):
        async with self._cond:
            self._ready.pop(slot.id, None)

    async def checkout(self):
        """Claim and return the oldest ready slot, or None within the timeout."""
        loop = asyncio.get_event_loop()
        deadline = loop.time() + self._checkout_timeout_s
        async with self._cond:
            while not self._ready:
                remaining = deadline - loop.time()
                if remaining <= 0:
                    return None
                try:
                    await asyncio.wait_for(self._cond.wait(), timeout=remaining)
                except asyncio.TimeoutError:
                    return None
            slot = min(self._ready.values(), key=lambda s: s.opened_at)
            idle_age = time.monotonic() - slot.opened_at
            del self._ready[slot.id]
            slot.state = "checked_out"
            slot.handoff.set()
            logger.info(
                "pool: checkout -> session %d (idle age %.1fs, %d ready left)",
                slot.id, idle_age, len(self._ready),
            )
            return slot

    def release(self, slot: _Slot):
        """Signal the owning keeper that the request is done with this session."""
        slot.released.set()

    async def _await_checkout_or_age(self, slot: _Slot) -> bool:
        """Return True if checked out, False if it aged out and should recycle."""
        try:
            await asyncio.wait_for(slot.handoff.wait(), timeout=self._max_age_s)
            return True
        except asyncio.TimeoutError:
            # Age cap hit. CAS against a checkout that may be landing right now.
            async with self._cond:
                if slot.state == "ready":
                    slot.state = "recycling"
                    self._ready.pop(slot.id, None)
                    return False
                return True  # checkout claimed it in the same instant

    async def _keeper(self, k: int):
        while not self._closing:
            slot = _Slot(id=self._next_id())
            try:
                async with self._client.aio.live.connect(
                    model=self._model, config=self._config
                ) as session:
                    slot.session = session
                    slot.opened_at = time.monotonic()
                    await self._publish_ready(slot)
                    logger.info("pool: keeper %d session %d READY", k, slot.id)

                    checked_out = await self._await_checkout_or_age(slot)

                    if checked_out:
                        logger.info("pool: session %d checked out", slot.id)
                        await slot.released.wait()
                        logger.info("pool: session %d released, recycling", slot.id)
                    else:
                        logger.info("pool: session %d aged out, recycling", slot.id)
                    # exiting the context manager closes the session
            except asyncio.CancelledError:
                await self._drop(slot)
                raise
            except Exception as e:
                logger.warning("pool: keeper %d error, reopening: %s", k, e)
                await self._drop(slot)
                await asyncio.sleep(self._reopen_backoff_s)
            # loop reopens a fresh session (refill)
        logger.info("pool: keeper %d stopped", k)
