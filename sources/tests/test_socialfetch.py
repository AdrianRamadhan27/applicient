"""M1 §2 — SocialFetch adapter contract tests. The fixture is built
from SocialFetch's own published OpenAPI schema (fetched and read
directly, field-by-field, before writing this — see socialfetch.py's
module docstring), not a live capture (no API key was available) and
not a secondhand doc summary either — a materially higher-confidence
starting point than JSearch had, even without a live call. No
opt-in `live` test exists for this adapter for the same reason: there
is no key to run one with yet.
"""

import json
from pathlib import Path

import httpx
import pytest

from applicient_sources.socialfetch import SocialFetchAdapter

FIXTURE_PATH = Path(__file__).parent.parent / "src" / "applicient_sources" / "fixtures" / "socialfetch_jobs.json"


def _fixture_data() -> dict:
    return json.loads(FIXTURE_PATH.read_text())


def _mock_client(payload: dict, status_code: int = 200) -> httpx.AsyncClient:
    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(status_code, json=payload, request=request)

    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


@pytest.fixture
def adapter() -> SocialFetchAdapter:
    return SocialFetchAdapter()


async def test_search_parses_all_fixture_jobs(adapter, monkeypatch):
    client = _mock_client(_fixture_data())
    monkeypatch.setattr(httpx, "AsyncClient", lambda *a, **kw: client)

    postings = await adapter.search("engineer", {"location": "London"}, {"api_key": "sfk_test"})
    assert len(postings) == 2
    assert {p.title for p in postings} == {"Senior Backend Engineer", "Marketing Coordinator"}


async def test_missing_location_raises(adapter):
    with pytest.raises(ValueError, match="location"):
        await adapter.search("engineer", {}, {"api_key": "sfk_test"})


async def test_missing_api_key_raises(adapter):
    with pytest.raises(ValueError, match="api_key"):
        await adapter.search("engineer", {"location": "London"}, {})


async def test_structured_salary_preserved(adapter, monkeypatch):
    client = _mock_client(_fixture_data())
    monkeypatch.setattr(httpx, "AsyncClient", lambda *a, **kw: client)

    postings = await adapter.search("engineer", {"location": "London"}, {"api_key": "sfk_test"})
    job = next(p for p in postings if p.title == "Senior Backend Engineer")
    assert job.salary_min == 70000
    assert job.salary_max == 90000
    assert job.salary_currency == "GBP"


async def test_missing_salary_is_null_not_zero(adapter, monkeypatch):
    client = _mock_client(_fixture_data())
    monkeypatch.setattr(httpx, "AsyncClient", lambda *a, **kw: client)

    postings = await adapter.search("engineer", {"location": "London"}, {"api_key": "sfk_test"})
    job = next(p for p in postings if p.title == "Marketing Coordinator")
    assert job.salary_min is None
    assert job.salary_max is None


async def test_remote_policy_only_set_when_filter_forced_it(adapter, monkeypatch):
    # Two separate mock clients, both built with the REAL
    # httpx.AsyncClient before either monkeypatch call below — search()
    # opens/closes its own client via `async with`, so reusing one
    # instance across two calls fails on the second open, and building
    # a client *inside* a lambda assigned to httpx.AsyncClient itself
    # would recurse into the patched name instead of the real class.
    client_a, client_b = _mock_client(_fixture_data()), _mock_client(_fixture_data())

    monkeypatch.setattr(httpx, "AsyncClient", lambda *a, **kw: client_a)
    not_forced = await adapter.search("engineer", {"location": "London"}, {"api_key": "sfk_test"})
    assert all(p.remote_policy is None for p in not_forced)

    monkeypatch.setattr(httpx, "AsyncClient", lambda *a, **kw: client_b)
    forced = await adapter.search("engineer", {"location": "London", "remote": True}, {"api_key": "sfk_test"})
    assert all(p.remote_policy == "remote" for p in forced)


async def test_relative_posted_at_label_not_parsed_as_date(adapter, monkeypatch):
    client = _mock_client(_fixture_data())
    monkeypatch.setattr(httpx, "AsyncClient", lambda *a, **kw: client)

    postings = await adapter.search("engineer", {"location": "London"}, {"api_key": "sfk_test"})
    job = next(p for p in postings if p.title == "Marketing Coordinator")
    # this job has postedDate: null and postedAt: "1 week ago" in the fixture —
    # only the ISO postedDate may ever be used, never the relative label.
    assert job.posted_at is None


async def test_zero_balance_is_a_distinct_failure(adapter, monkeypatch):
    client = _mock_client({"data": {"balance": 0}, "meta": {}})
    monkeypatch.setattr(httpx, "AsyncClient", lambda *a, **kw: client)

    result = await adapter.test_connection({"api_key": "sfk_test"})
    assert result.ok is False
    assert "credit" in (result.error or "").lower()


async def test_positive_balance_is_ok(adapter, monkeypatch):
    client = _mock_client({"data": {"balance": 42}, "meta": {}})
    monkeypatch.setattr(httpx, "AsyncClient", lambda *a, **kw: client)

    result = await adapter.test_connection({"api_key": "sfk_test"})
    assert result.ok is True


async def test_connection_auth_failure_surfaces_cleanly(adapter, monkeypatch):
    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, json={"error": {"code": "unauthorized"}}, request=request)

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    monkeypatch.setattr(httpx, "AsyncClient", lambda *a, **kw: client)

    result = await adapter.test_connection({"api_key": "sfk_bad"})
    assert result.ok is False
    assert result.status == "auth_failed"
