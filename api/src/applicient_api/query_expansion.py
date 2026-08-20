"""M1 §3 — expand a saved-search role title into source-appropriate
query variants using a structured `fast`-tier call, with a
deterministic fallback (the role title verbatim) when the model call
fails or the tier isn't configured. Query expansion is an enhancement,
not a precondition: a radar run must still produce real results
without it, just less broadly-matched ones — so this never raises,
and instead reports why it fell back so the run trace stays honest
about it (never a silent "queries == [role_title]" with no
explanation)."""

from __future__ import annotations

from langchain_core.language_models.chat_models import BaseChatModel
from pydantic import BaseModel, Field


class _ExpandedQueries(BaseModel):
    queries: list[str] = Field(
        description=(
            "2-4 short search-query-style variants of the role title — the "
            "style someone would type into a job board search box, not full "
            "sentences. Include common synonyms/abbreviations (e.g. 'ML "
            "Engineer' <-> 'Machine Learning Engineer') and closely adjacent "
            "titles for the SAME role. Never drift to a different role, "
            "seniority level, or department."
        )
    )


_SYSTEM_PROMPT = (
    "You expand a single job-role title into short search query variants "
    "suitable for a job board's search endpoint. Stay strictly within the "
    "same role and seniority as the input — variants, not alternatives. "
    "Return AT MOST 3 variants (not counting the original title) — every "
    "variant is a real, separate network call downstream, so more is not "
    "better here."
)

# Enforced in code, not just asked for in the prompt: a live run
# against a real model returned 12 variants despite the prompt asking
# for 2-4 — each one is a separate adapter.search() call, and some
# adapters (Greenhouse, RemoteOK) refetch their *entire* listing per
# call (confirmed live — Greenhouse ~5s/3MB for a mid-size board,
# RemoteOK's own search has no server-side filtering at all) rather
# than querying server-side, so uncapped variants turned one role
# title into a 60-second-plus radar run all by itself. Field/prompt
# instructions alone weren't reliable enough for this, same lesson as
# cv_parsing.py's date formatting and title/employer split.
#
# `max_queries` is a per-title CEILING passed in by the caller, not a
# fixed constant — raised by Adrian after watching a 4-role-title
# search generate up to 16 total RemoteOK refetches (4 titles × this
# module's old fixed cap of 4). radar.py now derives it from a single
# whole-search budget (6 total queries across every role title, see
# radar.py's `_max_queries_per_title`) so the total stays bounded
# regardless of how many role titles a saved search has, not just how
# many variants any one title gets.
DEFAULT_MAX_QUERIES = 4  # including the original title — radar.py's own floor/ceiling


def expand_role_title(
    model: BaseChatModel, role_title: str, max_queries: int = DEFAULT_MAX_QUERIES
) -> tuple[list[str], str | None]:
    """Returns (queries, fallback_reason). fallback_reason is None only
    on a genuine model-produced expansion; otherwise it names why the
    result is just `[role_title]` — a model failure, or (when
    `max_queries <= 1`) a deliberate skip because the whole-search
    query budget left no room for variants on this title, not a
    failure at all."""

    if max_queries <= 1:
        return [role_title], "no query budget left for this title (whole-search cap reached)"

    try:
        structured = model.with_structured_output(_ExpandedQueries)
        result = structured.invoke([("system", _SYSTEM_PROMPT), ("user", role_title)])
    except Exception as exc:
        return [role_title], f"model call failed: {str(exc)[:200]}"

    if not isinstance(result, _ExpandedQueries) or not result.queries:
        return [role_title], "structured output call returned no queries"

    seen: set[str] = set()
    queries: list[str] = []
    for candidate in [role_title, *result.queries]:
        key = candidate.strip().lower()
        if key and key not in seen:
            seen.add(key)
            queries.append(candidate.strip())
        if len(queries) >= max_queries:
            break
    return queries, None
