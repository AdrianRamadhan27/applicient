"""M1 §2 — JSearch adapter contract tests.

Unlike test_greenhouse.py, the fixture here is CONSTRUCTED from
documented field names, not a captured live response — see the
"Confidence gap" note in jsearch.py's module docstring and
fixtures/jsearch_response.json's _fixture_note. These tests prove the
adapter's parsing logic is internally consistent with what the docs
say the shape is; they do not prove the docs are right. test_live_search
is the real verification gate and requires JSEARCH_API_KEY to run.
"""

import json
import os
from pathlib import Path

import httpx
import pytest

from applicient_sources.jsearch import JSearchAdapter

FIXTURE_PATH = Path(__file__).parent.parent / "src" / "applicient_sources" / "fixtures" / "jsearch_response.json"


def _fixture_data() -> dict:
    return json.loads(FIXTURE_PATH.read_text())


def _mock_client(payload: dict, status_code: int = 200) -> httpx.AsyncClient:
    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(status_code, json=payload, request=request)

    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


@pytest.fixture
def adapter() -> JSearchAdapter:
    return JSearchAdapter()


async def test_search_parses_all_fixture_jobs(adapter, monkeypatch):
    client = _mock_client(_fixture_data())
    monkeypatch.setattr(httpx, "AsyncClient", lambda *a, **kw: client)

    postings = await adapter.search("AI Engineer", {}, {"api_key": "fixture-key"})
    assert len(postings) == 2
    assert postings[0].title == "AI Engineer"
    assert postings[0].company_name == "Contoh Teknologi"


async def test_highlights_split_into_requirements_responsibilities_benefits(adapter, monkeypatch):
    client = _mock_client(_fixture_data())
    monkeypatch.setattr(httpx, "AsyncClient", lambda *a, **kw: client)

    postings = await adapter.search("", {}, {"api_key": "fixture-key"})
    p = postings[0]
    assert "2+ years Python" in p.requirements
    assert "Build RAG pipelines" in p.responsibilities
    assert "Health insurance" in p.benefits


async def test_falls_back_to_description_when_no_highlights(adapter, monkeypatch):
    client = _mock_client(_fixture_data())
    monkeypatch.setattr(httpx, "AsyncClient", lambda *a, **kw: client)

    postings = await adapter.search("", {}, {"api_key": "fixture-key"})
    p = postings[1]
    assert p.requirements == "No structured highlights on this one — fallback to job_description."
    assert p.responsibilities is None


async def test_salary_null_when_not_stated(adapter, monkeypatch):
    """F3.1a — never estimated, stays null when the source doesn't say."""
    client = _mock_client(_fixture_data())
    monkeypatch.setattr(httpx, "AsyncClient", lambda *a, **kw: client)

    postings = await adapter.search("", {}, {"api_key": "fixture-key"})
    assert postings[1].salary_min is None
    assert postings[1].salary_max is None


async def test_remote_flag_maps_to_remote_policy(adapter, monkeypatch):
    client = _mock_client(_fixture_data())
    monkeypatch.setattr(httpx, "AsyncClient", lambda *a, **kw: client)

    postings = await adapter.search("", {}, {"api_key": "fixture-key"})
    assert postings[0].remote_policy is None  # job_is_remote: false
    assert postings[1].remote_policy == "remote"  # job_is_remote: true


async def test_missing_api_key_raises(adapter):
    with pytest.raises(ValueError, match="api_key"):
        await adapter.search("", {}, {})


async def test_auth_failure_reported_as_auth_failed(adapter, monkeypatch):
    client = _mock_client({}, status_code=401)
    monkeypatch.setattr(httpx, "AsyncClient", lambda *a, **kw: client)

    result = await adapter.test_connection({"api_key": "invalid-key"})
    assert result.status == "auth_failed"
    assert result.ok is False


async def test_fetch_detail_raises_not_implemented(adapter):
    with pytest.raises(NotImplementedError):
        await adapter.fetch_detail("https://example.com/job/1", {"api_key": "x"})


@pytest.mark.live
@pytest.mark.skipif(not os.environ.get("JSEARCH_API_KEY"), reason="set JSEARCH_API_KEY to run this")
async def test_live_search():
    """The real verification gate for this adapter — everything else
    in this file only checks internal consistency with unverified
    docs. Run with: JSEARCH_API_KEY=... pytest -m live"""
    adapter = JSearchAdapter()
    config = {"api_key": os.environ["JSEARCH_API_KEY"]}

    result = await adapter.test_connection(config)
    assert result.ok is True, f"connection test failed: {result.error}"

    postings = await adapter.search("AI Engineer", {"location": "Jakarta"}, config)
    assert len(postings) > 0
    p = postings[0]
    assert p.title
    assert p.company_name
    # If this assertion ever fires, the field-name confidence gap in
    # jsearch.py's docstring is real and the adapter needs fixing
    # against the actual live shape, not the documented one.
    assert p.source_url, "source_url ended up empty — job_apply_link/job_google_link field names may be wrong"
