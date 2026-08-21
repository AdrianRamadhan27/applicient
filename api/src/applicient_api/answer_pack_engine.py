"""M3 §6/F6.8 — the Answer Pack: ready-to-copy answers to an
application's real screening questions. Same evidence-linked, verified
pipeline as the CV/cover letter.

Unlike the CV/cover letter, this system has no structured screening-
question data anywhere (that would mean scraping the real application
form, which is M4/F6 territory, not built yet) — so the questions are
user-supplied, pasted in from the real application, not guessed or
templated. Answering them still goes through the same evidence-only
grounding and adversarial verification as everything else.
"""

from __future__ import annotations

import uuid

from langchain_core.language_models.chat_models import BaseChatModel
from pydantic import BaseModel, Field

from applicient_api.llm_retry import invoke_structured_with_retry
from applicient_api.models.discovery import Job
from applicient_api.models.profile import EvidenceItem, Preference, Profile
from applicient_api.tailoring_engine import evidence_bank_summary, job_group_summary, profile_summary


class AnswerPackAnswer(BaseModel):
    question: str
    evidence_ids: list[uuid.UUID] = Field(
        default_factory=list,
        description="Evidence items this answer draws from — empty only if the question is purely non-factual (e.g. availability/logistics with no accomplishment claim).",
    )
    answer: str


class AnswerPackOutput(BaseModel):
    answers: list[AnswerPackAnswer]


_ANSWER_PACK_SYSTEM_PROMPT = """You are answering a candidate's real application screening questions, grounded only in their evidence bank. Never invent an accomplishment, employer, title, date, metric, or skill that isn't in the evidence bank.

Rules:
- Answer every question given, in the order given, one answer per question.
- Every factual claim in an answer must cite the evidence_id(s) it's derived from.
- Rephrasing/reweighting emphasis toward what these jobs value is allowed — inventing new facts is not.
- Never alter or imply a different date, employer, title, or degree classification than the evidence bank states (F5.9).
- Never generate claims about protected characteristics (F5.9)."""


def run_answer_pack_generation(
    model: BaseChatModel,
    *,
    questions: list[str],
    jobs: list[Job],
    profile: Profile,
    persona_name: str,
    evidence_items: list[EvidenceItem],
    preference: Preference | None = None,
    prior_violations: list[str] | None = None,
) -> AnswerPackOutput:
    structured = model.bind(max_tokens=8000).with_structured_output(AnswerPackOutput)
    questions_text = "\n".join(f"{i + 1}. {q}" for i, q in enumerate(questions))
    prompt = (
        f"CANDIDATE:\n{profile_summary(profile, persona_name, preference)}\n\n"
        f"CANDIDATE'S FULL EVIDENCE BANK (cite evidence_id exactly as shown):\n{evidence_bank_summary(evidence_items)}\n\n"
        f"JOB GROUP ({len(jobs)} posting(s) this application is for):\n{job_group_summary(jobs)}\n\n"
        f"SCREENING QUESTIONS TO ANSWER:\n{questions_text}"
    )
    if prior_violations:
        violations_text = "\n".join(f"- {v}" for v in prior_violations)
        prompt += (
            "\n\nYOUR PREVIOUS ATTEMPT WAS REJECTED BY THE CLAIM VERIFIER. Fix these specific "
            f"violations — do not repeat them, and do not introduce new ones:\n{violations_text}"
        )
    result = invoke_structured_with_retry(structured, [("system", _ANSWER_PACK_SYSTEM_PROMPT), ("user", prompt)])
    if not isinstance(result, AnswerPackOutput):
        raise RuntimeError(f"answer pack structured output call returned unexpected type: {type(result)}")
    return result


def validate_answer_pack_evidence(output: AnswerPackOutput, evidence_items: list[EvidenceItem]) -> AnswerPackOutput:
    real_ids = {item.id for item in evidence_items}
    answers = [
        AnswerPackAnswer(
            question=a.question,
            evidence_ids=[eid for eid in a.evidence_ids if eid in real_ids],
            answer=a.answer,
        )
        for a in output.answers
    ]
    return AnswerPackOutput(answers=answers)


def answer_pack_claims_text(output: AnswerPackOutput) -> str:
    lines = []
    for a in output.answers:
        ids = ", ".join(str(i) for i in a.evidence_ids) if a.evidence_ids else "(none)"
        lines.append(f'[answer to "{a.question}", cites evidence_id(s)={ids}] {a.answer}')
    return "\n".join(lines)
