"""M4 §9 — the one browser-driven SourceAdapter, for a company whose
career site matches no known ATS pattern (`CandidateStatus.
NEEDS_GENERIC_SCRAPING`, api/models/enums.py). Every other adapter in
this package calls a documented JSON API; this one drives the same
browser-worker service application execution already uses
(agents/browser_tools.py's own HTTP-boundary pattern, mirrored here
rather than importing Playwright directly into this package), reads
back its ref-annotated accessibility-tree snapshot, and hands that to
an LLM to interpret into a structured posting list — there is no other
way to make sense of a page whose structure was never known ahead of
time.

Honest scope limit, stated up front rather than discovered late: this
cannot promise the same reliability as a stable JSON API. A page that
doesn't look like a listing at all is asked to come back with zero
postings rather than guess or invent one (mirrors
NEEDS_GENERIC_SCRAPING's own honest-gap precedent).

`needs_llm = True` (base.py) is what gets this adapter an actual model
passed into `search()` at all — every other adapter leaves it False
and radar.py never resolves or passes one. Deliberately duck-typed,
not imported from langchain-core: this package has never depended on
an LLM provider before, and the model instance radar.py hands in only
ever needs `.with_structured_output(...)` called on it, so there's
nothing to gain from typing it precisely here.
"""

from __future__ import annotations

import asyncio
import os
import time
from typing import Any

import httpx
from pydantic import BaseModel, Field

from applicient_sources.base import ConnectionTestResult, RawPosting, SourceAdapter

BROWSER_WORKER_URL = os.environ.get("BROWSER_WORKER_URL", "http://localhost:8100")

# A real browser session plus one LLM call is at least an order of
# magnitude slower/costlier than every other adapter's plain HTTP GET
# — bounded the same way application_service.py bounds its own
# browser-worker calls.
_REQUEST_TIMEOUT_SECONDS = 45.0
# How long a scraped result is trusted before re-scraping — the same
# career page gets hit once per role title in a saved search (radar.py
# calls search() once per (role_title, query) pair), and re-scraping +
# re-extracting for every title in the same run would multiply real
# cost for no benefit; a fresh run tomorrow re-scrapes for real.
_CACHE_TTL_SECONDS = 600
# Keeps the LLM prompt/token cost bounded against a career page with an
# unexpectedly huge accessibility tree — a truncated snapshot still
# contains real content to extract from, just possibly not every
# posting on a very long page.
_MAX_SNAPSHOT_CHARS = 15_000

_SYSTEM_PROMPT = """You are extracting a list of job postings from a company's own \
career page, given its accessibility-tree snapshot (not raw HTML) — a ref-annotated \
text representation of the page's interactive/text content. The page's structure \
was never seen before; infer it from what you're given, don't assume any particular \
layout.

Extract only postings that are genuinely present in the snapshot — never invent a \
title, location, or URL that isn't actually there. Each posting's apply_url must be \
an actual link/href visible in the snapshot for that specific posting, not the \
career page's own URL reused for every row, and not guessed from a pattern.

If the snapshot doesn't look like a job listing at all — a login wall, an error \
page, an empty/loading page, or a single job's own detail page rather than a list \
of many — return zero postings. Do not force a match onto something that isn't one."""


class _ScrapedPosting(BaseModel):
    title: str
    apply_url: str = Field(
        description="The exact href/link for this specific posting as it appears in the snapshot."
    )
    location: str | None = None
    employment_type: str | None = None
    posted_at_text: str | None = Field(
        default=None,
        description="Raw recency text if shown (e.g. 'Posted 3 days ago') — do not compute an actual date.",
    )


class _ScrapedPostingList(BaseModel):
    postings: list[_ScrapedPosting] = Field(default_factory=list)


