"""M2 §4 — Workable adapter contract tests. Offline tests run against
a real, trimmed, live-captured fixture (Hugging Face's board — see
workable.py's module docstring for what was verified live) via
httpx.MockTransport. The `live` test is opt-in.
"""

import json
from pathlib import Path

import httpx
import pytest

from applicient_sources.workable import WorkableAdapter

FIXTURE_PATH = Path(__file__).parent.parent / "src" / "applicient_sources" / "fixtures" / "workable_jobs.json"


def _fixture_data() -> dict:
    return json.loads(FIXTURE_PATH.read_text())


def _mock_client(payload: dict, status_code: int = 200) -> httpx.AsyncClient:
    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(status_code, json=payload, request=request)

    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


@pytest.fixture
def adapter() -> WorkableAdapter:
    return WorkableAdapter()


async def test_search_parses_all_fixture_postings(adapter, monkeypatch):
    data = _fixture_data()
    client = _mock_client(data)
    monkeypatch.setattr(httpx, "AsyncClient", lambda *a, **kw: client)

    postings = await adapter.search("", {}, {"company_identifiers": ["huggingface"]})
    assert len(postings) == len(data["jobs"])
    assert all(p.company_name == "huggingface" for p in postings)


async def test_telecommuting_maps_to_remote_policy(adapter, monkeypatch):
    client = _mock_client(_fixture_data())
    monkeypatch.setattr(httpx, "AsyncClient", lambda *a, **kw: client)

    postings = await adapter.search("", {}, {"company_identifiers": ["huggingface"]})
    assert all(p.remote_policy == "remote" for p in postings if p.remote_policy is not None)


async def test_requirements_stripped_of_html(adapter, monkeypatch):
    client = _mock_client(_fixture_data())
    monkeypatch.setattr(httpx, "AsyncClient", lambda *a, **kw: client)

    postings = await adapter.search("", {}, {"company_identifiers": ["huggingface"]})
    text = postings[0].requirements
    assert text is not None
    assert "<" not in text
    assert "&lt;" not in text


async def test_external_requisition_id_is_shortcode(adapter, monkeypatch):
    client = _mock_client(_fixture_data())
    monkeypatch.setattr(httpx, "AsyncClient", lambda *a, **kw: client)

    postings = await adapter.search("", {}, {"company_identifiers": ["huggingface"]})
    fixture_shortcodes = {j["shortcode"] for j in _fixture_data()["jobs"]}
    assert {p.external_requisition_id for p in postings} == fixture_shortcodes


async def test_missing_salary_is_null_not_zero(adapter, monkeypatch):
    client = _mock_client(_fixture_data())
    monkeypatch.setattr(httpx, "AsyncClient", lambda *a, **kw: client)

    postings = await adapter.search("", {}, {"company_identifiers": ["huggingface"]})
    assert all(p.salary_min is None and p.salary_max is None for p in postings)


async def test_multi_identifier_fan_out(adapter, monkeypatch):
    """The whole point of M2 §5/§6 — one Source scans every identifier
    in the list, not one company per Source."""

    data = _fixture_data()

    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=data, request=request)

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    monkeypatch.setattr(httpx, "AsyncClient", lambda *a, **kw: client)

    postings = await adapter.search("", {}, {"company_identifiers": ["huggingface", "some-other-account"]})
    assert len(postings) == len(data["jobs"]) * 2
    assert {p.company_name for p in postings} == {"huggingface", "some-other-account"}


async def test_missing_company_identifiers_raises(adapter):
    with pytest.raises(ValueError, match="company_identifiers"):
        await adapter.search("", {}, {})


async def test_one_bad_identifier_does_not_stop_the_others(adapter, monkeypatch):
    data = _fixture_data()

    async def handler(request: httpx.Request) -> httpx.Response:
        if "dead-account" in str(request.url):
            return httpx.Response(404, request=request)
        return httpx.Response(200, json=data, request=request)

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    monkeypatch.setattr(httpx, "AsyncClient", lambda *a, **kw: client)

    postings = await adapter.search("", {}, {"company_identifiers": ["dead-account", "huggingface"]})
    assert len(postings) == len(data["jobs"])
    assert all(p.company_name == "huggingface" for p in postings)


async def test_connection_failure_surfaces_cleanly(adapter, monkeypatch):
    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(404, request=request)

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    monkeypatch.setattr(httpx, "AsyncClient", lambda *a, **kw: client)

    result = await adapter.test_connection({"company_identifiers": ["nonexistent-account-xyz"]})
    assert result.ok is False


@pytest.mark.live
async def test_live_huggingface_board():
    """Opt-in — run explicitly with: pytest -m live"""
    adapter = WorkableAdapter()
    result = await adapter.test_connection({"company_identifiers": ["huggingface"]})
    assert result.ok is True

    postings = await adapter.search("", {}, {"company_identifiers": ["huggingface"]})
    assert len(postings) > 0
    assert all(p.title for p in postings)
