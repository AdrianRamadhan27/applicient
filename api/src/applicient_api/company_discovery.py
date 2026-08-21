"""M2 §5 — F2.10 preference-driven company discovery: propose real
candidate companies from a persona's stated `Preference`, then resolve
each against the six ATS URL patterns this codebase now has adapters
for (§4). A candidate that matches none of them remains `unresolved`
when it came only from the preference proposal step, while a real,
non-ATS apply URL already present on a posting is preserved as
`needs_generic_scraping` for M4.

**Real, stated scope cut**: F2.10/the M2 checklist also calls for
finding a bespoke career-page URL from a preference-only company
proposal via a web search. No web-search credential (SerpAPI/Google
Custom Search/Bing) is wired into this codebase, and Adrian hasn't
said which to use yet. Rather than guess a credential or, worse, let
the LLM invent a career-page URL from its own training knowledge
(exactly the kind of unverified-URL fabrication this project's own
standing instructions rule out), preference-only companies with no
known ATS stay `unresolved`. The apply-link path is different: the URL
is real evidence already stored on a posting, so it is safe to queue
that exact URL without pretending the generic scraper exists.

**ATS resolution is a best-effort slug guesser, not authoritative.**
A company chooses its own ATS identifier; there's no way to derive it
deterministically from the company's display name. This tries a small
set of plausible transformations (lowercase-hyphenated, lowercase-no-
space, original casing) against all six platforms and keeps the first
live match. A resolution failure does NOT mean the company has no ATS
— it may simply use an identifier none of these variants happened to
guess. Stated plainly rather than presented as a definitive check.

**Every prober requires at least one real posting, not just a 200** —
found live, not theorized: a random truly-nonexistent slug 404s on
every platform, but a *registered, real, empty* account can still
return 200 on at least one of them. Confirmed directly: `ramp` is a
real (if empty/unused) Workable account (`{"name":"RAMP","jobs":[]}`,
HTTP 200) entirely separate from the actual fintech Ramp, whose real
ATS is Ashby — resolving "Ramp" without this check picked the empty
Workable account first purely because of trial order, a wrong answer
that looked structurally fine. An empty board is also simply useless
as a scan target regardless of whether it's the "right" company, so
requiring `>0` postings is a strict improvement, not just a collision
guard. This is deliberately a *different* standard than the adapters'
own `search()` in §4, which correctly treats a zero-posting board as a
legitimate steady state for an *already-confirmed* real company
(Lever's own docstring says as much) — resolution hasn't confirmed
that yet, so it holds a stricter bar here. SmartRecruiters needs the
same idea via a different signal (`totalFound`, since its list
response has no simple length to check before knowing the field name).
"""

from __future__ import annotations

import asyncio
import re
from dataclasses import dataclass
from typing import Literal

import httpx
from langchain_core.language_models.chat_models import BaseChatModel
from pydantic import BaseModel, Field

from applicient_api.models.profile import Preference

_PROBE_TIMEOUT_SECONDS = 6.0
_PROBE_CONCURRENCY = 6

CandidateStatusLiteral = Literal[
    "resolved_greenhouse",
    "resolved_lever",
    "resolved_workable",
    "resolved_ashby",
    "resolved_smartrecruiters",
    "resolved_recruitee",
    "unresolved",
    "needs_generic_scraping",
]

# --- Candidate generation (LLM step) ---


class CandidateProposal(BaseModel):
    company_name: str = Field(description="A real, actual company name — never invented or placeholder.")
    rationale: str = Field(description="One sentence on why this company fits the stated preferences.")


class CandidateProposalList(BaseModel):
    candidates: list[CandidateProposal] = Field(default_factory=list)


_DISCOVERY_SYSTEM_PROMPT = """You are proposing real companies worth a job seeker's attention, based on their stated preferences.

Every company you name MUST be a real, actual company you have genuine knowledge of — never invent a plausible-sounding name, never pad the list with a placeholder to hit a count. If you can only confidently name 6 real companies that fit, return 6, not a padded 15.

Weight target roles, industries, company size and locations from the stated preferences. Give each one a short, concrete reason it fits — not generic praise."""


