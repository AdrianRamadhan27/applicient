"""SaaS pivot — first structured logging in this codebase. Every prior
log call interpolates ids into free-text messages (e.g. `logger.exception
("gmail poll failed for connection %s", connection_id)`), which means
diagnosing one noisy tenant in a shared, multi-tenant deployment means
grepping text rather than filtering by a real field. A minimal
stdlib-only JSON formatter — no new dependency — so `extra={"user_id":
...}` on a log call actually shows up as a real, queryable field in
`docker logs`/any log aggregator that ingests JSON lines, not just
another substring in the message.

Deliberately not applied everywhere in one pass: wired into the
handful of call sites that most matter for per-tenant diagnosis today
(scheduler.py's Gmail poll loop, rate_limit.py's 429s) rather than a
sweep of every log call in the codebase, which is real, separate,
much larger scope.
"""

from __future__ import annotations

import json
import logging
import os
from datetime import datetime, timezone

# The LogRecord attributes every record carries regardless of `extra`
# — anything else on the record's __dict__ came from an `extra={}` kwarg
# and is exactly what should surface as a structured field.
_STANDARD_ATTRS = set(logging.LogRecord("", 0, "", 0, "", (), None).__dict__) | {"message", "asctime"}


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
        }
        for key, value in record.__dict__.items():
            if key not in _STANDARD_ATTRS:
                payload[key] = str(value)
        if record.exc_info:
            payload["exc_info"] = self.formatException(record.exc_info)
        return json.dumps(payload, default=str)


def configure_logging() -> None:
    handler = logging.StreamHandler()
    handler.setFormatter(JsonFormatter())
    root = logging.getLogger()
    root.handlers = [handler]
    root.setLevel(os.environ.get("LOG_LEVEL", "INFO"))
