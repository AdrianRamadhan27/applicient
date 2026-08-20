"""M1 §2 — JobSpy-backed adapter contract tests. Offline tests mock
`jobspy.scrape_jobs` directly (not httpx — this adapter doesn't call
httpx at all, unlike every other one in this package) with a small
synthetic DataFrame matching the real, live-verified column shape
(see jobspy_source.py's module docstring). The `live` test is opt-in
and genuinely hits LinkedIn/Indeed — real scraping, not a public API.
"""

from datetime import date

import pandas as pd
import pytest

from applicient_sources.jobspy_source import JobSpyAdapter

FIXTURE_ROWS = [
    {
        "id": "in-abc123",
        "site": "indeed",
        "job_url": "https://www.indeed.com/viewjob?jk=abc123",
        "job_url_direct": "https://example.com/careers/abc123",
        "title": "Senior Data Engineer",
        "company": "Acme Corp",
        "location": "Austin, TX, US",
        "date_posted": date(2026, 8, 15),
        "job_type": "fulltime",
        "interval": "yearly",
        "min_amount": 140000.0,
        "max_amount": 180000.0,
        "currency": "USD",
        "is_remote": False,
        "description": "Build data pipelines.",
    },
    {
        "id": "li-xyz789",
        "site": "linkedin",
        "job_url": "https://www.linkedin.com/jobs/view/xyz789",
        "job_url_direct": None,
        "title": "Remote Backend Engineer",
        "company": "Globex",
        "location": "Remote",
        "date_posted": date(2026, 8, 18),
        "job_type": None,
        "interval": None,
        "min_amount": float("nan"),
        "max_amount": float("nan"),
        "currency": None,
        "is_remote": True,
        "description": "Ship backend services.",
    },
]


def _fixture_df() -> pd.DataFrame:
    return pd.DataFrame(FIXTURE_ROWS)


@pytest.fixture
def adapter() -> JobSpyAdapter:
    return JobSpyAdapter()


async def test_search_parses_all_rows(adapter, monkeypatch):
    monkeypatch.setattr("jobspy.scrape_jobs", lambda **kw: _fixture_df())

    postings = await adapter.search("engineer", {}, {"sites": "indeed,linkedin", "country": "USA"})
    assert len(postings) == 2
    assert {p.title for p in postings} == {"Senior Data Engineer", "Remote Backend Engineer"}


async def test_nan_salary_becomes_none(adapter, monkeypatch):
    monkeypatch.setattr("jobspy.scrape_jobs", lambda **kw: _fixture_df())

    postings = await adapter.search("engineer", {}, {"sites": "linkedin"})
    remote_job = next(p for p in postings if p.title == "Remote Backend Engineer")
    assert remote_job.salary_min is None
    assert remote_job.salary_max is None


async def test_real_salary_is_preserved(adapter, monkeypatch):
    monkeypatch.setattr("jobspy.scrape_jobs", lambda **kw: _fixture_df())

    postings = await adapter.search("engineer", {}, {"sites": "indeed", "country": "USA"})
    job = next(p for p in postings if p.title == "Senior Data Engineer")
    assert job.salary_min == 140000.0
    assert job.salary_max == 180000.0
    assert job.salary_currency == "USD"


async def test_is_remote_maps_to_remote_policy(adapter, monkeypatch):
    monkeypatch.setattr("jobspy.scrape_jobs", lambda **kw: _fixture_df())

    postings = await adapter.search("engineer", {}, {"sites": "indeed,linkedin", "country": "USA"})
    by_title = {p.title: p.remote_policy for p in postings}
    assert by_title["Senior Data Engineer"] is None
    assert by_title["Remote Backend Engineer"] == "remote"


async def test_date_posted_converted_to_datetime(adapter, monkeypatch):
    monkeypatch.setattr("jobspy.scrape_jobs", lambda **kw: _fixture_df())

    postings = await adapter.search("engineer", {}, {"sites": "indeed,linkedin", "country": "USA"})
    assert all(p.posted_at is not None and p.posted_at.tzinfo is not None for p in postings)


