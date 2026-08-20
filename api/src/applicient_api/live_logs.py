"""M1 §3/§8 observability — capture real Python `logging` output
emitted anywhere during an awaitable's execution (any thread, any
logger name) and stream it live instead of only being visible in the
server's own stdout/log file.

Raised directly by Adrian after watching a real JobSpy run stall for
minutes with nothing but "still running" in the GUI, while the actual
diagnostic detail (Glassdoor/ZipRecruiter errors) sat in
`/tmp/api_server.log` where he had no visibility into it without
asking. `SourceAdapter.search()` implementations that shell out to a
library with its own internal logging (JobSpy, built on `requests` +
its own per-scraper loggers) are exactly the case this exists for —
Greenhouse/Lever/RemoteOK/JSearch/SocialFetch are plain httpx calls
with no internal logging of their own, so this mostly stays quiet for
them, which is fine; it's generic, not JobSpy-specific.

Attached at the root logger (not a specific library's logger name) so
it picks up whichever adapter is running without needing to know its
internal logger namespace ahead of time — confirmed necessary rather
than assumed: JobSpy's own log lines came through in an ad hoc script
with no logging configuration at all, meaning JobSpy's logger already
propagates to root by default (Python's standard behavior unless a
library explicitly disables propagation), so attaching here is enough.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any, AsyncGenerator, Awaitable

_DONE = object()


class _QueueLogHandler(logging.Handler):
    """Log records are emitted from whichever thread produced them
    (asyncio.to_thread runs the real work off the event loop) —
    asyncio.Queue.put_nowait is not safe to call directly from a
    foreign thread, so every enqueue goes through
    call_soon_threadsafe, which is."""

    def __init__(self, queue: asyncio.Queue, loop: asyncio.AbstractEventLoop) -> None:
        super().__init__()
        self._queue = queue
        self._loop = loop

    def emit(self, record: logging.LogRecord) -> None:
        try:
            message = self.format(record)
        except Exception:
            message = record.getMessage()
        self._loop.call_soon_threadsafe(self._queue.put_nowait, message)


async def run_with_live_logs(awaitable: Awaitable[Any]) -> AsyncGenerator[tuple[str, Any], None]:
    """Yields ("log", message) for every log record produced while
    `awaitable` runs, then exactly one ("result", value) with its
    return value — or re-raises its exception after yielding whatever
    logs happened before the failure, so a crash never hides the
    diagnostic trail that led to it."""

    loop = asyncio.get_running_loop()
    queue: asyncio.Queue = asyncio.Queue()

    handler = _QueueLogHandler(queue, loop)
    handler.setLevel(logging.INFO)
    handler.setFormatter(logging.Formatter("%(levelname)s %(name)s: %(message)s"))

    root_logger = logging.getLogger()
    # Only relaxed, never tightened — an operator who already set a
    # more verbose root level than INFO (e.g. DEBUG) keeps getting
    # everything they asked for; this only ensures INFO is a floor,
    # not a ceiling.
    previous_level = root_logger.level
    if root_logger.level == logging.NOTSET or root_logger.level > logging.INFO:
        root_logger.setLevel(logging.INFO)
    root_logger.addHandler(handler)

    task = asyncio.ensure_future(awaitable)
    task.add_done_callback(lambda _t: loop.call_soon_threadsafe(queue.put_nowait, _DONE))

    try:
        while True:
            item = await queue.get()
            if item is _DONE:
                break
            yield ("log", item)
        result = task.result()  # re-raises the original exception, if any
        yield ("result", result)
    finally:
        root_logger.removeHandler(handler)
        root_logger.setLevel(previous_level)
