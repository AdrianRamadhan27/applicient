"""M1 §2 — RemoteOK adapter contract tests. Offline tests run against
a real, trimmed, live-captured fixture (see remoteok.py's module
docstring for what was verified live) via httpx.MockTransport. The
`live` test is opt-in.
"""

import json
from pathlib import Path

import httpx
import pytest

from applicient_sources.remoteok import RemoteOKAdapter

FIXTURE_PATH = Path(__file__).parent.parent / "src" / "applicient_sources" / "fixtures" / "remoteok_jobs.json"


def _fixture_data() -> list:
    return json.loads(FIXTURE_PATH.read_text())


def _mock_client(payload: list, status_code: int = 200) -> httpx.AsyncClient:
    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(status_code, json=payload, request=request)

    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


@pytest.fixture
def adapter() -> RemoteOKAdapter:
    return RemoteOKAdapter()


async def test_search_skips_legal_notice_entry(adapter, monkeypatch):
    data = _fixture_data()
    client = _mock_client(data)
    monkeypatch.setattr(httpx, "AsyncClient", lambda *a, **kw: client)

    postings = await adapter.search("", {}, {})
    # fixture has 1 legal notice + 3 real jobs
    assert len(postings) == 3
    assert all(p.title for p in postings)


async def test_search_filters_by_query(adapter, monkeypatch):
    client = _mock_client(_fixture_data())
    monkeypatch.setattr(httpx, "AsyncClient", lambda *a, **kw: client)

    postings = await adapter.search("engineer", {}, {})
    assert len(postings) == 1
    assert "Engineer" in postings[0].title


async def test_zero_salary_is_treated_as_unstated(adapter, monkeypatch):
    client = _mock_client(_fixture_data())
    monkeypatch.setattr(httpx, "AsyncClient", lambda *a, **kw: client)

    postings = await adapter.search("engineer", {}, {})
    assert postings[0].salary_min is None
    assert postings[0].salary_max is None


async def test_real_salary_is_preserved(adapter, monkeypatch):
    client = _mock_client(_fixture_data())
    monkeypatch.setattr(httpx, "AsyncClient", lambda *a, **kw: client)

    postings = await adapter.search("Solutions Delivery", {}, {})
    assert len(postings) == 1
    assert postings[0].salary_min == 150000
    assert postings[0].salary_max == 200000


async def test_html_entities_unescaped_in_title(adapter, monkeypatch):
    client = _mock_client(_fixture_data())
    monkeypatch.setattr(httpx, "AsyncClient", lambda *a, **kw: client)

    postings = await adapter.search("Planner", {}, {})
    assert len(postings) == 1
    assert "&amp;" not in postings[0].title
    assert "&" in postings[0].title


async def test_every_posting_is_remote(adapter, monkeypatch):
    client = _mock_client(_fixture_data())
    monkeypatch.setattr(httpx, "AsyncClient", lambda *a, **kw: client)

    postings = await adapter.search("", {}, {})
    assert all(p.remote_policy == "remote" for p in postings)


async def test_connection_failure_surfaces_cleanly(adapter, monkeypatch):
    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, request=request)

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    monkeypatch.setattr(httpx, "AsyncClient", lambda *a, **kw: client)

    result = await adapter.test_connection({})
    assert result.ok is False


@pytest.mark.live
async def test_live_search():
    """Opt-in — run explicitly with: pytest -m live"""
    adapter = RemoteOKAdapter()
    result = await adapter.test_connection({})
    assert result.ok is True

    postings = await adapter.search("engineer", {}, {})
    assert len(postings) > 0
    assert all(p.title and p.remote_policy == "remote" for p in postings)