async def test_raw_payload_is_json_serializable(adapter, monkeypatch):
    import json

    monkeypatch.setattr("jobspy.scrape_jobs", lambda **kw: _fixture_df())

    postings = await adapter.search("engineer", {}, {"sites": "indeed,linkedin", "country": "USA"})
    for p in postings:
        json.dumps(p.raw_payload)  # raises if anything isn't JSON-native


async def test_empty_results_returns_empty_list(adapter, monkeypatch):
    monkeypatch.setattr("jobspy.scrape_jobs", lambda **kw: pd.DataFrame())

    postings = await adapter.search("nonexistent role xyz", {}, {"country": "USA"})
    assert postings == []


async def test_unknown_site_raises(adapter):
    with pytest.raises(ValueError, match="unknown jobspy site"):
        await adapter.search("engineer", {}, {"sites": "not_a_real_site"})


async def test_missing_country_raises_for_indeed(adapter):
    # Found live: silently defaulting this to "USA" made a real
    # Indonesia search return zero results with no error at all,
    # indistinguishable from "nothing posted." Required now instead.
    with pytest.raises(ValueError, match="country"):
        await adapter.search("engineer", {}, {"sites": "indeed"})


async def test_missing_country_not_required_for_linkedin(adapter, monkeypatch):
    monkeypatch.setattr("jobspy.scrape_jobs", lambda **kw: _fixture_df())

    # Should not raise — LinkedIn/Google/ZipRecruiter aren't country-scoped.
    # (the mock doesn't filter by site, so both fixture rows come back —
    # the point here is the missing-country ValueError, not the count.)
    postings = await adapter.search("engineer", {}, {"sites": "linkedin"})
    assert len(postings) == 2


async def test_glassdoor_unsupported_country_falls_back_to_remaining_sites(adapter, monkeypatch):
    # Reproduces a real live failure: Glassdoor doesn't operate in
    # every country JobSpy's Country enum accepts (Indonesia,
    # confirmed live) and raises a bare, uncaught Exception that would
    # otherwise take the whole multi-site call down with it.
    calls: list[list[str]] = []

    def fake_scrape_jobs(*, site_name, **kw):
        calls.append(site_name)
        if "glassdoor" in site_name:
            raise Exception("Glassdoor is not available for INDONESIA")
        return _fixture_df()

    monkeypatch.setattr("jobspy.scrape_jobs", fake_scrape_jobs)

    postings = await adapter.search(
        "engineer", {"location": "Indonesia"}, {"sites": "indeed,glassdoor", "country": "Indonesia"}
    )
    assert len(postings) == 2  # the fixture's two rows, recovered via the indeed-only retry
    assert calls == [["indeed", "glassdoor"], ["indeed"]]


async def test_glassdoor_unsupported_country_with_no_other_sites_still_raises(adapter, monkeypatch):
    def fake_scrape_jobs(*, site_name, **kw):
        raise Exception("Glassdoor is not available for INDONESIA")

    monkeypatch.setattr("jobspy.scrape_jobs", fake_scrape_jobs)

    with pytest.raises(Exception, match="Glassdoor is not available"):
        await adapter.search("engineer", {"location": "Indonesia"}, {"sites": "glassdoor", "country": "Indonesia"})


async def test_connection_failure_surfaces_cleanly(adapter, monkeypatch):
    def raise_error(**kw):
        raise RuntimeError("simulated scrape failure")

    monkeypatch.setattr("jobspy.scrape_jobs", raise_error)

    result = await adapter.test_connection({"country": "USA"})
    assert result.ok is False


@pytest.mark.live
async def test_live_indeed_search():
    """Opt-in — run explicitly with: pytest -m live. Genuinely hits
    Indeed (JobSpy's own docs call this the most reliable site, no
    proxy needed)."""
    adapter = JobSpyAdapter()
    result = await adapter.test_connection({"country": "USA"})
    assert result.ok is True

    postings = await adapter.search(
        "software engineer", {"location": "Remote"}, {"sites": "indeed", "country": "USA", "results_wanted": "3"}
    )
    assert len(postings) > 0
    assert all(p.title for p in postings)
