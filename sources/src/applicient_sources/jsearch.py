"""JSearch (RapidAPI) aggregator adapter — the M1 Tier-1 aggregator
(PRD §2.2, M1 §2).

**Confidence gap, stated plainly:** unlike Greenhouse, this was NOT
verified against a real live response — JSearch requires a paid
RapidAPI key I don't have, and its docs page is a client-rendered SPA
WebFetch can't read. Field names below are corroborated across two
independent secondary sources (a docs mirror and someone's working
request code showing the endpoint/headers/query-param names), not a
single authoritative spec and not a live call. Treat this adapter as
"built from the best available documentation, unverified" until the
opt-in live smoke test (test_live_search, requires JSEARCH_API_KEY)
has actually been run once against a real key — that is the real
verification gate, not this docstring's confidence. Salary currency
in particular has no corroborated field name anywhere I could find;
handled defensively below rather than guessed.

Corroborated request shape: GET https://jsearch.p.rapidapi.com/search
with headers X-RapidAPI-Key / X-RapidAPI-Host: jsearch.p.rapidapi.com,
query params query/page/num_pages/date_posted/employment_types/
remote_jobs_only. Response: {status, request_id, parameters, data:[...]}.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

import httpx

from applicient_sources.base import ConnectionTestResult, RawPosting, SourceAdapter
from applicient_sources.http_policy import RateLimitedClient, SourceHTTPError

BASE_URL = "https://jsearch.p.rapidapi.com"
API_HOST = "jsearch.p.rapidapi.com"


def _job_to_posting(job: dict[str, Any]) -> RawPosting:
    posted_at = None
    posted_raw = job.get("job_posted_at_datetime_utc")
    if posted_raw:
        try:
            posted_at = datetime.fromisoformat(posted_raw.replace("Z", "+00:00")).astimezone(timezone.utc)
        except ValueError:
            posted_at = None

    highlights = job.get("job_highlights") or {}
    qualifications = highlights.get("Qualifications") or []
    responsibilities = highlights.get("Responsibilities") or []
    benefits = highlights.get("Benefits") or []

    location_parts = [p for p in (job.get("job_city"), job.get("job_state"), job.get("job_country")) if p]
    location = ", ".join(location_parts) if location_parts else job.get("job_location")

    employment_types = job.get("job_employment_types") or (
        [job["job_employment_type"]] if job.get("job_employment_type") else []
    )

    return RawPosting(
        source_url=job.get("job_apply_link") or job.get("job_google_link", ""),
        external_requisition_id=job.get("job_id"),
        title=job["job_title"],
        company_name=job.get("employer_name") or "unknown",
        location=location,
        remote_policy="remote" if job.get("job_is_remote") else None,
        seniority=job.get("seniority_level"),
        employment_type=", ".join(employment_types) if employment_types else None,
        salary_min=job.get("job_min_salary"),
        salary_max=job.get("job_max_salary"),
        # No corroborated currency field name anywhere in the docs I
        # could reach — never invented. Left null unless a future live
        # call actually reveals one; downstream (F3.1a) already treats
        # a missing currency as "not stated," which is the honest
        # state here regardless.
        salary_currency=job.get("job_salary_currency"),
        posted_at=posted_at,
        requirements="\n".join(qualifications) if qualifications else job.get("job_description"),
        responsibilities="\n".join(responsibilities) if responsibilities else None,
        benefits="\n".join(benefits) if benefits else None,
        apply_url=job.get("job_apply_link"),
        raw_payload=job,
    )


class JSearchAdapter(SourceAdapter):
    adapter_key = "jsearch"
    display_name = "JSearch"
    requires_auth = True
    default_rate_limit_per_minute = 10  # RapidAPI free/basic tiers are tightly capped

    def _headers(self, config: dict[str, Any]) -> dict[str, str]:
        api_key = config.get("api_key")
        if not api_key:
            raise ValueError("config.api_key is required for the jsearch adapter")
        return {"X-RapidAPI-Key": api_key, "X-RapidAPI-Host": API_HOST}

    async def test_connection(self, config: dict[str, Any]) -> ConnectionTestResult:
        try:
            headers = self._headers(config)
        except ValueError as e:
            return ConnectionTestResult(ok=False, status="unreachable", error=str(e))

        rlc = RateLimitedClient(base_headers=headers, rate_per_minute=self.default_rate_limit_per_minute)
        try:
            async with httpx.AsyncClient() as client:
                resp = await rlc.get(client, f"{BASE_URL}/search", params={"query": "test", "num_pages": "1"})
        except SourceHTTPError as e:
            # F2.8/F2.2 — "a missing or invalid aggregator key must fail
            # that source run clearly without failing the whole radar
            # run": surfacing auth_failed specifically (not a generic
            # unreachable) is what lets the caller show that message.
            status = "auth_failed" if e.status_code in (401, 403) else "unreachable"
            return ConnectionTestResult(ok=False, status=status, error=str(e))

        data = resp.json()
        if data.get("status") != "OK" and "data" not in data:
            return ConnectionTestResult(ok=False, status="unreachable", error="unexpected response shape")
        return ConnectionTestResult(ok=True, status="ok")

    async def search(self, query: str, filters: dict[str, Any], config: dict[str, Any]) -> list[RawPosting]:
        headers = self._headers(config)
        rlc = RateLimitedClient(base_headers=headers, rate_per_minute=self.default_rate_limit_per_minute)

        params: dict[str, str] = {"query": query, "num_pages": str(config.get("num_pages", 1))}
        if filters.get("location"):
            params["query"] = f"{query} in {filters['location']}"
        if filters.get("remote"):
            params["remote_jobs_only"] = "true"
        if filters.get("employment_type"):
            params["employment_types"] = filters["employment_type"]

        async with httpx.AsyncClient() as client:
            resp = await rlc.get(client, f"{BASE_URL}/search", params=params)
        data = resp.json()
        return [_job_to_posting(job) for job in data.get("data", [])]

    async def fetch_detail(self, url: str, config: dict[str, Any]) -> RawPosting:
        # JSearch has no documented single-job detail-by-URL endpoint
        # (corroborated sources only show /search) — a job_id-based
        # detail lookup may exist but is unverified, so this honestly
        # raises rather than guess an endpoint shape. search() already
        # returns full postings including job_highlights, so nothing
        # in M1 actually needs this path for JSearch specifically.
        raise NotImplementedError(
            "JSearch has no verified single-job detail endpoint — search() already returns full postings"
        )
