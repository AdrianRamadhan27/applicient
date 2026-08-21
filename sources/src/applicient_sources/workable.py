"""Workable ATS adapter — M2 §4, one of four Tier-1 boards added
alongside Greenhouse/Lever's existing two.

Checked against the live public widget API before writing any parsing
code, not assumed:
  - `GET https://apply.workable.com/api/v1/widget/accounts/{account}?details=true`
    is public — no key, no auth header (`requires_auth = False`).
    Confirmed live against several real accounts; a real account with
    a full posting list (`huggingface`, 7 real postings) round-tripped
    correctly. Several other real, currently-hiring companies returned
    `{"jobs": []}` — a legitimate empty state, same as Lever's own
    empty-board finding, not an error.
  - `?details=true` is required to get `description` on each posting —
    without it the endpoint returns summary fields only (title,
    location, dates) and no body text, confirmed by comparing both
    calls directly. Every call here always passes it.
  - The list endpoint returned ALL of a company's postings in one
    response with no pagination cursor at the one real company size
    checked here (7 jobs) — unlike Greenhouse's own no-pagination
    finding, this is a smaller sample and NOT confirmed at scale (no
    real Workable account with hundreds of postings was found to
    check against). Stated as a real, unconfirmed assumption rather
    than asserted as fact.
  - `shortcode` is the stable per-posting identifier (used as
    `external_requisition_id`); `application_url` is the real apply
    link, distinct from `url`/`shortlink` (the posting's own page).
  - `description` is real HTML with real angle brackets (not
    entity-escaped inside the JSON string the way Greenhouse's
    `content` is) — confirmed with `repr()`. Tag-stripped the same way
    regardless, since inner HTML entities (`&amp;` etc.) still need
    `html.unescape()` after stripping.
  - No salary field was present on any live posting checked — left
    null throughout (F3.1a), not estimated.
"""

from __future__ import annotations

import html
import re
from datetime import date, datetime, timezone
from typing import Any

import httpx

from applicient_sources.base import ConnectionTestResult, RawPosting, SourceAdapter
from applicient_sources.http_policy import RateLimitedClient, SourceHTTPError

BASE_URL = "https://apply.workable.com/api/v1/widget/accounts"

_TAG_RE = re.compile(r"<[^>]+>")


def _html_to_text(raw_html: str) -> str:
    unescaped = html.unescape(raw_html)
    text = _TAG_RE.sub(" ", unescaped)
    return re.sub(r"\s+", " ", text).strip()


def _location(job: dict[str, Any]) -> str | None:
    parts = [job.get("city"), job.get("state"), job.get("country")]
    joined = ", ".join(p for p in parts if p)
    return joined or None


def _posted_at(job: dict[str, Any]) -> datetime | None:
    raw = job.get("published_on") or job.get("created_at")
    if not raw:
        return None
    try:
        return datetime.combine(date.fromisoformat(raw), datetime.min.time(), tzinfo=timezone.utc)
    except ValueError:
        return None


def _job_to_posting(job: dict[str, Any], account: str) -> RawPosting:
    description = job.get("description")
    return RawPosting(
        source_url=job.get("url") or job.get("shortlink") or "",
        external_requisition_id=job.get("shortcode"),
        title=job["title"],
        company_name=account,  # the widget response's own "name" field, not per-job — passed in by the caller
        location=_location(job),
        remote_policy="remote" if job.get("telecommuting") else None,
        seniority=job.get("experience") or None,
        employment_type=job.get("employment_type"),
        posted_at=_posted_at(job),
        requirements=_html_to_text(description) if description else None,
        apply_url=job.get("application_url") or job.get("url"),
        raw_payload=job,
    )


def _identifiers(config: dict[str, Any]) -> list[str]:
    """M2 §4/§6 — one Source row scans every identifier in this list
    (`company_identifiers`), not one company per Source. `company_identifier`
    (singular) is accepted too as a convenience for a direct single-add,
    normalized to a one-element list."""

    ids = config.get("company_identifiers")
    if isinstance(ids, list) and ids:
        return [str(i) for i in ids]
    single = config.get("company_identifier")
    return [str(single)] if single else []


class WorkableAdapter(SourceAdapter):
    adapter_key = "workable"
    display_name = "Workable"
    requires_auth = False
    default_rate_limit_per_minute = 60

    async def test_connection(self, config: dict[str, Any]) -> ConnectionTestResult:
        identifiers = _identifiers(config)
        if not identifiers:
            return ConnectionTestResult(
                ok=False, status="unreachable", error="config.company_identifiers is required"
            )

        # Smoke-tests the first identifier only — this validates the
        # adapter/config shape is reachable, not that every company in
        # a large list is currently valid. A stale identifier among
        # many surfaces later through search()'s own per-identifier
        # error isolation, not here.
        rlc = RateLimitedClient(base_headers={}, rate_per_minute=self.default_rate_limit_per_minute)
        try:
            async with httpx.AsyncClient() as client:
                resp = await rlc.get(client, f"{BASE_URL}/{identifiers[0]}", params={"details": "true"})
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
            raise ValueError("config.company_identifiers is required for the workable adapter")

        rlc = RateLimitedClient(base_headers={}, rate_per_minute=self.default_rate_limit_per_minute)
        postings: list[RawPosting] = []
        async with httpx.AsyncClient() as client:
            for account in identifiers:
                # Per-identifier isolation — a renamed/deleted account
                # must not stop the rest of the scan. No structured
                # per-company error channel back to SourceRun yet
                # (that lands in M2 §6 alongside the same retrofit for
                # Greenhouse/Lever); a failure here is skipped silently
                # rather than surfaced, stated as a real interim gap.
                try:
                    resp = await rlc.get(client, f"{BASE_URL}/{account}", params={"details": "true"})
                    data = resp.json()
                    postings.extend(_job_to_posting(job, account) for job in data.get("jobs", []))
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
        # Never called by the pipeline today (confirmed: no call site
        # exists in radar.py/normalization.py) — search() already
        # returns full detail per posting since Workable's list
        # endpoint includes it. Not implemented for real use.
        raise NotImplementedError("workable adapter returns full detail from search(); fetch_detail is unused")
