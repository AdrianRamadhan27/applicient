"""M1 §2 — Lever adapter contract tests. Offline tests run against a
real, trimmed, live-captured fixture (Palantir's board — see lever.py's
module docstring for what was verified live vs. corroborated from
Lever's own docs) via httpx.MockTransport. The `live` test is opt-in.
"""

import json
from pathlib import Path

import httpx
import pytest

from applicient_sources.lever import LeverAdapter

FIXTURE_PATH = Path(__file__).parent.parent / "src" / "applicient_sources" / "fixtures" / "lever_postings.json"


def _fixture_data() -> list:
    return json.loads(FIXTURE_PATH.read_text())


def _mock_client(payload: list, status_code: int = 200) -> httpx.AsyncClient:
    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(status_code, json=payload, request=request)

    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


@pytest.fixture
def adapter() -> LeverAdapter:
    return LeverAdapter()


async def test_search_parses_all_fixture_postings(adapter, monkeypatch):
    data = _fixture_data()
    client = _mock_client(data)
    monkeypatch.setattr(httpx, "AsyncClient", lambda *a, **kw: client)

    postings = await adapter.search("", {}, {"board_token": "palantir"})
    assert len(postings) == len(data)
    assert all(p.company_name == "palantir" for p in postings)


async def test_workplace_type_maps_to_remote_policy(adapter, monkeypatch):
    client = _mock_client(_fixture_data())
    monkeypatch.setattr(httpx, "AsyncClient", lambda *a, **kw: client)

    postings = await adapter.search("", {}, {"board_token": "palantir"})
    by_title = {p.title: p.remote_policy for p in postings}
    assert by_title["American Tech Fellowship"] == "remote"
    assert by_title["Administrative Business Partner"] == "hybrid"
    assert by_title["Backend Software Engineer - Defense"] == "onsite"


async def test_search_filters_by_query(adapter, monkeypatch):
    client = _mock_client(_fixture_data())
    monkeypatch.setattr(httpx, "AsyncClient", lambda *a, **kw: client)

    postings = await adapter.search("engineer", {}, {"board_token": "palantir"})
    assert len(postings) == 1
    assert "Engineer" in postings[0].title


async def test_search_filters_by_location(adapter, monkeypatch):
    client = _mock_client(_fixture_data())
    monkeypatch.setattr(httpx, "AsyncClient", lambda *a, **kw: client)

    postings = await adapter.search("", {"location": "London"}, {"board_token": "palantir"})
    assert len(postings) == 1
    assert "London" in postings[0].location


async def test_requirements_combines_description_and_lists(adapter, monkeypatch):
    client = _mock_client(_fixture_data())
    monkeypatch.setattr(httpx, "AsyncClient", lambda *a, **kw: client)

    postings = await adapter.search("", {}, {"board_token": "palantir"})
    text = postings[0].requirements
    assert text is not None
    assert "<" not in text
    assert "&lt;" not in text


async def test_missing_salary_range_is_null_not_zero(adapter, monkeypatch):
    client = _mock_client(_fixture_data())
    monkeypatch.setattr(httpx, "AsyncClient", lambda *a, **kw: client)

    postings = await adapter.search("", {}, {"board_token": "palantir"})
    assert all(p.salary_min is None and p.salary_max is None for p in postings)


async def test_missing_company_identifiers_raises(adapter):
    with pytest.raises(ValueError, match="company_identifiers"):
        await adapter.search("", {}, {})


async def test_legacy_board_token_still_works(adapter, monkeypatch):
    """M2 §6 — every M1-era Source row used `board_token`, singular;
    it must keep working unchanged, not require a data migration."""

    client = _mock_client(_fixture_data())
    monkeypatch.setattr(httpx, "AsyncClient", lambda *a, **kw: client)

    postings = await adapter.search("", {}, {"board_token": "palantir"})
    assert len(postings) == len(_fixture_data())


async def test_multi_identifier_fan_out(adapter, monkeypatch):
    """The whole point of M2 §6 — one Source scans every company in
    the list, not one Source per company."""

    data = _fixture_data()

    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=data, request=request)

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    monkeypatch.setattr(httpx, "AsyncClient", lambda *a, **kw: client)

    postings = await adapter.search("", {}, {"company_identifiers": ["palantir", "some-other-board"]})
    assert len(postings) == len(data) * 2


async def test_one_bad_identifier_does_not_stop_the_others(adapter, monkeypatch):
    data = _fixture_data()

    async def handler(request: httpx.Request) -> httpx.Response:
        if "dead-board" in str(request.url):
            return httpx.Response(404, request=request)
        return httpx.Response(200, json=data, request=request)

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    monkeypatch.setattr(httpx, "AsyncClient", lambda *a, **kw: client)

    postings = await adapter.search("", {}, {"company_identifiers": ["dead-board", "palantir"]})
    assert len(postings) == len(data)


async def test_connection_failure_surfaces_cleanly(adapter, monkeypatch):
    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(404, request=request)

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    monkeypatch.setattr(httpx, "AsyncClient", lambda *a, **kw: client)

    result = await adapter.test_connection({"board_token": "nonexistent-board-xyz"})
    assert result.ok is False


@pytest.mark.live
async def test_live_palantir_board():
    """Opt-in — run explicitly with: pytest -m live"""
    adapter = LeverAdapter()
    result = await adapter.test_connection({"board_token": "palantir"})
    assert result.ok is True

    postings = await adapter.search("engineer", {}, {"board_token": "palantir"})
    assert len(postings) > 0
    assert all(p.title for p in postings)
