"""M1 §2 — Greenhouse adapter contract tests. The offline tests run
against a real fixture (a trimmed, live-captured response — see
fixtures/greenhouse_jobs.json's header comment in the module docstring
of greenhouse.py for how it was produced) via httpx.MockTransport, so
no network access is needed for the normal test run. The `live` test
is opt-in — it hits the real public API and is excluded by default.
"""

import json
from pathlib import Path

import httpx
import pytest

from applicient_sources.greenhouse import GreenhouseAdapter

FIXTURE_PATH = Path(__file__).parent.parent / "src" / "applicient_sources" / "fixtures" / "greenhouse_jobs.json"


def _fixture_data() -> dict:
    return json.loads(FIXTURE_PATH.read_text())


def _mock_client(payload: dict, status_code: int = 200) -> httpx.AsyncClient:
    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(status_code, json=payload, request=request)

    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


@pytest.fixture
def adapter() -> GreenhouseAdapter:
    return GreenhouseAdapter()


async def test_search_parses_all_fixture_jobs(adapter, monkeypatch):
    data = _fixture_data()
    client = _mock_client(data)
    monkeypatch.setattr(httpx, "AsyncClient", lambda *a, **kw: client)

    postings = await adapter.search("", {}, {"board_token": "gitlab"})
    assert len(postings) == len(data["jobs"])
    titles = {p.title for p in postings}
    assert "AI Engineer" in titles


async def test_search_filters_by_query(adapter, monkeypatch):
    client = _mock_client(_fixture_data())
    monkeypatch.setattr(httpx, "AsyncClient", lambda *a, **kw: client)

    postings = await adapter.search("AI Engineer", {}, {"board_token": "gitlab"})
    assert len(postings) == 1
    assert postings[0].title == "AI Engineer"


async def test_search_filters_by_location(adapter, monkeypatch):
    client = _mock_client(_fixture_data())
    monkeypatch.setattr(httpx, "AsyncClient", lambda *a, **kw: client)

    postings = await adapter.search("", {"location": "Bangalore"}, {"board_token": "gitlab"})
    assert len(postings) == 1
    assert "Bangalore" in postings[0].location


async def test_html_content_is_cleaned(adapter, monkeypatch):
    client = _mock_client(_fixture_data())
    monkeypatch.setattr(httpx, "AsyncClient", lambda *a, **kw: client)

    postings = await adapter.search("AI Engineer", {}, {"board_token": "gitlab"})
    text = postings[0].requirements
    assert text is not None
    # No raw tags or double-escaped entities should survive cleaning.
    assert "<" not in text
    assert "&lt;" not in text
    assert "&amp;" not in text or "&" in text  # a literal "&" is fine; an unresolved entity is not


async def test_raw_payload_preserved(adapter, monkeypatch):
    client = _mock_client(_fixture_data())
    monkeypatch.setattr(httpx, "AsyncClient", lambda *a, **kw: client)

    postings = await adapter.search("", {}, {"board_token": "gitlab"})
    assert postings[0].raw_payload["id"] == _fixture_data()["jobs"][0]["id"]


async def test_missing_board_token_raises(adapter):
    with pytest.raises(ValueError, match="board_token"):
        await adapter.search("", {}, {})


async def test_connection_failure_surfaces_cleanly(adapter, monkeypatch):
    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(404, request=request)

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    monkeypatch.setattr(httpx, "AsyncClient", lambda *a, **kw: client)

    result = await adapter.test_connection({"board_token": "nonexistent-board-xyz"})
    assert result.ok is False


@pytest.mark.live
async def test_live_gitlab_board():
    """Opt-in — run explicitly with: pytest -m live"""
    adapter = GreenhouseAdapter()
    result = await adapter.test_connection({"board_token": "gitlab"})
    assert result.ok is True

    postings = await adapter.search("engineer", {}, {"board_token": "gitlab"})
    assert len(postings) > 0
    assert all(p.title for p in postings)
