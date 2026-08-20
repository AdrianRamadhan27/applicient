"""Lever ATS adapter — a second Tier-1 per-company-board source (PRD
§2.2), mirroring the Greenhouse adapter's shape exactly: one board per
`Source` row, `config.board_token` is the company's slug in the URL.

Checked against the live public Postings API before writing any
parsing code (`GET https://api.lever.co/v0/postings/{board_token}?mode=json`,
no key, no auth — `requires_auth = False`), not assumed:
  - Several well-known Lever customers' boards are currently EMPTY
    (0 postings, still HTTP 200 — not an error) — checked against
    six boards, only `palantir` (307 postings) had real data at the
    time this was written. Zero postings is a legitimate empty-board
    state for this adapter, not a failure.
  - `id` (UUID string) is the requisition id; `text` is the title.
    `categories.location`/`categories.commitment` map directly to
    location/employment_type. `workplaceType` is `remote`/`hybrid`/
    `onsite` on live data (Lever's own docs describe it as
    `unspecified`/`on-site`/`remote`/`hybrid` — normalization below
    tolerates both spellings rather than trusting either source
    alone).
  - `descriptionPlain` plus every `lists[].content` (HTML, stripped)
    get combined into `requirements` — like Greenhouse, Lever doesn't
    structurally guarantee which list is "requirements" vs
    "responsibilities" (list titles vary per posting, e.g. "What
    You'll Do" / "What We Value"), so nothing here fabricates that
    split.
  - `createdAt` (epoch milliseconds) IS present on live postings and
    used for `posted_at`, even though it wasn't confirmed in Lever's
    own published field docs — trusted because it was observed
    directly on real API responses, which this codebase treats as
    the higher-confidence source over documentation when the two
    disagree.
  - `salaryRange` (`{currency, min, max, interval}`, corroborated
    against Lever's docs) was never populated (always `None`) on any
    live posting checked — handled defensively (only trusted if all
    of `min`/`max` are present and numeric) rather than assumed to
    always have this shape; `interval` (e.g. "year" vs "hour") is
    read but not normalized — F3.1a's "leave null when ambiguous"
    covers exactly this case if it ever needs to.
"""

from __future__ import annotations

import html
import re
from datetime import datetime, timezone
from typing import Any

import httpx

from applicient_sources.base import ConnectionTestResult, RawPosting, SourceAdapter
from applicient_sources.http_policy import RateLimitedClient, SourceHTTPError

BASE_URL = "https://api.lever.co/v0/postings"

_TAG_RE = re.compile(r"<[^>]+>")
_WORKPLACE_TO_REMOTE_POLICY = {
    "remote": "remote",
    "hybrid": "hybrid",
    "onsite": "onsite",
    "on-site": "onsite",
    "unspecified": None,
}


def _html_to_text(raw_html: str) -> str:
    unescaped = html.unescape(raw_html)
    text = _TAG_RE.sub(" ", unescaped)
    return re.sub(r"\s+", " ", text).strip()


def _salary(job: dict[str, Any]) -> tuple[float | None, float | None, str | None]:
    salary_range = job.get("salaryRange")
    if not isinstance(salary_range, dict):
        return None, None, None
    lo, hi = salary_range.get("min"), salary_range.get("max")
    if not isinstance(lo, (int, float)) or not isinstance(hi, (int, float)):
        return None, None, None
    currency = salary_range.get("currency")
    return float(lo), float(hi), (currency.upper() if isinstance(currency, str) else None)


def _job_to_posting(job: dict[str, Any], board_token: str) -> RawPosting:
    categories = job.get("categories") or {}
    posted_at = None
    created_at = job.get("createdAt")
    if isinstance(created_at, (int, float)):
        try:
            posted_at = datetime.fromtimestamp(created_at / 1000, tz=timezone.utc)
        except (ValueError, OverflowError, OSError):
            posted_at = None

    requirements_parts = [job.get("descriptionPlain")]
    for section in job.get("lists") or []:
        content = section.get("content")
        if content:
            requirements_parts.append(_html_to_text(content))
    requirements = "\n\n".join(p for p in requirements_parts if p) or None

    salary_min, salary_max, salary_currency = _salary(job)

    return RawPosting(
        source_url=job.get("hostedUrl") or "",
        external_requisition_id=job.get("id"),
        title=job["text"],
        company_name=board_token,  # Lever's posting object doesn't carry a company name — see module docstring.
        location=categories.get("location"),
        remote_policy=_WORKPLACE_TO_REMOTE_POLICY.get((job.get("workplaceType") or "").lower()),
        employment_type=categories.get("commitment"),
        salary_min=salary_min,
        salary_max=salary_max,
        salary_currency=salary_currency,
        posted_at=posted_at,
        requirements=requirements,
        apply_url=job.get("applyUrl") or job.get("hostedUrl"),
        raw_payload=job,
    )


class LeverAdapter(SourceAdapter):
    adapter_key = "lever"
    display_name = "Lever"
    requires_auth = False
    default_rate_limit_per_minute = 60

    async def test_connection(self, config: dict[str, Any]) -> ConnectionTestResult:
        board_token = config.get("board_token")
        if not board_token:
            return ConnectionTestResult(ok=False, status="unreachable", error="config.board_token is required")

        rlc = RateLimitedClient(base_headers={}, rate_per_minute=self.default_rate_limit_per_minute)
        try:
            async with httpx.AsyncClient() as client:
                resp = await rlc.get(client, f"{BASE_URL}/{board_token}", params={"mode": "json"})
        except SourceHTTPError as e:
            status = "auth_failed" if e.status_code == 401 else "unreachable"
            return ConnectionTestResult(ok=False, status=status, error=str(e))

        data = resp.json()
        if not isinstance(data, list):
            return ConnectionTestResult(ok=False, status="unreachable", error="unexpected response shape")
        return ConnectionTestResult(ok=True, status="ok")

    async def search(self, query: str, filters: dict[str, Any], config: dict[str, Any]) -> list[RawPosting]:
        board_token = config.get("board_token")
        if not board_token:
            raise ValueError("config.board_token is required for the lever adapter")

        rlc = RateLimitedClient(base_headers={}, rate_per_minute=self.default_rate_limit_per_minute)
        async with httpx.AsyncClient() as client:
            resp = await rlc.get(client, f"{BASE_URL}/{board_token}", params={"mode": "json"})
        data = resp.json()

        postings = [_job_to_posting(job, board_token) for job in data]

        query_lower = query.lower().strip()
        if query_lower:
            postings = [p for p in postings if query_lower in p.title.lower()]

        location_filter = (filters or {}).get("location")
        if location_filter:
            loc_lower = location_filter.lower()
            postings = [p for p in postings if p.location and loc_lower in p.location.lower()]

        return postings

    async def fetch_detail(self, url: str, config: dict[str, Any]) -> RawPosting:
        board_token = config.get("board_token")
        if not board_token:
            raise ValueError("config.board_token is required for the lever adapter")

        posting_id = url.rstrip("/").rsplit("/", 1)[-1]
        rlc = RateLimitedClient(base_headers={}, rate_per_minute=self.default_rate_limit_per_minute)
        async with httpx.AsyncClient() as client:
            resp = await rlc.get(client, f"{BASE_URL}/{board_token}/{posting_id}", params={"mode": "json"})
        return _job_to_posting(resp.json(), board_token)
