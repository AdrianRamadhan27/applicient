"""JobSpy-backed multi-board adapter (LinkedIn/Indeed/Glassdoor/Google/
ZipRecruiter), raised explicitly by Adrian and built with his informed
go-ahead — this is a materially different risk category from every
other adapter in this package.

**This is not a public API — it's scraping, and JobSpy's own
dependency on `tls-client` (browser TLS-fingerprint spoofing) means it
actively evades bot detection, not just "reads a page."** LinkedIn and
Indeed both prohibit automated scraping in their terms of service.
This adapter exists because Adrian explicitly chose this tradeoff
after being told about it plainly (see M1_IMPLEMENTATION.md's log) —
not a default anyone should reach for. `requires_auth = False` here
means "no API key," not "no risk."

Verified live before writing this (`scrape_jobs()` from the
`python-jobspy` package, MIT-licensed):
  - Real column names on the returned DataFrame (lowercase snake_case,
    confirmed directly — a secondhand doc summary had them
    capitalized, which was wrong): `id`, `site`, `job_url`,
    `job_url_direct`, `title`, `company`, `location`, `date_posted`,
    `job_type`, `interval`, `min_amount`, `max_amount`, `currency`,
    `is_remote`, `description`, among others.
  - `id` (e.g. `"in-106fb77c3e20b5fd"`) is derived from the source
    site's own job key (confirmed against the matching `job_url`'s
    `jk=` parameter for an Indeed result) — deterministic and stable
    enough to use as `external_requisition_id` for our own dedup.
  - `date_posted` comes back as a plain `datetime.date`, not
    `datetime` — converted to UTC midnight below since RawPosting
    needs an actual `datetime`.
  - Numeric fields (`min_amount`, `max_amount`, etc.) come back as
    `float('nan')` when absent, not `None` — pandas' NaN is not the
    same as Python `None` and is not JSON-serializable as-is; cleaned
    via `_clean_value` before use.
  - LinkedIn worked for a small live request (3 results, no proxy)
    without issue — but JobSpy's own docs are explicit that it "rate
    limits around the 10th page" on one IP and call proxies "a must
    basically" past that. No proxy support is wired in yet
    (`config.proxies` is read and passed through if set, but nothing
    defaults one in) — expect LinkedIn results to degrade or stop
    under real, repeated use. That's accepted, not a bug to fix here.
  - `scrape_jobs()` is a genuinely blocking, synchronous call (built
    on `requests`, not async) — run through `asyncio.to_thread` inside
    `search()`/`test_connection()` so it doesn't stall the radar run's
    event loop, same fix already applied elsewhere (query expansion,
    job embedding) for the same class of bug.

Scope: Bayt (Middle East), Naukri (India), and BDJobs (Bangladesh) are
supported by the underlying library but not wired in here — regional
boards outside what was asked for, easy to add later following the
same pattern if ever needed.
"""

from __future__ import annotations

import logging
import math
from asyncio import to_thread
from datetime import date, datetime, time, timezone
from typing import Any

from applicient_sources.base import ConnectionTestResult, RawPosting, SourceAdapter

_logger = logging.getLogger(__name__)

_VALID_SITES = {"indeed", "linkedin", "glassdoor", "google", "zip_recruiter"}
_DEFAULT_SITES = ["indeed"]  # JobSpy's own docs call this "the best scraper currently, no rate limiting"
_DEFAULT_RESULTS_WANTED = 15  # bounded on purpose — this is a slow, blockable call, not a cheap API request