class GenericScraperAdapter(SourceAdapter):
    adapter_key = "generic_scraper"
    display_name = "Generic career-site scraper"
    requires_auth = False
    default_rate_limit_per_minute = 10
    # Real cost per call (a live browser session + one LLM extraction),
    # not a metered-credit API — same "don't multiply this by up to 4
    # query variants" reasoning as SocialFetch's credit_metered, a
    # different cost shape reaching the same conclusion.
    credit_metered = True
    needs_llm = True

    def __init__(self) -> None:
        # Process-local, not persisted — a singleton instance (see
        # __init__.py's ADAPTERS registry) shared across every run this
        # process ever handles, same lifetime as the registry itself.
        self._cache: dict[str, tuple[float, list[RawPosting]]] = {}
        self._locks: dict[str, asyncio.Lock] = {}

    def _lock_for(self, url: str) -> asyncio.Lock:
        lock = self._locks.get(url)
        if lock is None:
            lock = self._locks[url] = asyncio.Lock()
        return lock

    async def _open_and_snapshot(self, url: str) -> str | None:
        """Returns the page's accessibility-tree snapshot, or None if
        the browser-worker couldn't open it at all (unreachable site,
        timeout, etc.) — distinguished from "opened fine, empty page"
        so a dead career-page link doesn't silently look like a
        company with zero open roles."""

        async with httpx.AsyncClient(timeout=_REQUEST_TIMEOUT_SECONDS) as client:
            try:
                r = await client.post(f"{BROWSER_WORKER_URL}/sessions", json={"url": url})
            except httpx.HTTPError:
                return None
            if r.is_error:
                return None
            data = r.json()
            session_id, snapshot = data["session_id"], data["snapshot"]
            # Best-effort close — a leaked browser-worker session here
            # would only ever be caught by application_service.py's own
            # discipline, not this package's; failing to close never
            # invalidates the snapshot already in hand.
            try:
                await client.delete(f"{BROWSER_WORKER_URL}/sessions/{session_id}")
            except httpx.HTTPError:
                pass
        return snapshot

    async def _scrape_one(self, url: str, company_name: str, model: Any) -> list[RawPosting]:
        async with self._lock_for(url):
            cached = self._cache.get(url)
            if cached is not None and time.monotonic() - cached[0] < _CACHE_TTL_SECONDS:
                return cached[1]
            postings = await self._scrape_uncached(url, company_name, model)
            self._cache[url] = (time.monotonic(), postings)
            return postings

    async def _scrape_uncached(self, url: str, company_name: str, model: Any) -> list[RawPosting]:
        snapshot = await self._open_and_snapshot(url)
        if snapshot is None:
            return []

        structured = model.with_structured_output(_ScrapedPostingList)
        try:
            result = await asyncio.to_thread(
                structured.invoke,
                [
                    ("system", _SYSTEM_PROMPT),
                    ("user", f"Career page URL: {url}\n\nAccessibility-tree snapshot:\n\n{snapshot[:_MAX_SNAPSHOT_CHARS]}"),
                ],
            )
        except Exception:
            # One flaky extraction call must not fail the whole source
            # run — same per-item isolation every other adapter applies
            # per-identifier (greenhouse.py) or per-company
            # (radar.py's own company_breakdown).
            return []
        if not isinstance(result, _ScrapedPostingList):
            return []

        return [
            RawPosting(
                source_url=url,
                title=p.title,
                company_name=company_name,
                apply_url=p.apply_url,
                location=p.location,
                employment_type=p.employment_type,
                raw_payload={"posted_at_text": p.posted_at_text} if p.posted_at_text else {},
            )
            for p in result.postings
            if p.title and p.apply_url
        ]

    async def test_connection(self, config: dict[str, Any]) -> ConnectionTestResult:
        sites = config.get("career_sites") or []
        if not sites:
            return ConnectionTestResult(ok=False, status="unreachable", error="no career_sites configured")
        snapshot = await self._open_and_snapshot(sites[0]["url"])
        if snapshot is None:
            return ConnectionTestResult(ok=False, status="unreachable", error=f"could not open {sites[0]['url']}")
        return ConnectionTestResult(ok=True, status="ok")

    async def search(
        self, query: str, filters: dict[str, Any], config: dict[str, Any], *, model: Any = None
    ) -> list[RawPosting]:
        sites = config.get("career_sites") or []
        if not sites or model is None:
            # No sites configured, or the fast tier wasn't resolvable
            # this run (radar.py already logged why) — nothing to
            # extract with, not an error to raise.
            return []

        results = await asyncio.gather(
            *[self._scrape_one(site["url"], site.get("company_name", ""), model) for site in sites]
        )
        all_postings = [p for postings in results for p in postings]

        # Client-side query/location filter — same shape as
        # greenhouse.py's own post-fetch filtering, since a career page
        # lists everything open regardless of what was searched for.
        q = query.strip().lower()
        loc = (filters.get("location") or "").strip().lower()

        def _match(p: RawPosting) -> bool:
            if q and q not in p.title.lower():
                return False
            if loc and p.location and loc not in p.location.lower():
                return False
            return True

        return [p for p in all_postings if _match(p)]

    async def fetch_detail(self, url: str, config: dict[str, Any]) -> RawPosting:
        # Never called by the pipeline today (confirmed: no call site
        # in radar.py/normalization.py, same as every other adapter's
        # own fetch_detail comment) — and unlike them, this one
        # genuinely can't be implemented best-effort without an LLM
        # call, which this method has no way to receive (only search()
        # gets a resolved model, per base.py's contract). Raising
        # plainly rather than silently returning a fabricated posting.
        raise NotImplementedError("generic_scraper.fetch_detail needs an LLM call it has no way to receive here")
