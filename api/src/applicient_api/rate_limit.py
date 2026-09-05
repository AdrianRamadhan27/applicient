"""SaaS pivot — per-user rate limiting on expensive/LLM-calling
routes (radar runs, application-agent runs, CV tailoring, cover
letters, answer packs). First real consumer of Redis in this
codebase: REDIS_URL has run in the docker-compose stack since M0, but
nothing in `api/` actually touched it until now — every other stage
here runs in-process with no queue/cache layer of its own.

A fixed-window counter (Redis INCR + EXPIRE), not a token bucket —
simpler, and "N runs per window, resets on the boundary" is a fine
approximation for "stop one tenant from hammering an expensive
endpoint and starving everyone else's scheduler/browser-worker
capacity," not a strict SLA.
"""

from __future__ import annotations

import logging
import os
import uuid
from collections.abc import Callable

import redis
from fastapi import Depends, HTTPException

from applicient_api.deps import current_user_id

logger = logging.getLogger(__name__)

_redis_client: redis.Redis | None = None


def _client() -> redis.Redis:
    global _redis_client
    if _redis_client is None:
        _redis_client = redis.from_url(os.environ.get("REDIS_URL", "redis://localhost:6379/0"))
    return _redis_client


def check_rate_limit(redis_key: str, *, limit: int, window_seconds: int) -> None:
    """The actual counter, factored out of `rate_limit()` below so an
    unauthenticated route (no `current_user_id` to key on — e.g.
    resend-verification, keyed by email instead of a logged-in user)
    can enforce the exact same fixed-window discipline directly,
    without needing a fake user to hang a FastAPI dependency off of.
    Same fail-open behavior: a Redis hiccup lets the request through
    rather than taking the endpoint down with it."""

    try:
        client = _client()
        count = client.incr(redis_key)
        if count == 1:
            client.expire(redis_key, window_seconds)
        ttl = client.ttl(redis_key)
    except redis.RedisError:
        return
    if count > limit:
        retry_after = ttl if ttl and ttl > 0 else window_seconds
        logger.warning(
            "rate limit exceeded for %s", redis_key,
            extra={"redis_key": redis_key, "limit": limit, "window_seconds": window_seconds},
        )
        raise HTTPException(
            429,
            f"rate limit exceeded — max {limit} per {window_seconds}s, try again in {retry_after}s",
            headers={"Retry-After": str(retry_after)},
        )


def rate_limit(key: str, *, limit: int, window_seconds: int) -> Callable[..., None]:
    """Returns a FastAPI dependency enforcing `limit` calls per
    `window_seconds` per user for this specific `key`. Fails open (lets
    the request through, does not block) if Redis itself is
    unreachable — a rate limiter that takes the whole app down when its
    own backing store hiccups would be worse than the abuse case it
    exists to prevent."""

    def _dependency(user_id: uuid.UUID = Depends(current_user_id)) -> None:
        check_rate_limit(f"ratelimit:{key}:{user_id}", limit=limit, window_seconds=window_seconds)

    return _dependency