# Raised by Adrian, live: a real Indeed DNS resolution failure
# ("apis.indeed.com... Failed to resolve") followed by what looked
# like a second, unrelated failure — this is the same class of bug the
# existing Glassdoor handling below already covers, just for a network
# failure instead of a business-logic one: `scrape_jobs()` scrapes every
# requested site inside ONE blocking call, and any single site raising
# kills the return value for every OTHER site too, even ones that would
# have worked. `apis.indeed.com`/`linkedin.com`/etc. are jobspy's own
# real hostnames (confirmed directly against its installed source, not
# guessed), so a hostname match plus a connection-failure-shaped
# message is a real, specific signal that THIS site (not the whole
# call) is what's actually broken right now.
_SITE_HOSTNAMES = {
    "indeed": "indeed.com",
    "linkedin": "linkedin.com",
    "glassdoor": "glassdoor.com",
    "zip_recruiter": "ziprecruiter.com",
    "google": "google.com",
}
_CONNECTION_FAILURE_MARKERS = (
    "failed to resolve",
    "nodename nor servname",
    "name or service not known",
    "max retries exceeded",
    "remote error",
    "connection refused",
    "connection reset",
    "nameresolutionerror",
)


def _connection_failure_site(exc: Exception, sites: list[str]) -> str | None:
    """Which requested site, if any, this exception's own message
    implicates as the actual point of failure — only meaningful
    alongside a connection-failure-shaped message, never used to
    swallow a real application-level error from a site that's
    otherwise working."""

    text = str(exc).lower()
    if not any(marker in text for marker in _CONNECTION_FAILURE_MARKERS):
        return None
    for site in sites:
        hostname = _SITE_HOSTNAMES.get(site)
        if hostname and hostname in text:
            return site
    return None


def _clean_value(value: Any) -> Any:
    """pandas/JobSpy hand back types that aren't JSON-safe as-is:
    `float('nan')` for absent numeric/text cells (not `None` — nan is
    neither falsy-safe nor JSON-serializable as a plain float), and
    `date_posted` as a plain `datetime.date` (confirmed live — every
    other field checked across a real multi-site sample came back as
    a plain builtin type, but this one specifically didn't). Every
    RawPosting here gets its `raw_payload` written straight into a
    JSONB column (JobSighting.raw_posting), so this has to actually
    hold for every field, not just the ones referenced by name below —
    hence the generic `date`/`datetime` branch and the `str()`
    fallback for anything else unrecognized, rather than only handling
    the two cases observed live."""

    if isinstance(value, float) and math.isnan(value):
        return None
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    if isinstance(value, (list, dict)):
        return value
    return str(value)


def _to_datetime(value: Any) -> datetime | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if isinstance(value, date):
        return datetime.combine(value, time.min, tzinfo=timezone.utc)
    return None


def _row_to_posting(row: dict[str, Any]) -> RawPosting:
    # posted_at needs the ORIGINAL date/datetime object — _clean_value
    # below turns it into an ISO string for JSON-safe raw_payload
    # storage, which would otherwise make _to_datetime see a plain str
    # and silently drop it if this ran after cleaning instead of before.
    posted_at = _to_datetime(row.get("date_posted"))
    row = {k: _clean_value(v) for k, v in row.items()}
    return RawPosting(
        source_url=row.get("job_url") or "",
        external_requisition_id=row.get("id"),
        title=row["title"],
        company_name=row.get("company") or "unknown",
        location=row.get("location"),
        # JobSpy only ever states a boolean is_remote — never invent
        # "hybrid"/"onsite" from a flag that can't say that.
        remote_policy="remote" if row.get("is_remote") else None,
        employment_type=row.get("job_type"),
        salary_min=row.get("min_amount"),
        salary_max=row.get("max_amount"),
        salary_currency=row.get("currency"),
        posted_at=posted_at,
        requirements=row.get("description"),
        apply_url=row.get("job_url_direct") or row.get("job_url"),
        raw_payload=row,
    )


def _parse_sites(config: dict[str, Any]) -> list[str]:
    raw = config.get("sites")
    if not raw:
        return _DEFAULT_SITES
    sites = [s.strip() for s in raw.split(",") if s.strip()]
    unknown = [s for s in sites if s not in _VALID_SITES]
    if unknown:
        raise ValueError(f"unknown jobspy site(s) {unknown!r} — known: {sorted(_VALID_SITES)}")
    return sites or _DEFAULT_SITES


