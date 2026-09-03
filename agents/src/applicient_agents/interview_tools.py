"""Phase 11 (v2 plan) — interview-practice agent's own tool surface.
Deliberately small: unlike the orchestrator, most of this agent's
grounding (the target job's real fields, the persona's real evidence
bank) is baked directly into the initial task message by
interview_service.py, not exposed as callable tools — that context is
static for the whole session, not something the agent needs to decide
*when* to fetch, so it doesn't belong here (same "static context goes
in the prompt, only real decisions get a tool" reasoning
application_service.py's own `_candidate_info_block` already follows).
"""

from __future__ import annotations

from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.tools import tool


def build_interview_tools(*, model: BaseChatModel, supports_web_search: bool) -> list:
    @tool
    def search_company_interview_questions(company_name: str) -> str:
        """Look up real, commonly-reported interview questions/experiences for a specific company —
        use this when the target company is one you recognize as large/well-known, before relying
        purely on general knowledge to ask company-specific questions. Not available for every
        company (returns a plain note when it isn't), and even when it runs, treat the result as
        a helpful signal, not a guaranteed-accurate source — never present anything from this as a
        literal verbatim quote from the company."""

        if not supports_web_search:
            return (
                "Web search isn't available in this deployment (no OpenRouter connection configured) — "
                "rely on your own general knowledge of this company's interview style instead."
            )
        try:
            response = model.invoke(
                [
                    (
                        "system",
                        "You research real, commonly-reported interview questions and interview "
                        "experiences for a specific company, from real candidate reports (Glassdoor-style "
                        "sources, forums, blog posts). Summarize concretely — actual question examples and "
                        "what the process is reportedly like — not generic interview advice. If you find "
                        "nothing genuinely specific to this company, say so plainly rather than padding "
                        "with generic content.",
                    ),
                    ("user", f"Real, reported interview questions and interview process notes for: {company_name}"),
                ],
                # OpenRouter's own web-search plugin — grounds this one
                # call in real search results without a separate
                # search-provider API key (confirmed live against
                # OpenRouter's catalog that this is a real, supported
                # feature; not yet confirmed against an authenticated
                # call the way the model catalog itself was).
                extra_body={"plugins": [{"id": "web"}]},
            )
        except Exception as exc:
            return f"error: company research lookup failed ({exc}) — fall back to your own general knowledge instead."
        return str(response.content)[:3000]

    return [search_company_interview_questions]
