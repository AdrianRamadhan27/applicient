"""SmartRecruiters ATS adapter — M2 §4.

Checked against the live public postings API before writing any
parsing code, not assumed:
  - `GET https://api.smartrecruiters.com/v1/companies/{companyIdentifier}/postings`
    is public — no key, no auth header (`requires_auth = False`).
  - Unlike Greenhouse/Lever/Workable/Ashby, this endpoint IS genuinely
    paginated: confirmed live against a real 718-posting board
    (`Equinox`) — default `limit=100`, `totalFound` reports the real
    total, and `offset` pages through correctly (`offset=700` on that
    board returned exactly the remaining 18). `search()` below pages
    through the full list rather than assuming one call is enough.
  - The LIST endpoint's postings are summaries only — no description
    text, no apply URL. Getting a real posting body requires a SEPARATE
    detail call per posting (`GET .../postings/{id}`), confirmed live:
    the list-level fields never include `jobAd`/`applyUrl`/`postingUrl`
    at all, and a detail call on a real posting returned real,
    non-empty section text (1000+ characters each) where a different
    real posting's sections happened to be empty (Visa's one checked
    posting) — that first empty result was a property of that specific
    posting, not the endpoint, confirmed by checking a second company.
  - Because of that N+1 shape, detail is only fetched for postings
    that already survive the query/location filter on list-level
    fields (title, `location.fullLocation`) — fetching full detail for
    every posting on a large board unconditionally (Equinox alone has
    718) would be needlessly expensive per search. This mirrors
    Greenhouse's own "filter after listing" order, just with the
    detail call moved after the filter instead of being free.
  - `jobAd.sections` structurally separates `qualifications` (mapped to
    `requirements`), `jobDescription` (mapped to `responsibilities`)
    and `additionalInformation` (mapped to `benefits`) — SmartRecruiters
    is the first Tier-1 source in this codebase that actually
    structures this split; Greenhouse/Lever/Workable/Ashby all dump
    everything into `requirements` because their sources don't.
  - No salary field was found on any real posting checked (list or
    detail) — left null throughout (F3.1a).
"""

from __future__ import annotations

import html
import re
from datetime import datetime
from typing import Any

import httpx

from applicient_sources.base import ConnectionTestResult, RawPosting, SourceAdapter
from applicient_sources.http_policy import RateLimitedClient, SourceHTTPError

BASE_URL = "https://api.smartrecruiters.com/v1/companies"
_PAGE_SIZE = 100

_TAG_RE = re.compile(r"<[^>]+>")


def _html_to_text(raw_html: str) -> str:
    unescaped = html.unescape(raw_html)
    text = _TAG_RE.sub(" ", unescaped)
    return re.sub(r"\s+", " ", text).strip()


def _posted_at(summary: dict[str, Any]) -> datetime | None:
    raw = summary.get("releasedDate")
    if not raw:
        return None
    try:
        return datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return None


def _section_text(sections: dict[str, Any], key: str) -> str | None:
    section = sections.get(key)
    if not isinstance(section, dict):
        return None
    text = section.get("text")
    return _html_to_text(text) if text else None


def _summary_location(summary: dict[str, Any]) -> str | None:
    loc = summary.get("location") or {}
    return loc.get("fullLocation") or None


def _summary_remote_policy(summary: dict[str, Any]) -> str | None:
    loc = summary.get("location") or {}
    if loc.get("remote"):
        return "remote"
    if loc.get("hybrid"):
        return "hybrid"
    return None


def _job_to_posting(summary: dict[str, Any], detail: dict[str, Any], company: str) -> RawPosting:
    sections = (detail.get("jobAd") or {}).get("sections") or {}
    return RawPosting(
        source_url=detail.get("postingUrl") or "",
        external_requisition_id=summary.get("id"),
        title=summary["name"],
        company_name=(summary.get("company") or {}).get("name") or company,
        location=_summary_location(summary),
        remote_policy=_summary_remote_policy(summary),
        seniority=(summary.get("experienceLevel") or {}).get("label"),
        employment_type=(summary.get("typeOfEmployment") or {}).get("label"),
        posted_at=_posted_at(summary),
        requirements=_section_text(sections, "qualifications"),
        responsibilities=_section_text(sections, "jobDescription"),
        benefits=_section_text(sections, "additionalInformation"),
        apply_url=detail.get("applyUrl") or detail.get("postingUrl"),
        raw_payload={"summary": summary, "detail": detail},
    )


def _identifiers(config: dict[str, Any]) -> list[str]:
    ids = config.get("company_identifiers")
    if isinstance(ids, list) and ids:
        return [str(i) for i in ids]
    single = config.get("company_identifier")
    return [str(single)] if single else []


async def _list_all_postings(
    client: httpx.AsyncClient, rlc: RateLimitedClient, company: str
) -> list[dict[str, Any]]:
    postings: list[dict[str, Any]] = []
    offset = 0
    while True:
        resp = await rlc.get(
            client, f"{BASE_URL}/{company}/postings", params={"limit": _PAGE_SIZE, "offset": offset}
        )
        data = resp.json()
        content = data.get("content", [])
        postings.extend(content)
        offset += len(content)
        if len(content) < _PAGE_SIZE or offset >= data.get("totalFound", 0):
            break
    return postings


class SmartRecruitersAdapter(SourceAdapter):
    adapter_key = "smartrecruiters"
    display_name = "SmartRecruiters"
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
                resp = await rlc.get(client, f"{BASE_URL}/{identifiers[0]}/postings", params={"limit": 1})
        except SourceHTTPError as e:
            status = "auth_failed" if e.status_code == 401 else "unreachable"
            return ConnectionTestResult(ok=False, status=status, error=str(e))

        data = resp.json()
        if "content" not in data:
            return ConnectionTestResult(ok=False, status="unreachable", error="unexpected response shape")
        return ConnectionTestResult(ok=True, status="ok")

    async def search(self, query: str, filters: dict[str, Any], config: dict[str, Any]) -> list[RawPosting]:
        identifiers = _identifiers(config)
        if not identifiers:
            raise ValueError("config.company_identifiers is required for the smartrecruiters adapter")

        query_lower = query.lower().strip()
        location_filter = (filters or {}).get("location")
        loc_lower = location_filter.lower() if location_filter else None

        rlc = RateLimitedClient(base_headers={}, rate_per_minute=self.default_rate_limit_per_minute)
        postings: list[RawPosting] = []
        async with httpx.AsyncClient() as client:
            for company in identifiers:
                # Per-identifier isolation — see workable.py's matching
                # comment (no per-company SourceRun telemetry yet, M2 §6).
                try:
                    summaries = await _list_all_postings(client, rlc, company)
                except SourceHTTPError:
                    continue

                if query_lower:
                    summaries = [s for s in summaries if query_lower in s.get("name", "").lower()]
                if loc_lower:
                    summaries = [
                        s for s in summaries if loc_lower in (_summary_location(s) or "").lower()
                    ]

                for summary in summaries:
                    try:
                        detail_resp = await rlc.get(client, f"{BASE_URL}/{company}/postings/{summary['id']}")
                        detail = detail_resp.json()
                        postings.append(_job_to_posting(summary, detail, company))
                    except (SourceHTTPError, KeyError):
                        continue

        return postings

    async def fetch_detail(self, url: str, config: dict[str, Any]) -> RawPosting:
        # Never called by the pipeline today — search() already fetches
        # detail for every posting it returns. Not implemented for real use.
        raise NotImplementedError(
            "smartrecruiters adapter fetches detail from within search(); fetch_detail is unused"
        )
