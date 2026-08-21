"""M2 §4 — SmartRecruiters adapter contract tests. Offline tests run
against real, trimmed, live-captured fixtures (Equinox's board — see
smartrecruiters.py's module docstring for what was verified live: real
pagination on a 718-posting board, and the genuine list/detail split)
via httpx.MockTransport. The `live` test is opt-in.
"""

import json
from pathlib import Path

import httpx
import pytest

from applicient_sources.smartrecruiters import SmartRecruitersAdapter

FIXTURES = Path(__file__).parent.parent / "src" / "applicient_sources" / "fixtures"
LIST_FIXTURE = FIXTURES / "smartrecruiters_postings_list.json"
DETAIL_FIXTURE = FIXTURES / "smartrecruiters_posting_detail.json"


def _list_data() -> dict:
    return json.loads(LIST_FIXTURE.read_text())


def _detail_data() -> dict:
    return json.loads(DETAIL_FIXTURE.read_text())


def _mock_client() -> httpx.AsyncClient:
    """Branches on the URL path: `/postings` (no trailing id) is the
    paginated list; `/postings/{id}` is the per-posting detail call —
    this is the real two-call shape confirmed live, not one endpoint."""

    async def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path.rstrip("/").endswith("/postings"):
            return httpx.Response(200, json=_list_data(), request=request)
        return httpx.Response(200, json=_detail_data(), request=request)

    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


@pytest.fixture
def adapter() -> SmartRecruitersAdapter:
    return SmartRecruitersAdapter()


async def test_search_parses_all_fixture_postings(adapter, monkeypatch):
    client = _mock_client()
    monkeypatch.setattr(httpx, "AsyncClient", lambda *a, **kw: client)

    postings = await adapter.search("", {}, {"company_identifiers": ["Equinox"]})
    assert len(postings) == len(_list_data()["content"])


async def test_requirements_and_responsibilities_come_from_detail_sections(adapter, monkeypatch):
    client = _mock_client()
    monkeypatch.setattr(httpx, "AsyncClient", lambda *a, **kw: client)

    postings = await adapter.search("", {}, {"company_identifiers": ["Equinox"]})
    detail = _detail_data()
    expected_requirements = detail["jobAd"]["sections"]["qualifications"]["text"]
    expected_responsibilities = detail["jobAd"]["sections"]["jobDescription"]["text"]
    if expected_requirements:
        assert postings[0].requirements
        assert "<" not in postings[0].requirements
    if expected_responsibilities:
        assert postings[0].responsibilities
        assert "<" not in postings[0].responsibilities


async def test_apply_url_comes_from_detail_not_list(adapter, monkeypatch):
    client = _mock_client()
    monkeypatch.setattr(httpx, "AsyncClient", lambda *a, **kw: client)

    postings = await adapter.search("", {}, {"company_identifiers": ["Equinox"]})
    assert postings[0].apply_url == _detail_data()["applyUrl"]


async def test_pagination_follows_offset_until_exhausted(adapter, monkeypatch):
    """Confirmed live against a real 718-posting board — this offline
    test simulates the same shape (a full first page, then a short
    remainder page, matching the real `offset=700` behavior observed
    against Equinox's actual 718-posting board), with the page size
    patched down so the test isn't paying for real rate-limited detail
    calls on 100 fake postings."""

    import applicient_sources.smartrecruiters as smartrecruiters_module

    monkeypatch.setattr(smartrecruiters_module, "_PAGE_SIZE", 3)

    one = _list_data()["content"][0]
    # A full page (page size 3) then a 1-item remainder — a page
    # shorter than the page size, not the page count, is what the real
    # adapter uses to know it has reached the last page.
    page1 = {"offset": 0, "limit": 3, "totalFound": 4, "content": [one] * 3}
    page2 = {"offset": 3, "limit": 3, "totalFound": 4, "content": [one]}
    calls = {"n": 0}

    async def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path.rstrip("/").endswith("/postings"):
            calls["n"] += 1
            return httpx.Response(200, json=page1 if calls["n"] == 1 else page2, request=request)
        return httpx.Response(200, json=_detail_data(), request=request)

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    monkeypatch.setattr(httpx, "AsyncClient", lambda *a, **kw: client)

    postings = await adapter.search("", {}, {"company_identifiers": ["Equinox"]})
    assert calls["n"] == 2  # both pages fetched
    assert len(postings) == 4  # every posting across both pages, each detail-fetched


async def test_detail_only_fetched_for_query_filtered_postings(adapter, monkeypatch):
    """The N+1 cost is only paid for postings that survive the
    title/location filter, not every posting on the board."""

    list_data = _list_data()
    detail_calls = {"n": 0}

    async def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path.rstrip("/").endswith("/postings"):
            return httpx.Response(200, json=list_data, request=request)
        detail_calls["n"] += 1
        return httpx.Response(200, json=_detail_data(), request=request)

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    monkeypatch.setattr(httpx, "AsyncClient", lambda *a, **kw: client)

    await adapter.search("no-real-postings-match-this-xyz", {}, {"company_identifiers": ["Equinox"]})
    assert detail_calls["n"] == 0


async def test_missing_salary_is_null_not_zero(adapter, monkeypatch):
    client = _mock_client()
    monkeypatch.setattr(httpx, "AsyncClient", lambda *a, **kw: client)

    postings = await adapter.search("", {}, {"company_identifiers": ["Equinox"]})
    assert all(p.salary_min is None and p.salary_max is None for p in postings)


async def test_missing_company_identifiers_raises(adapter):
    with pytest.raises(ValueError, match="company_identifiers"):
        await adapter.search("", {}, {})


async def test_connection_failure_surfaces_cleanly(adapter, monkeypatch):
    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(404, request=request)

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    monkeypatch.setattr(httpx, "AsyncClient", lambda *a, **kw: client)

    result = await adapter.test_connection({"company_identifiers": ["nonexistent-company-xyz"]})
    assert result.ok is False


@pytest.mark.live
async def test_live_equinox_board():
    """Opt-in — run explicitly with: pytest -m live"""
    adapter = SmartRecruitersAdapter()
    result = await adapter.test_connection({"company_identifiers": ["Equinox"]})
    assert result.ok is True

    postings = await adapter.search("spa", {}, {"company_identifiers": ["Equinox"]})
    assert len(postings) > 0
    assert all(p.title for p in postings)
