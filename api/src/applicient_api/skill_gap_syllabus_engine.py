"""Phase 10 (v2 plan) — a short learning plan for one skill-gap item:
a few reference links and a couple of small project ideas. Deliberately
NOT run through the claim-verification pipeline (`claim_verification_service.py`)
the way a CV/cover letter is — this isn't a factual claim about the
candidate, it's generic educational content recommended to them, so
there's nothing to verify against the evidence bank.

Known, disclosed limitation: this model has no web-browsing/search
tool wired in, so a recommended url is generated from the model's own
training knowledge, not fetched/confirmed live — it can still be
stale or wrong. The system prompt below pushes hard toward
well-known, stable platforms (official docs, established course
sites) rather than obscure/deep links to reduce that risk, but this
is not a hard guarantee; a generated syllabus is worth a human glance,
same as any other LLM output in this codebase.
"""

from __future__ import annotations

from langchain_core.language_models.chat_models import BaseChatModel
from pydantic import BaseModel, Field

from applicient_api.llm_retry import invoke_structured_with_retry


class SyllabusResource(BaseModel):
    title: str
    url: str
    kind: str = Field(description='One or two words, e.g. "docs", "course", "video", "article".')


class SyllabusProjectIdea(BaseModel):
    title: str
    description: str = Field(description="One sentence — what to build and what it demonstrates.")


class SkillGapSyllabusOutput(BaseModel):
    resources: list[SyllabusResource]
    project_ideas: list[SyllabusProjectIdea]


_SYSTEM_PROMPT = """You build a short, practical learning plan to help a job candidate close one specific skill gap before they apply/interview.

Recommend REAL, well-known, stable resources only — official documentation, established platforms (MDN, freeCodeCamp, Coursera, an official framework/language's own docs site, a well-known YouTube channel or course), never an invented or suspicious-looking deep link. If you are not confident a specific deep-link URL is real, link the platform's real homepage/search page instead of guessing a path.

Give:
- 2-4 reference resources (a sensible mix of a primer doc/article and a video/course where it fits the skill), each with a real url and a short "kind" label.
- 2-3 small project ideas that let the candidate practically demonstrate this skill — each scoped to be doable in a few days, not weeks, with a one-sentence description of what to build."""


def run_syllabus_generation(model: BaseChatModel, *, skill_text: str, job_context: str) -> SkillGapSyllabusOutput:
    structured = model.with_structured_output(SkillGapSyllabusOutput)
    prompt = (
        f"SKILL GAP TO ADDRESS: {skill_text}\n\n"
        f"CONTEXT — roles this skill is needed for (tailor resource depth/level to these, don't ignore them):\n"
        f"{job_context}"
    )
    result = invoke_structured_with_retry(structured, [("system", _SYSTEM_PROMPT), ("user", prompt)])
    if not isinstance(result, SkillGapSyllabusOutput):
        raise RuntimeError(f"skill-gap syllabus structured output call returned unexpected type: {type(result)}")
    return result