def _parse_proxies(config: dict[str, Any]) -> list[str] | None:
    raw = config.get("proxies")
    if not raw:
        return None
    return [p.strip() for p in raw.split(",") if p.strip()]


# Indeed and Glassdoor are both country-scoped on JobSpy's side —
# `country_indeed` isn't optional for them (confirmed live: passing
# None crashes with "'NoneType' object has no attribute 'strip'",
# not a graceful default). The first version of this adapter silently
# defaulted to "USA" instead of requiring it — found live, the hard
# way: a real Indonesia search on Indeed returned an empty list with
# no error at all, because "USA" scoping made "Indonesia" resolve to
# nothing, not because nothing was posted. Silently wrong is worse
# than loudly missing, so this is required now whenever either site
# is selected, matching every other adapter's "raise a clear
# ValueError for missing required config" discipline.
_COUNTRY_SCOPED_SITES = {"indeed", "glassdoor"}


def _resolve_country(config: dict[str, Any], sites: list[str]) -> str | None:
    country = config.get("country")
    if country:
        return country
    if any(s in _COUNTRY_SCOPED_SITES for s in sites):
        raise ValueError(
            "config.country is required when 'indeed' or 'glassdoor' is selected — "
            "e.g. 'Indonesia', 'USA', 'United Kingdom' (whatever JobSpy/Indeed's own "
            "country list accepts). Without it, Indeed silently returns zero results "
            "for a location outside a default country, not an error."
        )
    return None


