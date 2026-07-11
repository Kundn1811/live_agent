"""Resumable Gemini Live session, bounded to a per-user budget.

A Gemini Live *connection* lives only ~10 minutes; a pre-warmed session pulled
from the pool may already be several minutes into that budget, so without help
the user would be cut short. This wrapper uses session resumption to BRIDGE the
per-connection cap so the user gets a full window (`budget_s`, measured from when
they connect) — i.e. it buys back exactly the idle time the pool consumed. It is
deliberately NOT an unlimited extender: once the budget is reached, a watchdog
ends the session, and we never resume past it.

It is a drop-in for the raw Gemini session in the audio pump: same
`send_realtime_input(...)` plus an async `receive()` generator that also handles
the per-turn re-entry the raw session needs (so the pump iterates it once).
`go_away` and resumption-update messages are consumed here, never forwarded.

v1 limitation (tune later): reconnect is non-transparent, so the ~handshake-long
swap can drop the tail of an in-flight turn. `transparent=True` + client-message
buffering would close that gap.
"""
import asyncio
import logging
import time

logger = logging.getLogger(__name__)


class ResumableSession:
    def __init__(self, client, model, resume_config_factory, initial_session,
                 dispose_initial, budget_s=600.0, resume_min_remaining_s=45.0):
        # resume_config_factory(handle) -> LiveConnectConfig with that handle set.
        # dispose_initial: async callable that releases/closes the initial session
        # (return it to the warm pool, or close a cold connection).
        self._client = client
        self._model = model
        self._resume_config = resume_config_factory
        self._session = initial_session
        self._dispose_initial = dispose_initial
        self._owned_cm = None      # context manager for wrapper-created (resumed) sessions
        self._handle = None
        self._closed = False
        self._pending_resume = False
        # Budget starts now (≈ when the user connects / the session is checked out).
        self._deadline = time.monotonic() + budget_s
        self._resume_min_remaining_s = resume_min_remaining_s
        self._lock = asyncio.Lock()  # serialize swap vs. watchdog disposal
        self._watchdog = None

    def _budget_left(self) -> float:
        return self._deadline - time.monotonic()

    async def send_realtime_input(self, **kwargs):
        try:
            await self._session.send_realtime_input(**kwargs)
        except Exception:
            # Session may be mid-reconnect or closing; drop this frame.
            pass

    async def receive(self):
        """Yield server messages across turns and (budget-limited) reconnects."""
        if self._watchdog is None:
            self._watchdog = asyncio.create_task(self._budget_watchdog())
        while not self._closed:
            try:
                async for msg in self._session.receive():
                    sru = msg.session_resumption_update
                    if sru is not None and sru.new_handle:
                        self._handle = sru.new_handle
                        continue
                    if msg.go_away is not None:
                        logger.info(
                            "Gemini go_away (time_left=%s); budget_left=%.0fs",
                            msg.go_away.time_left, self._budget_left(),
                        )
                        self._pending_resume = True
                        break
                    yield msg

                if self._closed:
                    return
                if self._pending_resume:
                    self._pending_resume = False
                    # Resume ONLY to bridge the connection cap while meaningful
                    # budget remains — buying back the pool's idle time, not
                    # handing out extra 10-min windows.
                    if (self._handle is not None
                            and self._budget_left() > self._resume_min_remaining_s):
                        if not await self._reconnect():
                            return
                    else:
                        logger.info("Budget reached / no handle; ending session")
                        self._closed = True
                        return
                # otherwise a turn just ended: re-enter receive() on the same session.
            except asyncio.CancelledError:
                raise
            except Exception as e:
                if self._closed:
                    return
                logger.warning("Gemini receive() error: %s", e)
                if (self._handle is not None
                        and self._budget_left() > self._resume_min_remaining_s
                        and await self._reconnect()):
                    continue
                raise

    async def _budget_watchdog(self):
        try:
            left = self._budget_left()
            if left > 0:
                await asyncio.sleep(left)
            logger.info("Session budget reached; ending conversation")
            self._closed = True
            async with self._lock:
                await self._dispose_current()
        except asyncio.CancelledError:
            pass

    async def _reconnect(self) -> bool:
        if self._handle is None or self._closed:
            return False
        t0 = time.perf_counter()
        new_cm = self._client.aio.live.connect(
            model=self._model, config=self._resume_config(self._handle)
        )
        try:
            new_session = await new_cm.__aenter__()
        except Exception as e:
            logger.error("Resume reconnect failed: %s", e)
            return False
        async with self._lock:
            if self._closed:
                # Watchdog ended us during the reconnect; discard the new session.
                try:
                    await new_cm.__aexit__(None, None, None)
                except Exception:
                    pass
                return False
            await self._dispose_current()
            self._session = new_session
            self._owned_cm = new_cm
        logger.info(
            "Resumed session in %.1f ms (budget_left=%.0fs)",
            (time.perf_counter() - t0) * 1000, self._budget_left(),
        )
        return True

    async def _dispose_current(self):
        if self._owned_cm is not None:
            try:
                await self._owned_cm.__aexit__(None, None, None)
            except Exception:
                pass
            self._owned_cm = None
        elif self._dispose_initial is not None:
            try:
                await self._dispose_initial()
            except Exception:
                pass
            self._dispose_initial = None

    async def aclose(self):
        self._closed = True
        if self._watchdog is not None:
            self._watchdog.cancel()
            try:
                await self._watchdog
            except BaseException:
                pass
            self._watchdog = None
        async with self._lock:
            await self._dispose_current()