def _preference_summary(preference: Preference) -> str:
    lines = []
    if preference.target_roles:
        lines.append(f"Target roles: {', '.join(preference.target_roles)}")
    if preference.industries_include:
        lines.append(f"Industries wanted: {', '.join(preference.industries_include)}")
    if preference.industries_exclude:
        lines.append(f"Industries to avoid: {', '.join(preference.industries_exclude)}")
    if preference.company_size_pref:
        lines.append(f"Company size preference: {', '.join(preference.company_size_pref)}")
    if preference.locations:
        lines.append(f"Target locations: {', '.join(preference.locations)}")
    if preference.willing_to_relocate:
        lines.append("Open to relocating beyond the target locations above.")
    if preference.remote_policy:
        lines.append(f"Remote-work preference: {', '.join(preference.remote_policy)}")
    return "\n".join(lines) if lines else "(no preferences stated)"


def propose_candidates(model: BaseChatModel, *, preference: Preference, limit: int = 12) -> list[CandidateProposal]:
    structured = model.with_structured_output(CandidateProposalList)
    prompt = (
        f"Propose up to {limit} real companies for this candidate, based on these stated preferences:\n\n"
        f"{_preference_summary(preference)}"
    )
    result = structured.invoke([("system", _DISCOVERY_SYSTEM_PROMPT), ("user", prompt)])
    if not isinstance(result, CandidateProposalList):
        raise RuntimeError(f"candidate proposal structured output call returned unexpected type: {type(result)}")
    return result.candidates[:limit]


# --- ATS resolution ---


@dataclass
class Resolution:
    status: CandidateStatusLiteral
    identifier: str | None
    url: str | None


_SUFFIX_RE = re.compile(r"[,.]?\s*\b(inc|llc|ltd|corp|corporation|co)\b\.?\s*$", re.IGNORECASE)


def _slug_variants(company_name: str) -> list[str]:
    base = _SUFFIX_RE.sub("", company_name.strip()).strip()
    hyphenated = re.sub(r"[^a-zA-Z0-9]+", "-", base).strip("-").lower()
    no_space = re.sub(r"[^a-zA-Z0-9]", "", base).lower()
    original_no_space = re.sub(r"[^a-zA-Z0-9]", "", base)  # keeps original casing — SmartRecruiters cares
    variants = []
    for v in (hyphenated, no_space, original_no_space):
        if v and v not in variants:
            variants.append(v)
    return variants


async def _probe(client: httpx.AsyncClient, method: str, url: str, **kwargs) -> httpx.Response | None:
    try:
        return await client.request(method, url, timeout=_PROBE_TIMEOUT_SECONDS, **kwargs)
    except httpx.RequestError:
        return None


def _json_or_none(resp: httpx.Response) -> dict | list | None:
    try:
        return resp.json()
    except ValueError:
        return None


async def _try_greenhouse(client: httpx.AsyncClient, slug: str) -> Resolution | None:
    resp = await _probe(client, "GET", f"https://boards-api.greenhouse.io/v1/boards/{slug}/jobs")
    if resp is None or resp.status_code != 200:
        return None
    data = _json_or_none(resp)
    if isinstance(data, dict) and data.get("jobs"):
        return Resolution("resolved_greenhouse", slug, f"https://boards.greenhouse.io/{slug}")
    return None


async def _try_lever(client: httpx.AsyncClient, slug: str) -> Resolution | None:
    resp = await _probe(client, "GET", f"https://api.lever.co/v0/postings/{slug}", params={"mode": "json"})
    if resp is None or resp.status_code != 200:
        return None
    data = _json_or_none(resp)
    if isinstance(data, list) and data:
        return Resolution("resolved_lever", slug, f"https://jobs.lever.co/{slug}")
    return None


async def _try_workable(client: httpx.AsyncClient, slug: str) -> Resolution | None:
    resp = await _probe(client, "GET", f"https://apply.workable.com/api/v1/widget/accounts/{slug}")
    if resp is None or resp.status_code != 200:
        return None
    data = _json_or_none(resp)
    if isinstance(data, dict) and data.get("jobs"):
        return Resolution("resolved_workable", slug, f"https://apply.workable.com/{slug}")
    return None


async def _try_ashby(client: httpx.AsyncClient, slug: str) -> Resolution | None:
    resp = await _probe(client, "GET", f"https://api.ashbyhq.com/posting-api/job-board/{slug}")
    if resp is None or resp.status_code != 200:
        return None
    data = _json_or_none(resp)
    if isinstance(data, dict) and data.get("jobs"):
        return Resolution("resolved_ashby", slug, f"https://jobs.ashbyhq.com/{slug}")
    return None


