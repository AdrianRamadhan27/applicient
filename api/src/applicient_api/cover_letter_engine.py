"""M3 §6/F5.7 — cover letter generation. Same evidence-linked, verified
pipeline as the CV (`tailoring_engine.py`), a different content shape:
prose paragraphs instead of CV sections/bullets, since a cover letter
isn't structured around discrete evidence entries the way a CV is.

Not every paragraph cites evidence — an opening/closing line ("Dear
Hiring Team," / "Sincerely, ...") is boilerplate, not a factual claim,
and `validate_cover_letter_evidence` only strips invalid evidence_ids
from a paragraph rather than requiring every paragraph to have at
least one real citation the way a CV section does.
"""

from __future__ import annotations

import uuid

from langchain_core.language_models.chat_models import BaseChatModel
from pydantic import BaseModel, Field

from applicient_api.llm_retry import invoke_structured_with_retry
from applicient_api.models.discovery import Job
from applicient_api.models.profile import EvidenceItem, Preference, Profile
from applicient_api.tailoring_engine import evidence_bank_summary, job_group_summary, profile_summary


class CoverLetterParagraph(BaseModel):
    evidence_ids: list[uuid.UUID] = Field(
        default_factory=list,
        description="Evidence items this paragraph draws from — empty for a purely non-factual opening/closing line.",
    )
    text: str


class CoverLetterOutput(BaseModel):
    greeting: str = Field(description='e.g. "Dear Hiring Team," — no factual claims, never verified.')
    paragraphs: list[CoverLetterParagraph]
    closing: str = Field(description='e.g. "Sincerely,\\nFull Name" — no factual claims, never verified.')


_COVER_LETTER_SYSTEM_PROMPT = """You are writing a cover letter for a candidate applying to a group of one or more job postings a single letter must serve. Ground every factual claim in the candidate's real evidence bank — never invent an accomplishment, employer, title, date, metric, or skill that isn't there.

Rules:
- Every paragraph that makes a factual claim about the candidate must cite the evidence_id(s) it's derived from. A purely rhetorical/transitional paragraph with no factual content can cite none.
- Rephrasing/reweighting emphasis toward what these jobs value is allowed — inventing new facts is not.
- An opening naming genuine interest in the role/company (as stated in the posting, not invented), then paragraph(s) grounding fit in real evidence, and a closing.
- Follow the requested length and tone exactly — a candidate who asked for "short" does not want a long letter regardless of how much evidence is available.
- Never alter or imply a different date, employer, title, or degree classification than the evidence bank states (F5.9).
- Never generate claims about protected characteristics (F5.9)."""

_LENGTH_GUIDANCE = {
    "short": "SHORT: exactly 2 body paragraphs (plus greeting/closing), under 150 words total for the body. Be concise — one or two sentences per point, not a full paragraph of justification.",
    "medium": "MEDIUM: 2-3 body paragraphs, roughly 200-300 words total for the body.",
    "long": "LONG: 3-4 body paragraphs, roughly 350-450 words total for the body.",
}

_TONE_GUIDANCE = {
    "neutral": "Professional and straightforward.",
    "formal": "Formal, traditional business-letter tone.",
    "very_formal": "Highly formal and traditional — no contractions, no casual phrasing, measured and reserved throughout.",
    "warm": "Warm and personable while staying professional — conversational, not stiff.",
}


def run_cover_letter_generation(
    model: BaseChatModel,
    *,
    jobs: list[Job],
    profile: Profile,
    persona_name: str,
    evidence_items: list[EvidenceItem],
    preference: Preference | None = None,
    tone: str = "neutral",
    length: str = "medium",
    prior_violations: list[str] | None = None,
) -> CoverLetterOutput:
    structured = model.bind(max_tokens=8000).with_structured_output(CoverLetterOutput)
    length_guidance = _LENGTH_GUIDANCE.get(length, _LENGTH_GUIDANCE["medium"])
    tone_guidance = _TONE_GUIDANCE.get(tone, _TONE_GUIDANCE["neutral"])
    prompt = (
        f"REQUESTED LENGTH: {length_guidance}\n"
        f"REQUESTED TONE: {tone_guidance}\n\n"
        f"CANDIDATE:\n{profile_summary(profile, persona_name, preference)}\n\n"
        f"CANDIDATE'S FULL EVIDENCE BANK (cite evidence_id exactly as shown):\n{evidence_bank_summary(evidence_items)}\n\n"
        f"JOB GROUP ({len(jobs)} posting(s) this letter must serve):\n{job_group_summary(jobs)}"
    )
    if prior_violations:
        violations_text = "\n".join(f"- {v}" for v in prior_violations)
        prompt += (
            "\n\nYOUR PREVIOUS ATTEMPT WAS REJECTED BY THE CLAIM VERIFIER. Fix these specific "
            f"violations — do not repeat them, and do not introduce new ones:\n{violations_text}"
        )
    result = invoke_structured_with_retry(structured, [("system", _COVER_LETTER_SYSTEM_PROMPT), ("user", prompt)])
    if not isinstance(result, CoverLetterOutput):
        raise RuntimeError(f"cover letter structured output call returned unexpected type: {type(result)}")
    return result


def validate_cover_letter_evidence(output: CoverLetterOutput, evidence_items: list[EvidenceItem]) -> CoverLetterOutput:
    real_ids = {item.id for item in evidence_items}
    paragraphs = [
        CoverLetterParagraph(evidence_ids=[eid for eid in p.evidence_ids if eid in real_ids], text=p.text)
        for p in output.paragraphs
    ]
    return CoverLetterOutput(greeting=output.greeting, paragraphs=paragraphs, closing=output.closing)


def cover_letter_claims_text(output: CoverLetterOutput) -> str:
    """Only the paragraphs are factual claims — greeting/closing are
    boilerplate and never sent to the verifier."""

    lines = []
    for p in output.paragraphs:
        if not p.evidence_ids:
            continue  # nothing factual to check
        ids = ", ".join(str(i) for i in p.evidence_ids)
        lines.append(f"[paragraph, cites evidence_id(s)={ids}] {p.text}")
    return "\n".join(lines)
