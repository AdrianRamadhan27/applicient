"""M2 §4 — Recruitee adapter contract tests. Offline tests run against
a real, trimmed, live-captured fixture (Channable's board — see
recruitee.py's module docstring for what was verified live) via
httpx.MockTransport. The `live` test is opt-in.
"""

import json
from pathlib import Path

import httpx
import pytest

from applicient_sources.recruitee import RecruiteeAdapter

FIXTURE_PATH = Path(__file__).parent.parent / "src" / "applicient_sources" / "fixtures" / "recruitee_offers.json"


def _fixture_data() -> dict:
    return json.loads(FIXTURE_PATH.read_text())


def _mock_client(payload: dict, status_code: int = 200) -> httpx.AsyncClient:
    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(status_code, json=payload, request=request)

    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


@pytest.fixture
def adapter() -> RecruiteeAdapter:
    return RecruiteeAdapter()


async def test_search_parses_all_fixture_postings(adapter, monkeypatch):
    data = _fixture_data()
    client = _mock_client(data)
    monkeypatch.setattr(httpx, "AsyncClient", lambda *a, **kw: client)

    postings = await adapter.search("", {}, {"company_identifiers": ["channable"]})
    assert len(postings) == len(data["offers"])


async def test_annual_salary_is_kept(adapter, monkeypatch):
    client = _mock_client(_fixture_data())
    monkeypatch.setattr(httpx, "AsyncClient", lambda *a, **kw: client)

    postings = await adapter.search("", {}, {"company_identifiers": ["channable"]})
    annual_offers = [o for o in _fixture_data()["offers"] if (o.get("salary") or {}).get("period") in ("year", "annual")]
    with_salary = [p for p in postings if p.salary_min is not None]
    assert len(with_salary) == len(annual_offers)


async def test_non_annual_salary_period_is_not_misrepresented(adapter, monkeypatch):
    """F3.1a — a monthly figure must never silently read as if it were
    annual; this is the entire reason the period guard exists."""

    fixture = _fixture_data()
    # Force a non-annual period on the first offer regardless of what
    # the live capture happened to have, so this test doesn't depend
    # on which period the real fixture data currently contains.
    fixture["offers"][0]["salary"] = {"min": "4500", "max": "6000", "period": "month", "currency": "EUR"}
    client = _mock_client(fixture)
    monkeypatch.setattr(httpx, "AsyncClient", lambda *a, **kw: client)

    postings = await adapter.search("", {}, {"company_identifiers": ["channable"]})
    assert postings[0].salary_min is None
    assert postings[0].salary_max is None


async def test_remote_takes_priority_over_hybrid(adapter, monkeypatch):
    fixture = _fixture_data()
    fixture["offers"][0]["remote"] = True
    fixture["offers"][0]["hybrid"] = True
    client = _mock_client(fixture)
    monkeypatch.setattr(httpx, "AsyncClient", lambda *a, **kw: client)

    postings = await adapter.search("", {}, {"company_identifiers": ["channable"]})
    assert postings[0].remote_policy == "remote"


async def test_all_false_remote_flags_leave_remote_policy_null(adapter, monkeypatch):
    fixture = _fixture_data()
    fixture["offers"][0]["remote"] = False
    fixture["offers"][0]["hybrid"] = False
    fixture["offers"][0]["on_site"] = True
    client = _mock_client(fixture)
    monkeypatch.setattr(httpx, "AsyncClient", lambda *a, **kw: client)

    postings = await adapter.search("", {}, {"company_identifiers": ["channable"]})
    assert postings[0].remote_policy is None


async def test_requirements_and_responsibilities_stripped_of_html(adapter, monkeypatch):
    client = _mock_client(_fixture_data())
    monkeypatch.setattr(httpx, "AsyncClient", lambda *a, **kw: client)

    postings = await adapter.search("", {}, {"company_identifiers": ["channable"]})
    for p in postings:
        if p.requirements:
            assert "<" not in p.requirements
        if p.responsibilities:
            assert "<" not in p.responsibilities


async def test_multi_identifier_fan_out(adapter, monkeypatch):
    data = _fixture_data()

    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=data, request=request)

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    monkeypatch.setattr(httpx, "AsyncClient", lambda *a, **kw: client)

    postings = await adapter.search("", {}, {"company_identifiers": ["channable", "some-other-co"]})
    assert len(postings) == len(data["offers"]) * 2


async def test_missing_company_identifiers_raises(adapter):
    with pytest.raises(ValueError, match="company_identifiers"):
        await adapter.search("", {}, {})


async def test_connection_failure_surfaces_cleanly(adapter, monkeypatch):
    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(404, request=request)

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    monkeypatch.setattr(httpx, "AsyncClient", lambda *a, **kw: client)

    result = await adapter.test_connection({"company_identifiers": ["nonexistent-subdomain-xyz"]})
    assert result.ok is False


@pytest.mark.live
async def test_live_channable_board():
    """Opt-in — run explicitly with: pytest -m live"""
    adapter = RecruiteeAdapter()
    result = await adapter.test_connection({"company_identifiers": ["channable"]})
    assert result.ok is True

    postings = await adapter.search("", {}, {"company_identifiers": ["channable"]})
    assert len(postings) > 0
    assert all(p.title for p in postings)