async def _try_smartrecruiters(client: httpx.AsyncClient, slug: str) -> Resolution | None:
    resp = await _probe(
        client, "GET", f"https://api.smartrecruiters.com/v1/companies/{slug}/postings", params={"limit": 1}
    )
    if resp is None or resp.status_code != 200:
        return None
    try:
        data = resp.json()
    except ValueError:
        return None
    # See module docstring — totalFound must be > 0, a bare 200 is not enough.
    if data.get("totalFound", 0) > 0:
        return Resolution("resolved_smartrecruiters", slug, f"https://jobs.smartrecruiters.com/{slug}")
    return None


async def _try_recruitee(client: httpx.AsyncClient, slug: str) -> Resolution | None:
    resp = await _probe(client, "GET", f"https://{slug}.recruitee.com/api/offers/")
    if resp is None or resp.status_code != 200:
        return None
    data = _json_or_none(resp)
    if isinstance(data, dict) and data.get("offers"):
        return Resolution("resolved_recruitee", slug, f"https://{slug}.recruitee.com")
    return None


_TRIERS = (_try_greenhouse, _try_lever, _try_workable, _try_ashby, _try_smartrecruiters, _try_recruitee)


async def resolve_company_ats(company_name: str) -> Resolution:
    """Tries every slug variant against every known ATS, bounded
    concurrency, and returns the first live match. Order across
    variants/platforms is deterministic (not "fastest response wins")
    so the same company name resolves the same way every time this
    runs, not by network-timing luck."""

    variants = _slug_variants(company_name)
    if not variants:
        return Resolution("unresolved", None, None)

    semaphore = asyncio.Semaphore(_PROBE_CONCURRENCY)

    async def bounded(trier, client, slug):
        async with semaphore:
            return await trier(client, slug)

    async with httpx.AsyncClient() as client:
        tasks = [bounded(trier, client, slug) for slug in variants for trier in _TRIERS]
        results = await asyncio.gather(*tasks)

    # Deterministic precedence: first variant (in the order _slug_variants
    # produced them), then first ATS (in _TRIERS order) — matches the
    # flat task list's own construction order above.
    for result in results:
        if result is not None:
            return result
    return Resolution("unresolved", None, None)


# --- Apply-link classification (M2 §5 — signal from postings already
# found via any other source, not just discovery's own proposals) ---

_APPLY_URL_PATTERNS: list[tuple[re.Pattern, CandidateStatusLiteral]] = [
    (re.compile(r"(?:job-)?boards\.greenhouse\.io/([^/?]+)", re.IGNORECASE), "resolved_greenhouse"),
    (re.compile(r"jobs\.lever\.co/([^/?]+)", re.IGNORECASE), "resolved_lever"),
    (re.compile(r"jobs\.ashbyhq\.com/([^/?]+)", re.IGNORECASE), "resolved_ashby"),
    (re.compile(r"jobs\.smartrecruiters\.com/([^/?]+)", re.IGNORECASE), "resolved_smartrecruiters"),
    (re.compile(r"([a-z0-9-]+)\.recruitee\.com", re.IGNORECASE), "resolved_recruitee"),
    # Workable's own apply links are frequently a bare shortcode
    # (`apply.workable.com/j/{shortcode}`) with no account slug in the
    # URL at all — confirmed live (§4's own workable.py fixture). A
    # match here confirms "this is a Workable posting," but the
    # identifier group is often empty/not a real account slug. Kept
    # last and always double-checked below rather than trusted blindly.
    (re.compile(r"apply\.workable\.com/([^/?]+)", re.IGNORECASE), "resolved_workable"),
]


def classify_apply_url(url: str | None) -> Resolution | None:
    """Classify a posting's apply URL without guessing an ATS identifier.

    Known ATS URLs return their adapter-shaped resolution. A valid HTTP(S)
    URL that matches no known ATS is still useful evidence: it is recorded
    as ``needs_generic_scraping`` so M4's browser worker can handle it later.
    ``None`` is reserved for an absent or malformed URL, not an unknown but
    real career-site URL.
    """

    if not url:
        return None
    for pattern, status in _APPLY_URL_PATTERNS:
        match = pattern.search(url)
        if not match:
            continue
        identifier = match.group(1)
        if status == "resolved_workable" and identifier == "j":
            # The bare-shortcode form (`/j/{shortcode}`) — "j" itself
            # is a path segment, not an account slug. Confirmed this
            # is a real, not a hypothetical, shape (§4's workable.py).
            return Resolution(status, None, url)
        return Resolution(status, identifier, url)
    if re.match(r"^https?://[^\s]+$", url, re.IGNORECASE):
        return Resolution("needs_generic_scraping", None, url)
    return None
