"""Greenhouse ATS adapter — the M1 Tier-1 source (PRD §2.2, M1 §2).

Every shape here was checked against the live public Job Board API
before writing any parsing code, not assumed:
  - GET https://boards-api.greenhouse.io/v1/boards/{board_token}/jobs
    is public — no API key, no auth header. requires_auth is False.
  - ?content=true on the LIST endpoint (not just the detail endpoint)
    returns full HTML content for every job in one call — checked
    against three boards, including an 809-job one — so `search()`
    is a single request, never N detail calls.
  - The list endpoint has NO pagination — `meta.total` matches
    `len(jobs)` exactly even at 809 postings (checked against
    Stripe's and Databricks's boards, not just a small one). Greenhouse
    genuinely returns everything in one response; there is no cursor
    to follow.
  - `content` is HTML, and the JSON string value is itself
    HTML-entity-escaped (`&lt;div&gt;` inside the string, not `<div>`)
    — confirmed with `repr()`, not a display artifact. Needs
    html.unescape() before HTML-tag stripping.
  - Greenhouse does not structurally separate requirements from
    responsibilities from benefits — it's one HTML blob. Rather than
    fabricate that structure, the full cleaned text goes into
    `requirements` (what a fit rubric reads first) and
    responsibilities/benefits stay None — an honest gap, not a bug.

M2 §6 — retrofitted onto the same `company_identifiers` (list) scan
model the four M2 §4 adapters already use: `search()`/`test_connection()`
loop over every identifier, one Source scanning every company on the
list rather than one Source per company. The legacy singular
`board_token` key is still read as a one-element list — every Source
row created back in M1 keeps working unchanged, nothing to migrate.
"""

from __future__ import annotations

import html
import re
from datetime import datetime, timezone
from typing import Any

import httpx

from applicient_sources.base import ConnectionTestResult, RawPosting, SourceAdapter
from applicient_sources.http_policy import RateLimitedClient, SourceHTTPError

BASE_URL = "https://boards-api.greenhouse.io/v1/boards"

_TAG_RE = re.compile(r"<[^>]+>")


def _html_to_text(raw_html: str) -> str:
    unescaped = html.unescape(raw_html)
    text = _TAG_RE.sub(" ", unescaped)
    return re.sub(r"\s+", " ", text).strip()


def _identifiers(config: dict[str, Any]) -> list[str]:
    """M2 §6 — one Source row scans every identifier in this list
    (`company_identifiers`), not one company per Source. The legacy
    singular `board_token` (every M1-era Source row) is read as a
    one-element list rather than requiring a data migration."""

    ids = config.get("company_identifiers")
    if isinstance(ids, list) and ids:
        return [str(i) for i in ids]
    single = config.get("board_token") or config.get("company_identifier")
    return [str(single)] if single else []


def _job_to_posting(job: dict[str, Any], board_token: str) -> RawPosting:
    content = job.get("content")
    location = (job.get("location") or {}).get("name")
    posted_raw = job.get("first_published")
    posted_at = None
    if posted_raw:
        try:
            posted_at = datetime.fromisoformat(posted_raw).astimezone(timezone.utc)
        except ValueError:
            posted_at = None

    return RawPosting(
        source_url=job["absolute_url"],
        external_requisition_id=job.get("requisition_id") or str(job["id"]),
        title=job["title"],
        company_name=job.get("company_name") or board_token,
        location=location,
        posted_at=posted_at,
        requirements=_html_to_text(content) if content else None,
        apply_url=job["absolute_url"],
        raw_payload=job,
    )


class GreenhouseAdapter(SourceAdapter):
    adapter_key = "greenhouse"
    display_name = "Greenhouse"
    requires_auth = False
    default_rate_limit_per_minute = 60

    async def test_connection(self, config: dict[str, Any]) -> ConnectionTestResult:
        identifiers = _identifiers(config)
        if not identifiers:
            return ConnectionTestResult(
                ok=False, status="unreachable", error="config.company_identifiers is required"
            )

        # Smoke-tests the first identifier only — same scope as the
        # four M2 §4 adapters' own test_connection: this validates the
        # adapter/config shape is reachable, not that every company in
        # a large scan list is currently valid.
        rlc = RateLimitedClient(base_headers={}, rate_per_minute=self.default_rate_limit_per_minute)
        try:
            async with httpx.AsyncClient() as client:
                resp = await rlc.get(client, f"{BASE_URL}/{identifiers[0]}/jobs")
        except SourceHTTPError as e:
            status = "auth_failed" if e.status_code == 401 else "unreachable"
            return ConnectionTestResult(ok=False, status=status, error=str(e))

        data = resp.json()
        if "jobs" not in data:
            return ConnectionTestResult(ok=False, status="unreachable", error="unexpected response shape")
        return ConnectionTestResult(ok=True, status="ok")

    async def search(self, query: str, filters: dict[str, Any], config: dict[str, Any]) -> list[RawPosting]:
        identifiers = _identifiers(config)
        if not identifiers:
            raise ValueError("config.company_identifiers is required for the greenhouse adapter")

        rlc = RateLimitedClient(base_headers={}, rate_per_minute=self.default_rate_limit_per_minute)
        postings: list[RawPosting] = []
        async with httpx.AsyncClient() as client:
            for board_token in identifiers:
                # Per-identifier isolation — a renamed/deleted board
                # must not stop the rest of the scan. No structured
                # per-company error channel back to SourceRun yet
                # (M2 §6's own stated remaining gap — see this
                # milestone's checklist); a failure here is skipped
                # silently rather than surfaced.
                try:
                    resp = await rlc.get(client, f"{BASE_URL}/{board_token}/jobs", params={"content": "true"})
                    data = resp.json()
                    postings.extend(_job_to_posting(job, board_token) for job in data["jobs"])
                except (SourceHTTPError, KeyError, ValueError):
                    continue

        query_lower = query.lower().strip()
        if query_lower:
            postings = [p for p in postings if query_lower in p.title.lower()]

        location_filter = (filters or {}).get("location")
        if location_filter:
            loc_lower = location_filter.lower()
            postings = [p for p in postings if p.location and loc_lower in p.location.lower()]

        return postings

    async def fetch_detail(self, url: str, config: dict[str, Any]) -> RawPosting:
        identifiers = _identifiers(config)
        if not identifiers:
            raise ValueError("config.company_identifiers is required for the greenhouse adapter")
        # Never called by the pipeline today (confirmed: no call site
        # in radar.py/normalization.py) — best-effort against the
        # first identifier only, since a single posting URL doesn't
        # itself say which of possibly many scanned companies it's for.
        board_token = identifiers[0]

        job_id = url.rstrip("/").rsplit("/", 1)[-1]
        rlc = RateLimitedClient(base_headers={}, rate_per_minute=self.default_rate_limit_per_minute)
        async with httpx.AsyncClient() as client:
            resp = await rlc.get(
                client, f"{BASE_URL}/{board_token}/jobs/{job_id}", params={"content": "true"}
            )
        return _job_to_posting(resp.json(), board_token)
