"""Phase 11 (v2 plan) — scores a finished interview/FGD/LGD practice
session from its full transcript. Same shape as
skill_gap_syllabus_engine.py: a Pydantic structured-output model + one
plain function, no claim-verification pipeline involved (this isn't a
factual claim about the candidate that needs checking against the
evidence bank — it's an assessment of how they answered)."""

from __future__ import annotations

from langchain_core.language_models.chat_models import BaseChatModel
from pydantic import BaseModel, Field

from applicient_api.llm_retry import invoke_structured_with_retry


class InterviewCategoryFeedback(BaseModel):
    category: str = Field(description="Which part of the session this covers, in the candidate's own terms, e.g. \"Role fit\", \"Past experience\", \"Communication\".")
    score: float = Field(description="0-100.")
    notes: str = Field(description="A few sentences — what was strong, what was weak, specific to what was actually said.")


class InterviewFeedbackOutput(BaseModel):
    overall_score: float = Field(description="0-100, an honest overall assessment, not an average that rounds everyone up.")
    summary: str = Field(description="2-4 sentences, the headline takeaway from this session.")
    categories: list[InterviewCategoryFeedback]
    strengths: list[str] = Field(description="Concrete, specific things the candidate did well — not generic praise.")
    areas_to_improve: list[str] = Field(description="Concrete, specific, actionable — something they could actually do differently next time.")


_SYSTEM_PROMPT = """You are an experienced interview coach reviewing a full practice session transcript (a series of questions asked and the candidate's transcribed spoken answers, or — for a group discussion practice — a moderator/case plus the candidate's own contributions alongside simulated other participants).

Score honestly, not generously — a score that flatters every answer is useless as feedback. Ground every point in something the candidate actually said; never invent an example they didn't give. If the transcript is very short or the candidate barely answered, say so plainly and score accordingly rather than padding the assessment.

For a group discussion (FGD/LGD) session, focus your assessment specifically on the CANDIDATE's own contributions — their points, how they engaged with other (simulated) participants, whether they built on or rebutted others' points constructively — not on the simulated participants' own dialogue."""


def run_interview_feedback(model: BaseChatModel, *, transcript: str, practice_type: str) -> InterviewFeedbackOutput:
    structured = model.with_structured_output(InterviewFeedbackOutput)
    prompt = (
        f"SESSION TYPE: {practice_type}\n\n"
        f"FULL TRANSCRIPT:\n{transcript}\n\n"
        "Score this session and give structured feedback per the schema."
    )
    result = invoke_structured_with_retry(structured, [("system", _SYSTEM_PROMPT), ("user", prompt)])
    if not isinstance(result, InterviewFeedbackOutput):
        raise RuntimeError(f"interview feedback structured output call returned unexpected type: {type(result)}")
    return result
