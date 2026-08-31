"""M4 §9 — generic_scraper adapter contract tests. Unlike every other
adapter (a documented JSON API mocked via httpx.MockTransport, same
precedent as test_greenhouse.py), this one also drives an LLM call —
mocked here with a tiny fake `model` exposing just the
`with_structured_output(...).invoke(...)` shape `search()` actually
calls, never a real network/API call, same "no network needed for the
normal test run" discipline as every other adapter's offline tests.
"""

import httpx
import pytest

from applicient_sources.generic_scraper import GenericScraperAdapter, _ScrapedPosting, _ScrapedPostingList


class _FakeStructured:
    def __init__(self, result):
        self._result = result

    def invoke(self, messages):
        return self._result


class _FakeModel:
    def __init__(self, result):
        self._result = result
        self.calls = 0

    def with_structured_output(self, schema):
        self.calls += 1
        return _FakeStructured(self._result)


def _fake_two_postings() -> _ScrapedPostingList:
    return _ScrapedPostingList(
        postings=[
            _ScrapedPosting(title="AI Engineer", apply_url="https://career.example.com/jobs/1", location="Jakarta"),
            _ScrapedPosting(title="Data Analyst", apply_url="https://career.example.com/jobs/2", location="Bandung"),
        ]
    )


def _mock_browser_worker(*, session_calls: list[str] | None = None, open_status: int = 200) -> httpx.AsyncClient:
    async def handler(request: httpx.Request) -> httpx.Response:
        if session_calls is not None:
            session_calls.append(request.method)
        if request.method == "POST" and request.url.path == "/sessions":
            if open_status != 200:
                return httpx.Response(open_status, json={"detail": "boom"}, request=request)
            return httpx.Response(
                200, json={"session_id": "sess-1", "snapshot": "a fake accessibility tree"}, request=request
            )
        if request.method == "DELETE":
            return httpx.Response(200, json={"storage_state": {}}, request=request)
        return httpx.Response(404, request=request)

    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


@pytest.fixture
def adapter() -> GenericScraperAdapter:
    return GenericScraperAdapter()


async def test_search_extracts_postings_via_llm(adapter, monkeypatch):
    client = _mock_browser_worker()
    monkeypatch.setattr(httpx, "AsyncClient", lambda *a, **kw: client)
    model = _FakeModel(_fake_two_postings())
    config = {"career_sites": [{"url": "https://career.example.com/jobs", "company_name": "Example Corp"}]}

    postings = await adapter.search("", {}, config, model=model)

    assert len(postings) == 2
    assert {p.title for p in postings} == {"AI Engineer", "Data Analyst"}
    assert all(p.company_name == "Example Corp" for p in postings)
    assert all(p.source_url == "https://career.example.com/jobs" for p in postings)


async def test_search_filters_by_query(adapter, monkeypatch):
    client = _mock_browser_worker()
    monkeypatch.setattr(httpx, "AsyncClient", lambda *a, **kw: client)
    model = _FakeModel(_fake_two_postings())
    config = {"career_sites": [{"url": "https://career.example.com/jobs", "company_name": "Example Corp"}]}

    postings = await adapter.search("Data Analyst", {}, config, model=model)

    assert len(postings) == 1
    assert postings[0].title == "Data Analyst"


async def test_search_filters_by_location(adapter, monkeypatch):
    client = _mock_browser_worker()
    monkeypatch.setattr(httpx, "AsyncClient", lambda *a, **kw: client)
    model = _FakeModel(_fake_two_postings())
    config = {"career_sites": [{"url": "https://career.example.com/jobs", "company_name": "Example Corp"}]}

    postings = await adapter.search("", {"location": "Jakarta"}, config, model=model)

    assert len(postings) == 1
    assert postings[0].title == "AI Engineer"


async def test_search_with_no_sites_returns_empty(adapter, monkeypatch):
    postings = await adapter.search("", {}, {}, model=_FakeModel(_fake_two_postings()))
    assert postings == []


async def test_search_with_no_model_returns_empty(adapter, monkeypatch):
    client = _mock_browser_worker()
    monkeypatch.setattr(httpx, "AsyncClient", lambda *a, **kw: client)
    config = {"career_sites": [{"url": "https://career.example.com/jobs", "company_name": "Example Corp"}]}

    postings = await adapter.search("", {}, config, model=None)

    assert postings == []


async def test_search_reports_nothing_when_page_unopenable(adapter, monkeypatch):
    """A dead/unreachable career-page link must not silently look like
    a company with zero open roles — it should just yield no postings
    without ever reaching the (mocked) LLM call, verified via call count."""

    client = _mock_browser_worker(open_status=422)
    monkeypatch.setattr(httpx, "AsyncClient", lambda *a, **kw: client)
    model = _FakeModel(_fake_two_postings())
    config = {"career_sites": [{"url": "https://career.example.com/jobs", "company_name": "Example Corp"}]}

    postings = await adapter.search("", {}, config, model=model)

    assert postings == []
    assert model.calls == 0


async def test_search_reports_nothing_when_page_is_not_a_listing(adapter, monkeypatch):
    client = _mock_browser_worker()
    monkeypatch.setattr(httpx, "AsyncClient", lambda *a, **kw: client)
    model = _FakeModel(_ScrapedPostingList(postings=[]))
    config = {"career_sites": [{"url": "https://career.example.com/jobs", "company_name": "Example Corp"}]}

    postings = await adapter.search("", {}, config, model=model)

    assert postings == []


async def test_search_caches_within_ttl_across_calls(adapter, monkeypatch):
    """The same career page shouldn't be re-scraped (a real browser
    session + a real LLM call, unlike every other adapter's cheap HTTP
    GET) for every role title in one saved search — verified here via
    the mock transport's own call count across two `search()` calls."""

    session_calls: list[str] = []
    client = _mock_browser_worker(session_calls=session_calls)
    monkeypatch.setattr(httpx, "AsyncClient", lambda *a, **kw: client)
    model = _FakeModel(_fake_two_postings())
    config = {"career_sites": [{"url": "https://career.example.com/jobs", "company_name": "Example Corp"}]}

    await adapter.search("", {}, config, model=model)
    await adapter.search("", {}, config, model=model)

    assert session_calls.count("POST") == 1
    assert model.calls == 1


async def test_test_connection_ok_when_page_opens(adapter, monkeypatch):
    client = _mock_browser_worker()
    monkeypatch.setattr(httpx, "AsyncClient", lambda *a, **kw: client)
    config = {"career_sites": [{"url": "https://career.example.com/jobs", "company_name": "Example Corp"}]}

    result = await adapter.test_connection(config)

    assert result.ok
    assert result.status == "ok"


async def test_test_connection_fails_with_no_sites(adapter):
    result = await adapter.test_connection({})
    assert not result.ok
    assert result.status == "unreachable"


async def test_fetch_detail_raises_not_implemented(adapter):
    with pytest.raises(NotImplementedError):
        await adapter.fetch_detail("https://career.example.com/jobs/1", {})
