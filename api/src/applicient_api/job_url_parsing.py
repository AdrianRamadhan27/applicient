"""Job Inbox manual-add, URL half (M4/M-later manual data entry) — given
one job-posting URL from any site (LinkedIn, Indeed, a company career
page, anything), extract the same fields the manual-entry form asks
for, so pasting a link is a shortcut for typing them in, not a
different path.

The page's structure is never known ahead of time, exactly the problem
`sources/generic_scraper.py` already solved for a whole *listing* page
— same solution here: open it in a real browser (LinkedIn/Indeed-class
sites are JS-heavy and anti-bot-gated, a plain httpx GET would very
likely get blocked or return an empty shell), read back its
accessibility-tree snapshot, hand that to an LLM with a structured
output schema. `_open_and_snapshot` below is a deliberate copy of
generic_scraper's own private method, not a shared import — that
module's version is instance-bound (its own cache/lock), and importing
from `agents.browser_tools` instead would pull in the whole
`build_application_tools` toolset for one HTTP round-trip.

Deliberately NOT a deepagents agent, same reasoning as cv_parsing.py:
this is one bounded, well-defined extraction, not an open-ended task.
"""

from __future__ import annotations

import os

import httpx
from langchain_core.language_models.chat_models import BaseChatModel
from pydantic import BaseModel, Field

BROWSER_WORKER_URL = os.environ.get("BROWSER_WORKER_URL", "http://localhost:8100")
_REQUEST_TIMEOUT_SECONDS = 45.0


class JobUrlParseError(Exception):
    pass


class ExtractedJob(BaseModel):
    """`found=False` covers everything that isn't a real, single job
    posting — an error page, a login wall, a search/listing page, or
    unrelated content. Every other field stays null rather than
    invented when the source page doesn't state it (same "never
    estimated" discipline as RawPosting/F3.1a)."""

    found: bool = Field(
        description=(
            "True only if this is a real, single job posting with enough content to extract. "
            "False for an error page, login wall, a listing/search-results page (many jobs, not "
            "one), or anything else that isn't one specific job posting."
        )
    )
    title: str | None = None
    company_name: str | None = None
    location: str | None = None
    remote_policy: str | None = Field(default=None, description="One of: remote, hybrid, onsite — only if the page actually states it.")
    seniority: str | None = None
    employment_type: str | None = Field(default=None, description="e.g. full_time, part_time, contract, internship.")
    salary_min: float | None = None
    salary_max: float | None = None
    salary_currency: str | None = Field(default=None, description="ISO currency code, e.g. USD, IDR.")
    requirements: str | None = None
    responsibilities: str | None = None
    benefits: str | None = None
    apply_url: str | None = Field(
        default=None,
        description="The page's own real apply link/button href, only if it's a different URL than the page itself.",
    )


_SYSTEM_PROMPT = """You are extracting one job posting's details from a single page's \
accessibility-tree snapshot (not raw HTML) — a ref-annotated text representation of the \
page's interactive/text content. The page's structure was never seen before and could be \
from any job board or company career site; infer it from what's given, don't assume a \
particular layout.

Extract only what's genuinely present in the snapshot — never invent a title, company, \
salary figure, or any other field that isn't actually stated. Leave a field null rather \
than guessing or estimating.

Set found=false if this snapshot isn't a real, single job posting — a login wall, an error \
page, a search/listing page showing many jobs at once, or anything else that isn't one \
specific job's own page. Do not force an extraction onto something that isn't one."""

_MAX_SNAPSHOT_CHARS = 15_000


async def open_snapshot_and_close(url: str) -> str | None:
    """One-shot open -> read the accessibility-tree snapshot -> close,
    for a single URL. Returns None if the browser-worker couldn't open
    it at all (unreachable, timeout, blocked) — distinguished from
    "opened fine, not a job posting" (found=False from the LLM call),
    so a dead/unreachable link gets its own distinct error message."""

    async with httpx.AsyncClient(timeout=_REQUEST_TIMEOUT_SECONDS) as client:
        try:
            r = await client.post(f"{BROWSER_WORKER_URL}/sessions", json={"url": url})
        except httpx.HTTPError:
            return None
        if r.is_error:
            return None
        data = r.json()
        session_id, snapshot = data["session_id"], data["snapshot"]
        try:
            await client.delete(f"{BROWSER_WORKER_URL}/sessions/{session_id}")
        except httpx.HTTPError:
            pass
    return snapshot


def parse_job_snapshot(model: BaseChatModel, url: str, snapshot: str) -> ExtractedJob:
    structured_model = model.with_structured_output(ExtractedJob)
    result = structured_model.invoke(
        [
            ("system", _SYSTEM_PROMPT),
            ("user", f"Job posting URL: {url}\n\nAccessibility-tree snapshot:\n\n{snapshot[:_MAX_SNAPSHOT_CHARS]}"),
        ]
    )
    if not isinstance(result, ExtractedJob):
        raise JobUrlParseError(f"structured output call returned unexpected type: {type(result)}")
    return result
