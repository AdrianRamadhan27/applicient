"""Ashby ATS adapter — M2 §4.

Checked against the live public job-board API before writing any
parsing code, not assumed:
  - `GET https://api.ashbyhq.com/posting-api/job-board/{boardName}` is
    public — no key, no params needed (`requires_auth = False`).
    Confirmed live against several real boards, including one with 128
    real postings in a single response (`notion`) — a materially
    larger sample than Greenhouse's own no-pagination check, and no
    pagination cursor appeared at that size either.
  - Every posting carries BOTH `descriptionHtml` and `descriptionPlain`
    — confirmed directly on real postings. `descriptionPlain` is used
    here instead of stripping the HTML version, since a real plain-
    text field from the source is more trustworthy than reconstructing
    one.
  - `workplaceType` (e.g. "Hybrid") is a real, already-clean remote-
    policy string straight from the source — used directly rather
    than re-deriving it from the separate `isRemote` boolean.
  - `compensation` exists as a real field name in Ashby's schema, but
    every real posting checked across four different real boards
    (128 + 32 + others) had it absent/null — no live example of its
    populated shape was found. Not parsed here: guessing a structure
    for a field never observed populated would risk exactly the kind
    of fabricated-salary corruption F3.1a exists to prevent. Left
    null throughout; a real stated gap, not a silent one.
  - No explicit seniority-like field exists in this API's schema —
    left null rather than inferring one from the title.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

import httpx

from applicient_sources.base import ConnectionTestResult, RawPosting, SourceAdapter
from applicient_sources.http_policy import RateLimitedClient, SourceHTTPError

BASE_URL = "https://api.ashbyhq.com/posting-api/job-board"


def _posted_at(job: dict[str, Any]) -> datetime | None:
    raw = job.get("publishedAt")
    if not raw:
        return None
    try:
        return datetime.fromisoformat(raw)
    except ValueError:
        return None


def _job_to_posting(job: dict[str, Any], board: str) -> RawPosting:
    return RawPosting(
        source_url=job.get("jobUrl") or "",
        external_requisition_id=job.get("id"),
        title=job["title"],
        company_name=board,  # this endpoint's response has no company-name field of its own
        location=job.get("location"),
        remote_policy=job.get("workplaceType"),
        employment_type=job.get("employmentType"),
        posted_at=_posted_at(job),
        requirements=job.get("descriptionPlain") or None,
        apply_url=job.get("applyUrl") or job.get("jobUrl"),
        raw_payload=job,
    )


def _identifiers(config: dict[str, Any]) -> list[str]:
    """M2 §4/§6 — one Source row scans every identifier in this list
    (`company_identifiers`), not one company per Source."""

    ids = config.get("company_identifiers")
    if isinstance(ids, list) and ids:
        return [str(i) for i in ids]
    single = config.get("company_identifier")
    return [str(single)] if single else []


class AshbyAdapter(SourceAdapter):
    adapter_key = "ashby"
    display_name = "Ashby"
    requires_auth = False
    default_rate_limit_per_minute = 60

    async def test_connection(self, config: dict[str, Any]) -> ConnectionTestResult:
        identifiers = _identifiers(config)
        if not identifiers:
            return ConnectionTestResult(
                ok=False, status="unreachable", error="config.company_identifiers is required"
            )

        rlc = RateLimitedClient(base_headers={}, rate_per_minute=self.default_rate_limit_per_minute)
        try:
            async with httpx.AsyncClient() as client:
                resp = await rlc.get(client, f"{BASE_URL}/{identifiers[0]}")
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
            raise ValueError("config.company_identifiers is required for the ashby adapter")

        rlc = RateLimitedClient(base_headers={}, rate_per_minute=self.default_rate_limit_per_minute)
        postings: list[RawPosting] = []
        async with httpx.AsyncClient() as client:
            for board in identifiers:
                # Per-identifier isolation — see workable.py's matching
                # comment for the same stated scope (no per-company
                # SourceRun telemetry yet, that's M2 §6).
                try:
                    resp = await rlc.get(client, f"{BASE_URL}/{board}")
                    data = resp.json()
                    postings.extend(_job_to_posting(job, board) for job in data.get("jobs", []))
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
        # Never called by the pipeline today — search() already returns
        # full detail per posting (descriptionPlain comes free in the
        # list response, no separate detail call exists on this API).
        raise NotImplementedError("ashby adapter returns full detail from search(); fetch_detail is unused")