class JobSpyAdapter(SourceAdapter):
    adapter_key = "jobspy"
    display_name = "Multi-board (JobSpy: LinkedIn/Indeed/Glassdoor/Google/ZipRecruiter)"
    requires_auth = False
    default_rate_limit_per_minute = 10  # this is scraping, not an API — deliberately conservative

    async def test_connection(self, config: dict[str, Any]) -> ConnectionTestResult:
        try:
            sites = _parse_sites(config)
        except ValueError as e:
            return ConnectionTestResult(ok=False, status="unreachable", error=str(e))

        try:
            country = _resolve_country(config, [sites[0]])
        except ValueError as e:
            return ConnectionTestResult(ok=False, status="unreachable", error=str(e))

        try:
            from jobspy import scrape_jobs

            kwargs: dict[str, Any] = dict(
                search_term="software engineer",
                results_wanted=1,
                proxies=_parse_proxies(config),
            )
            # JobSpy's own `country_indeed` parameter defaults to
            # "usa" when omitted, but crashes with "'NoneType' object
            # has no attribute 'strip'" if explicitly passed `None` —
            # found live testing a LinkedIn-only source: `_resolve_country`
            # correctly returns `None` when no country-scoped site
            # (indeed/glassdoor) is selected, since a bare, unscoped
            # site genuinely has no country requirement, but that
            # `None` was still being forwarded into a kwarg JobSpy
            # insists on receiving as a real string regardless of
            # which site is actually being scraped. Only include the
            # kwarg at all when there's a real value — letting
            # JobSpy fall back to its own default is what avoids this,
            # not supplying a fake placeholder ourselves.
            if country is not None:
                kwargs["country_indeed"] = country
            if sites[0] == "linkedin":
                kwargs["linkedin_fetch_description"] = True
            df = await to_thread(scrape_jobs, site_name=[sites[0]], **kwargs)
        except Exception as e:
            return ConnectionTestResult(ok=False, status="unreachable", error=str(e)[:300])

        if df is None or len(df) == 0:
            # Not necessarily broken — could be a genuinely empty
            # result for this query — but nothing to confirm success
            # with either, so surfaced honestly rather than assumed ok.
            return ConnectionTestResult(ok=False, status="unreachable", error="scrape returned zero results")
        return ConnectionTestResult(ok=True, status="ok")

    async def search(self, query: str, filters: dict[str, Any], config: dict[str, Any]) -> list[RawPosting]:
        sites = _parse_sites(config)
        country = _resolve_country(config, sites)
        df = await self._scrape(sites, query, filters, config, country)
        if df is None or len(df) == 0:
            return []
        return [_row_to_posting(row) for row in df.to_dict(orient="records")]

    async def _scrape(
        self, sites: list[str], query: str, filters: dict[str, Any], config: dict[str, Any], country: str | None
    ):
        from jobspy import scrape_jobs

        kwargs: dict[str, Any] = dict(
            search_term=query or None,
            location=(filters or {}).get("location"),
            is_remote=bool((filters or {}).get("remote")),
            results_wanted=int(config.get("results_wanted") or _DEFAULT_RESULTS_WANTED),
            proxies=_parse_proxies(config),
        )
        # JobSpy's LinkedIn scraper only reads the full job description
        # off a job's own detail page, not the search-results page —
        # `_process_job()` in jobspy's own source only calls
        # `_get_job_details()` (the thing that actually sets
        # `description`) when `linkedin_fetch_description=True`, which
        # defaults to False. Left at that default, every LinkedIn
        # posting comes back with `description=None` — confirmed
        # directly against jobspy's installed source, not a guess or a
        # secondhand GitHub issue — which is why LinkedIn jobs never
        # had any text for the scoring rubric to quote as evidence.
        # Costs one extra page fetch per job (this is what actually
        # makes it opt-in upstream, not a hidden default), but a
        # LinkedIn posting with no description is useless for scoring
        # anyway, so there's no real tradeoff worth preserving here.
        if "linkedin" in sites:
            kwargs["linkedin_fetch_description"] = True
        # See test_connection's identical guard for why `None` can't
        # just be forwarded as `country_indeed` — a LinkedIn/Google/
        # ZipRecruiter-only search legitimately has `country is None`
        # here (no indeed/glassdoor selected), and JobSpy crashes on
        # an explicit `None`, not just a missing kwarg.
        if country is not None:
            kwargs["country_indeed"] = country
        try:
            return await to_thread(scrape_jobs, site_name=sites, **kwargs)
        except Exception as e:
            # Glassdoor doesn't operate in every country JobSpy's own
            # Country enum accepts — confirmed live: a raw, uncaught
            # `Exception("Glassdoor is not available for INDONESIA")`
            # from inside JobSpy itself, which kills scrape_jobs()'s
            # *entire* multi-site call before it returns anything —
            # Indeed alone had 5 real results for the exact same
            # search that this crash reduced to zero. Retrying without
            # glassdoor recovers the sites that actually work instead
            # of losing everything to one incompatible one.
            if "glassdoor" in sites and "glassdoor is not available" in str(e).lower():
                remaining = [s for s in sites if s != "glassdoor"]
                if not remaining:
                    raise
                # Logged, not just handled silently: this is a caught
                # Python exception, not something JobSpy's own logging
                # module reports — without this line, the live-log
                # stream a caller may be watching (radar.py's
                # run_with_live_logs) shows nothing at all for this
                # recovery, even though a real site just got dropped.
                _logger.warning("glassdoor unavailable for country=%r — retrying without it (%s)", country, e)
                return await to_thread(scrape_jobs, site_name=remaining, **kwargs)

            # Raised live: a real Indeed DNS resolution failure took
            # down an entire multi-site call. Same fix shape as
            # glassdoor above, generalized to any site whose own
            # hostname shows up in a connection-failure-shaped message
            # — a real network blip for one site shouldn't cost the
            # results of every other site in the same call.
            failed_site = _connection_failure_site(e, sites)
            if failed_site is not None:
                remaining = [s for s in sites if s != failed_site]
                if not remaining:
                    raise
                _logger.warning(
                    "%s unreachable (network failure) — retrying without it (%s)", failed_site, e
                )
                return await to_thread(scrape_jobs, site_name=remaining, **kwargs)
            raise

    async def fetch_detail(self, url: str, config: dict[str, Any]) -> RawPosting:
        # JobSpy has no by-URL detail lookup — search() already returns
        # full postings including description, same reasoning as the
        # JSearch/RemoteOK adapters.
        raise NotImplementedError("jobspy has no single-job detail endpoint — search() already returns full postings")
