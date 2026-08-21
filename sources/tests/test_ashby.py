"""M2 §4 — Ashby adapter contract tests. Offline tests run against a
real, trimmed, live-captured fixture (Ramp's board — see ashby.py's
module docstring for what was verified live) via httpx.MockTransport.
The `live` test is opt-in.
"""

import json
from pathlib import Path

import httpx
import pytest

from applicient_sources.ashby import AshbyAdapter

FIXTURE_PATH = Path(__file__).parent.parent / "src" / "applicient_sources" / "fixtures" / "ashby_jobs.json"


def _fixture_data() -> dict:
    return json.loads(FIXTURE_PATH.read_text())


def _mock_client(payload: dict, status_code: int = 200) -> httpx.AsyncClient:
    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(status_code, json=payload, request=request)

    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


@pytest.fixture
def adapter() -> AshbyAdapter:
    return AshbyAdapter()


async def test_search_parses_all_fixture_postings(adapter, monkeypatch):
    data = _fixture_data()
    client = _mock_client(data)
    monkeypatch.setattr(httpx, "AsyncClient", lambda *a, **kw: client)

    postings = await adapter.search("", {}, {"company_identifiers": ["ramp"]})
    assert len(postings) == len(data["jobs"])
    assert all(p.company_name == "ramp" for p in postings)


async def test_workplace_type_passed_through_as_remote_policy(adapter, monkeypatch):
    client = _mock_client(_fixture_data())
    monkeypatch.setattr(httpx, "AsyncClient", lambda *a, **kw: client)

    postings = await adapter.search("", {}, {"company_identifiers": ["ramp"]})
    fixture_types = {j["workplaceType"] for j in _fixture_data()["jobs"]}
    assert {p.remote_policy for p in postings} == fixture_types


async def test_requirements_uses_description_plain_not_html(adapter, monkeypatch):
    client = _mock_client(_fixture_data())
    monkeypatch.setattr(httpx, "AsyncClient", lambda *a, **kw: client)

    postings = await adapter.search("", {}, {"company_identifiers": ["ramp"]})
    text = postings[0].requirements
    assert text is not None
    assert "<" not in text  # descriptionPlain, never derived from descriptionHtml


async def test_missing_compensation_is_null_not_guessed(adapter, monkeypatch):
    client = _mock_client(_fixture_data())
    monkeypatch.setattr(httpx, "AsyncClient", lambda *a, **kw: client)

    postings = await adapter.search("", {}, {"company_identifiers": ["ramp"]})
    assert all(p.salary_min is None and p.salary_max is None for p in postings)


async def test_multi_identifier_fan_out(adapter, monkeypatch):
    data = _fixture_data()

    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=data, request=request)

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    monkeypatch.setattr(httpx, "AsyncClient", lambda *a, **kw: client)

    postings = await adapter.search("", {}, {"company_identifiers": ["ramp", "notion"]})
    assert len(postings) == len(data["jobs"]) * 2
    assert {p.company_name for p in postings} == {"ramp", "notion"}


async def test_missing_company_identifiers_raises(adapter):
    with pytest.raises(ValueError, match="company_identifiers"):
        await adapter.search("", {}, {})


async def test_connection_failure_surfaces_cleanly(adapter, monkeypatch):
    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(404, request=request)

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    monkeypatch.setattr(httpx, "AsyncClient", lambda *a, **kw: client)

    result = await adapter.test_connection({"company_identifiers": ["nonexistent-board-xyz"]})
    assert result.ok is False


@pytest.mark.live
async def test_live_ramp_board():
    """Opt-in — run explicitly with: pytest -m live"""
    adapter = AshbyAdapter()
    result = await adapter.test_connection({"company_identifiers": ["ramp"]})
    assert result.ok is True

    postings = await adapter.search("engineer", {}, {"company_identifiers": ["ramp"]})
    assert len(postings) > 0
    assert all(p.title for p in postings)
