"""General, non-job-specific CV quality analysis — feedback on the
candidate's current evidence bank/profile as a whole, not tailored
toward any particular job group. Raised directly by Adrian: after
uploading a CV, the Dashboard should be able to show real analysis and
feedback, surfaced on the Composer's Base CV page.

Distinct from scoring_engine.py's FitScore (job-specific fit against
one real posting — a completely different question, "does this match
THAT job") and from tailoring_engine.py (which selects/rewords a
subset of evidence for a specific job group, producing a Document) —
this produces neither a fit score nor a document, just a structured
self-assessment of the evidence bank as it stands, persisted onto
Profile.cv_score/cv_scored_at (cv_review_service.py), recomputed on
demand rather than a live/derived value.

Deliberately free (no FeatureCreditCost row, confirmed directly with
Adrian) — grouped with CV parsing as "on the house": both are about
getting a usable profile in place, not a paid generation feature."""

from __future__ import annotations

from langchain_core.language_models.chat_models import BaseChatModel
from pydantic import BaseModel, Field

from applicient_api.llm_retry import invoke_structured_with_retry


class CvScoreCategory(BaseModel):
    category: str = Field(
        description=(
            "One of: 'Impact & Quantification', 'Clarity & Structure', 'Completeness', "
            "'ATS-Friendliness'."
        )
    )
    score: float = Field(ge=0, le=100)
    feedback: str = Field(description="1-3 sentences, specific to what's actually in THIS evidence bank — never generic advice.")


class CvScoreOutput(BaseModel):
    overall_score: float = Field(ge=0, le=100)
    summary: str = Field(description="A short (2-4 sentence) overall assessment, grounded in real entries.")
    strengths: list[str] = Field(description="Concrete things this CV does well, each citing a real entry/employer/skill.")
    improvements: list[str] = Field(
        description="Concrete, actionable suggestions — reference specific weak entries where relevant, not generic tips."
    )
    categories: list[CvScoreCategory]


_SYSTEM_PROMPT = """You are an expert CV/resume reviewer giving honest, specific, actionable feedback on a candidate's evidence bank — the raw material their CV is built from, not a CV tailored to any particular job.

Every score (overall_score and each category's own score) is on a 0-100 scale, NOT 0-10 — a genuinely strong, well-quantified CV should land roughly 70-90; an average one with real gaps 40-60; a weak one with almost no quantified impact 10-30. Do not compress your scores into a 0-10 range.

Score across exactly these four categories:
- Impact & Quantification: are accomplishments backed by real numbers/metrics, not just responsibilities listed?
- Clarity & Structure: are entries clear, well-scoped, standalone, non-redundant with each other?
- Completeness: are there real gaps — missing dates, thin sections, no skills captured, an experience with only vague description?
- ATS-Friendliness: are skills/tools named explicitly and consistently (not just implied by context), in a form an applicant tracking system would actually parse and match on?

Rules:
- Base every point of feedback on what's ACTUALLY in the evidence bank given to you — cite real entries/employers/skills. Never give generic advice that could apply to any candidate.
- Be honest, not just encouraging — if a whole category is weak (e.g. zero quantified impact anywhere, a thin skills list, vague titles), say so plainly and describe what a strong version would look like.
- `improvements` must be concrete and actionable, not vague. Weak: "quantify your impact." Strong: "the Data Scientist role at Bank Mega has 5 accomplishments with zero numbers attached — add real metrics like accuracy %, users served, or time saved."
- Never fabricate a fact about the candidate that isn't in the evidence bank — pointing out what's MISSING is fine; inventing what they supposedly did is not."""


def run_cv_score(model: BaseChatModel, *, profile_summary: str, evidence_bank_summary: str) -> CvScoreOutput:
    # method="function_calling" — same fix cv_parsing.py's own
    # parse_cv_text documents in detail: the default (strict
    # json_schema) structured-output path makes the deployed model
    # reason more heavily before answering. Live-confirmed to help
    # here too (77s -> 41s on the same real evidence bank), though the
    # gain is smaller than CV parsing's — synthesizing feedback across
    # a whole evidence bank plausibly benefits from some real
    # reasoning, unlike parsing's pure overhead.
    structured = model.with_structured_output(CvScoreOutput, method="function_calling")
    prompt = f"CANDIDATE:\n{profile_summary}\n\nEVIDENCE BANK:\n{evidence_bank_summary}"
    result = invoke_structured_with_retry(structured, [("system", _SYSTEM_PROMPT), ("user", prompt)])
    if not isinstance(result, CvScoreOutput):
        raise RuntimeError(f"cv score structured output call returned unexpected type: {type(result)}")
    return result
