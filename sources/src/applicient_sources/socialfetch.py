"""SocialFetch adapter — a paid, credit-metered LinkedIn jobs API
(PRD §2.2), raised explicitly by Adrian.

**This is a scraping service wrapped as an API, not an official
LinkedIn partnership** — SocialFetch's own marketing copy talks about
maintaining "scrapers" and handling "DOM shifts and schema drift,"
and its FAQ puts ToS/legal responsibility on the caller ("responsible
for how you use it under your contracts, platform terms, and
applicable law"), not on itself. Same risk category as the `jobspy`
adapter, wired in for the same reason and with the same informed
go-ahead — not a default choice.

Unlike jsearch.py, this one was NOT built from secondhand doc
summaries or corroborated guesses — the exact field/endpoint shapes
below are read directly from SocialFetch's own machine-readable
`GET https://api.socialfetch.dev/openapi.json` (fetched and inspected
before writing any parsing code), which is a materially higher
confidence level than JSearch had. What's still unverified is
runtime behavior against a real key (no key was available while
writing this — Adrian will test it live from the GUI):
  - `GET /v1/linkedin/jobs/search` requires both `keyword` and
    `location` (per the spec's `required: true`) — `location` isn't
    optional here the way it is for the other Tier-1 adapters, so
    `search()` raises a clear `ValueError` rather than silently
    dropping the filter when a saved search doesn't specify one.
  - Response envelope is `{"data": {...}, "meta": {...}}` on success
    and `{"error": {"code": ..., ...}}` on failure — confirmed from
    the spec's response schemas, not the `{ok, value}` shape shown in
    SocialFetch's own TypeScript SDK example (that's the SDK's local
    Result-wrapper over this raw HTTP shape, not the wire format).
  - Pricing (from `x-socialfetch-credits-pricing` in the spec): 2
    credits per search attempt + 2 credits per job actually returned,
    capped at 1000 results/request. `limit` defaults to 10 in the API
    but this adapter defaults it to 5 (Adrian's own number) to keep a
    single search's cost predictable — the 100 free signup credits
    cover roughly 8 searches at that rate (2 + 2*5 = 12 credits/search).
  - `GET /v1/balance` returns `{"data": {"balance": <int>, ...}}` and
    costs 0 credits — used for `test_connection` so testing a
    connection never burns a search's worth of credits. A `balance`
    of exactly 0 is treated as a distinct failure reason ("out of
    credits", not "invalid key") per Adrian's own note that this is
    how a spent-out key shows up.
  - No job field in the schema states remote/hybrid/onsite directly —
    `remote_policy` is only set when the search itself was filtered
    to `remote=remote`, in which case every result really is remote
    by construction; otherwise left null rather than guessed from the
    location string.
  - `postedDate` (ISO-8601, "when available") is used for `posted_at`;
    `postedAt` (a relative/absolute display label like "3 days ago")
    is not — never date-parsed from a label string.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

import httpx

from applicient_sources.base import ConnectionTestResult, RawPosting, SourceAdapter
from applicient_sources.http_policy import RateLimitedClient, SourceHTTPError

BASE_URL = "https://api.socialfetch.dev"
DEFAULT_LIMIT = 5

# A live LinkedIn scrape genuinely takes longer than a normal REST call
# — RateLimitedClient's default 20s timeout was found live to be too
# aggressive for this endpoint specifically, causing real, billed
# searches to read-timeout on our side well before SocialFetch itself
# gave up (see http_policy.py's ConnectTimeout/read-timeout split for
# why a read timeout is no longer retried at all: retrying here would
# just re-run and re-bill the same paid search).
_SEARCH_TIMEOUT_SECONDS = 60.0


def _headers(config: dict[str, Any]) -> dict[str, str]:
    api_key = config.get("api_key")
    if not api_key:
        raise ValueError("config.api_key is required for the socialfetch adapter")
    return {"x-api-key": api_key}


def _posted_at(job: dict[str, Any]) -> datetime | None:
    raw = job.get("postedDate")
    if not raw:
        return None
    try:
        return datetime.fromisoformat(raw.replace("Z", "+00:00")).astimezone(timezone.utc)
    except ValueError:
        return None


def _job_to_posting(job: dict[str, Any], *, forced_remote: bool) -> RawPosting:
    base_salary = job.get("baseSalary") or {}
    return RawPosting(
        source_url=job.get("url") or "",
        external_requisition_id=job.get("id"),
        title=job.get("title") or "untitled",
        company_name=job.get("companyName") or "unknown",
        location=job.get("location"),
        remote_policy="remote" if forced_remote else None,
        seniority=job.get("seniorityLevel"),
        employment_type=job.get("employmentType"),
        salary_min=base_salary.get("minAmount"),
        salary_max=base_salary.get("maxAmount"),
        salary_currency=base_salary.get("currency"),
        posted_at=_posted_at(job),
        requirements=job.get("descriptionFormatted") or job.get("summary"),
        apply_url=job.get("applyLink") or job.get("url"),
        raw_payload=job,
    )


class SocialFetchAdapter(SourceAdapter):
    adapter_key = "socialfetch"
    display_name = "SocialFetch (LinkedIn, paid/credit-metered)"
    requires_auth = True
    default_rate_limit_per_minute = 10
    credit_metered = True

    async def test_connection(self, config: dict[str, Any]) -> ConnectionTestResult:
        try:
            headers = _headers(config)
        except ValueError as e:
            return ConnectionTestResult(ok=False, status="unreachable", error=str(e))

        rlc = RateLimitedClient(base_headers=headers, rate_per_minute=self.default_rate_limit_per_minute)
        try:
            async with httpx.AsyncClient() as client:
                resp = await rlc.get(client, f"{BASE_URL}/v1/balance")
        except SourceHTTPError as e:
            status = "auth_failed" if e.status_code == 401 else "unreachable"
            return ConnectionTestResult(ok=False, status=status, error=str(e))

        data = resp.json().get("data", {})
        balance = data.get("balance")
        if balance is None:
            return ConnectionTestResult(ok=False, status="unreachable", error="unexpected response shape")
        if balance == 0:
            # Adrian's own note: a 0 balance is how an exhausted key
            # shows up, not necessarily an invalid one — surfaced
            # distinctly rather than lumped in with "unreachable".
            return ConnectionTestResult(ok=False, status="unreachable", error="0 credits remaining on this key")
        return ConnectionTestResult(ok=True, status="ok")

    async def search(self, query: str, filters: dict[str, Any], config: dict[str, Any]) -> list[RawPosting]:
        headers = _headers(config)
        location = (filters or {}).get("location")
        if not location:
            raise ValueError(
                "socialfetch requires a location filter — LinkedIn's search API has no location-less mode"
            )

        params: dict[str, str] = {
            "keyword": query or "jobs",
            "location": location,
            "limit": str(config.get("results_wanted") or DEFAULT_LIMIT),
        }
        forced_remote = bool((filters or {}).get("remote"))
        if forced_remote:
            params["remote"] = "remote"
        if filters.get("employment_type"):
            params["jobType"] = filters["employment_type"]

        rlc = RateLimitedClient(
            base_headers=headers,
            rate_per_minute=self.default_rate_limit_per_minute,
            timeout_seconds=_SEARCH_TIMEOUT_SECONDS,
        )
        async with httpx.AsyncClient() as client:
            resp = await rlc.get(client, f"{BASE_URL}/v1/linkedin/jobs/search", params=params)
        jobs = resp.json().get("data", {}).get("jobs", [])
        return [_job_to_posting(job, forced_remote=forced_remote) for job in jobs]

    async def fetch_detail(self, url: str, config: dict[str, Any]) -> RawPosting:
        # search() already returns full postings (including
        # descriptionFormatted) — no separate per-job endpoint is
        # needed for anything M1 does, same reasoning as the other
        # adapters' fetch_detail.
        raise NotImplementedError("socialfetch: search() already returns full postings, no detail endpoint needed")
