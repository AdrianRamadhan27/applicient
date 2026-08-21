"""Recruitee ATS adapter — M2 §4.

Checked against the live public offers API before writing any parsing
code, not assumed:
  - `GET https://{subdomain}.recruitee.com/api/offers/` is public — no
    key, no auth header (`requires_auth = False`). Confirmed live
    against a real board (`channable`, 15 real postings).
  - The list endpoint returns full posting bodies already (`description`,
    `requirements` both real HTML on every offer checked) — no separate
    detail call needed, same shape as Greenhouse/Workable/Ashby, unlike
    SmartRecruiters.
  - `description`/`requirements` are Recruitee's own field names and
    map directly onto this codebase's `RawPosting.responsibilities`/
    `requirements` — the only Tier-1 source so far where the field
    names already line up, not an invented mapping.
  - `on_site`/`hybrid`/`remote` are three independent booleans, not one
    enum — mapped to a single `remote_policy` string (remote takes
    priority, then hybrid), same restraint as SmartRecruiters: `False`/
    `False`/`False` is left null rather than asserted as "onsite,"
    since that specific word is never what the source states.
  - `salary` is a real structured object (`{min, max, period, currency}`)
    on live data — confirmed against a real posting with
    `{"min": "4500", "max": "6000", "period": "month", "currency": "EUR"}`.
    **Deliberately only trusted when `period` is "year"/"annual"** —
    `RawPosting`/`Job.salary_min`/`Preference.salary_floor` all have no
    period concept at all, so a monthly figure written into those
    fields would silently read as if it were annual downstream,
    corrupting the salary-overlap score exactly the way F3.1a exists
    to prevent. Annualizing a monthly/hourly figure would require
    assuming hours/week the source doesn't state, which is itself a
    kind of estimate — left null instead, a real, stated scope cut
    rather than a silent one.
"""

from __future__ import annotations

import html
import re
from datetime import datetime, timezone
from typing import Any

import httpx

from applicient_sources.base import ConnectionTestResult, RawPosting, SourceAdapter
from applicient_sources.http_policy import RateLimitedClient, SourceHTTPError

BASE_URL_TEMPLATE = "https://{subdomain}.recruitee.com/api/offers/"
_ANNUAL_PERIODS = {"year", "annual", "yearly"}

_TAG_RE = re.compile(r"<[^>]+>")


def _html_to_text(raw_html: str) -> str:
    unescaped = html.unescape(raw_html)
    text = _TAG_RE.sub(" ", unescaped)
    return re.sub(r"\s+", " ", text).strip()


def _remote_policy(offer: dict[str, Any]) -> str | None:
    if offer.get("remote"):
        return "remote"
    if offer.get("hybrid"):
        return "hybrid"
    return None


def _posted_at(offer: dict[str, Any]) -> datetime | None:
    raw = offer.get("published_at") or offer.get("created_at")
    if not raw:
        return None
    try:
        # "2026-08-19 10:48:22 UTC" — space-separated, not ISO 8601;
        # confirmed this exact shape live, not assumed from docs.
        return datetime.strptime(raw, "%Y-%m-%d %H:%M:%S %Z").replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def _salary(offer: dict[str, Any]) -> tuple[float | None, float | None, str | None]:
    salary = offer.get("salary")
    if not isinstance(salary, dict):
        return None, None, None
    if (salary.get("period") or "").lower() not in _ANNUAL_PERIODS:
        return None, None, None
    try:
        lo = float(salary["min"]) if salary.get("min") is not None else None
        hi = float(salary["max"]) if salary.get("max") is not None else None
    except (TypeError, ValueError):
        return None, None, None
    currency = salary.get("currency")
    return lo, hi, (currency.upper() if isinstance(currency, str) else None)


def _job_to_posting(offer: dict[str, Any], subdomain: str) -> RawPosting:
    description = offer.get("description")
    requirements = offer.get("requirements")
    salary_min, salary_max, salary_currency = _salary(offer)

    return RawPosting(
        source_url=offer.get("careers_url") or "",
        external_requisition_id=offer.get("guid") or (str(offer["id"]) if offer.get("id") is not None else None),
        title=offer["title"],
        company_name=offer.get("company_name") or subdomain,
        location=offer.get("location"),
        remote_policy=_remote_policy(offer),
        seniority=(offer.get("experience_code") or "").replace("_", " ") or None,
        employment_type=(offer.get("employment_type_code") or "").replace("_", " ") or None,
        salary_min=salary_min,
        salary_max=salary_max,
        salary_currency=salary_currency,
        posted_at=_posted_at(offer),
        requirements=_html_to_text(requirements) if requirements else None,
        responsibilities=_html_to_text(description) if description else None,
        apply_url=offer.get("careers_apply_url") or offer.get("careers_url"),
        raw_payload=offer,
    )


def _identifiers(config: dict[str, Any]) -> list[str]:
    ids = config.get("company_identifiers")
    if isinstance(ids, list) and ids:
        return [str(i) for i in ids]
    single = config.get("company_identifier")
    return [str(single)] if single else []


class RecruiteeAdapter(SourceAdapter):
    adapter_key = "recruitee"
    display_name = "Recruitee"
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
                resp = await rlc.get(client, BASE_URL_TEMPLATE.format(subdomain=identifiers[0]))
        except SourceHTTPError as e:
            status = "auth_failed" if e.status_code == 401 else "unreachable"
            return ConnectionTestResult(ok=False, status=status, error=str(e))

        data = resp.json()
        if "offers" not in data:
            return ConnectionTestResult(ok=False, status="unreachable", error="unexpected response shape")
        return ConnectionTestResult(ok=True, status="ok")

    async def search(self, query: str, filters: dict[str, Any], config: dict[str, Any]) -> list[RawPosting]:
        identifiers = _identifiers(config)
        if not identifiers:
            raise ValueError("config.company_identifiers is required for the recruitee adapter")

        rlc = RateLimitedClient(base_headers={}, rate_per_minute=self.default_rate_limit_per_minute)
        postings: list[RawPosting] = []
        async with httpx.AsyncClient() as client:
            for subdomain in identifiers:
                # Per-identifier isolation — see workable.py's matching
                # comment (no per-company SourceRun telemetry yet, M2 §6).
                try:
                    resp = await rlc.get(client, BASE_URL_TEMPLATE.format(subdomain=subdomain))
                    data = resp.json()
                    postings.extend(_job_to_posting(offer, subdomain) for offer in data.get("offers", []))
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
        # full detail per posting.
        raise NotImplementedError("recruitee adapter returns full detail from search(); fetch_detail is unused")
