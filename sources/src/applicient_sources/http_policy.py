"""M1 §2 — shared HTTP policy for every Tier 1 (API-based) source
adapter: per-source rate limiting, bounded retries with jittered
backoff, timeouts, a response-size guard, and circuit-breaker signal
tracking on repeated 403/429.

Deliberately NOT a generic HTTP-with-retries library import: the
circuit-breaker counting and the exact "what counts as a
rate-limit-worthy failure" logic is domain-specific to how Source rows
get their circuit_breaker_tripped flag set (F11.4), so it lives here
rather than being a thin wrapper users of this package would still
have to reimplement the policy on top of.
"""

from __future__ import annotations

import asyncio
import random
import time
from dataclasses import dataclass, field

import httpx

# F11.2 response-size guard — a misbehaving or compromised endpoint
# returning gigabytes must not be read fully into memory.
MAX_RESPONSE_BYTES = 10 * 1024 * 1024  # 10 MB


class SourceHTTPError(Exception):
    """Raised after retries are exhausted or on a non-retryable
    status. `is_rate_limit` tells the caller whether this should count
    toward circuit-breaker state (F11.4)."""

    def __init__(self, message: str, *, status_code: int | None = None, is_rate_limit: bool = False):
        super().__init__(message)
        self.status_code = status_code
        self.is_rate_limit = is_rate_limit


@dataclass
class TokenBucket:
    """A plain token bucket, not a wrapped dependency — small enough
    to own directly and test without network access (M1 §2)."""

    rate_per_minute: int
    _tokens: float = field(init=False)
    _last_refill: float = field(init=False)

    def __post_init__(self) -> None:
        self._tokens = float(self.rate_per_minute)
        self._last_refill = time.monotonic()

    def _refill(self) -> None:
        now = time.monotonic()
        elapsed = now - self._last_refill
        self._tokens = min(self.rate_per_minute, self._tokens + elapsed * (self.rate_per_minute / 60.0))
        self._last_refill = now

    async def acquire(self) -> None:
        while True:
            self._refill()
            if self._tokens >= 1:
                self._tokens -= 1
                return
            # Not enough tokens yet — sleep for roughly how long until one frees up.
            deficit = 1 - self._tokens
            await asyncio.sleep(deficit * (60.0 / self.rate_per_minute))


@dataclass
class RateLimitedClient:
    """One instance per source per run. Not a singleton/shared client
    across sources — each source's rate limit is independent, and
    reusing one httpx.AsyncClient across unrelated sources would also
    share connection pooling in ways that make one source's slowness
    affect another's."""

    base_headers: dict[str, str]
    rate_per_minute: int = 30
    max_retries: int = 3
    timeout_seconds: float = 20.0
    max_response_bytes: int = MAX_RESPONSE_BYTES

    _bucket: TokenBucket = field(init=False)
    _consecutive_rate_limit_errors: int = field(init=False, default=0)

    def __post_init__(self) -> None:
        self._bucket = TokenBucket(self.rate_per_minute)

    @property
    def circuit_should_trip(self) -> bool:
        """F11.4 — repeated 403/429 disables the source. The caller
        (the source-run service) reads this after each request batch
        and persists it to Source.circuit_breaker_tripped; this class
        only counts, it never touches the database."""

        return self._consecutive_rate_limit_errors >= 3

    async def get(self, client: httpx.AsyncClient, url: str, **kwargs) -> httpx.Response:
        last_exc: Exception | None = None
        for attempt in range(self.max_retries + 1):
            await self._bucket.acquire()
            try:
                async with client.stream(
                    "GET", url, headers=self.base_headers, timeout=self.timeout_seconds, **kwargs
                ) as response:
                    if response.status_code in (403, 429):
                        self._consecutive_rate_limit_errors += 1
                        last_exc = SourceHTTPError(
                            f"{url} -> HTTP {response.status_code}",
                            status_code=response.status_code,
                            is_rate_limit=True,
                        )
                        if attempt < self.max_retries:
                            await self._backoff(attempt, response.headers.get("retry-after"))
                            continue
                        raise last_exc
                    if response.status_code >= 500:
                        last_exc = SourceHTTPError(f"{url} -> HTTP {response.status_code}", status_code=response.status_code)
                        if attempt < self.max_retries:
                            await self._backoff(attempt, None)
                            continue
                        raise last_exc
                    if response.status_code >= 400:
                        # Client errors other than 403/429 are not
                        # retried — retrying a 404 or 422 just burns
                        # the rate-limit budget for no benefit.
                        raise SourceHTTPError(f"{url} -> HTTP {response.status_code}", status_code=response.status_code)

                    body = await self._read_bounded(response)
                    self._consecutive_rate_limit_errors = 0
                    # aiter_bytes() already decompresses per Content-Encoding
                    # as it streams. The original response's headers still
                    # claim gzip/deflate/etc and a stale content-length —
                    # carrying them into the reconstructed Response makes
                    # httpx try to decompress already-decompressed bytes a
                    # second time on first .json()/.text access (confirmed
                    # live: "Error -3 while decompressing data: incorrect
                    # header check"). Strip both before reconstructing.
                    clean_headers = httpx.Headers(
                        [
                            (k, v)
                            for k, v in response.headers.raw
                            if k.lower() not in (b"content-encoding", b"content-length")
                        ]
                    )
                    return httpx.Response(
                        response.status_code, headers=clean_headers, content=body, request=response.request
                    )
            except httpx.ConnectTimeout as exc:
                # The request never left our side — nothing was sent,
                # so nothing could have been billed/processed
                # server-side. Safe to retry like any other transient
                # network failure.
                last_exc = SourceHTTPError(f"{url} -> timeout: {exc}")
                if attempt < self.max_retries:
                    await self._backoff(attempt, None)
                    continue
            except httpx.TimeoutException as exc:
                # A read/write/pool timeout means the request already
                # reached the server and it may have started (or
                # finished) real, possibly-billed work before we gave
                # up waiting for the response — confirmed live: a
                # SocialFetch search kept read-timing-out and each
                # blind retry re-ran (and re-billed) the same paid
                # LinkedIn scrape, burning 96 of 100 credits on what
                # looked like one search. Retrying here would risk
                # duplicating that cost again, so this is NOT retried —
                # it surfaces as a real failure instead.
                last_exc = SourceHTTPError(f"{url} -> timeout: {exc}")
            except httpx.RequestError as exc:
                last_exc = SourceHTTPError(f"{url} -> request error: {exc}")
                if attempt < self.max_retries:
                    await self._backoff(attempt, None)
                    continue

        assert last_exc is not None
        raise last_exc

    async def _read_bounded(self, response: httpx.Response) -> bytes:
        total = 0
        chunks: list[bytes] = []
        async for chunk in response.aiter_bytes():
            total += len(chunk)
            if total > self.max_response_bytes:
                raise SourceHTTPError(
                    f"response exceeded {self.max_response_bytes} bytes — aborted, not buffered fully"
                )
            chunks.append(chunk)
        return b"".join(chunks)

    async def _backoff(self, attempt: int, retry_after_header: str | None) -> None:
        if retry_after_header:
            try:
                await asyncio.sleep(float(retry_after_header))
                return
            except ValueError:
                pass
        base = 2**attempt
        jitter = random.uniform(0, base * 0.5)
        await asyncio.sleep(base + jitter)
