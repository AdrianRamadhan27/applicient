"""M1 §5 — two-stage fit scoring: a cheap `fast`-tier prefilter, then
a full `balanced`-tier rubric for whatever survives it. Persisted as
append-only history (`PrefilterResult`/`FitScore`, both already
UNIQUE-free by design — a rescore after a profile/persona change adds
a new row, never overwrites the old one, per both models' own
docstrings).

Retrieval for the full rubric is real, not "paste the whole evidence
bank into the prompt": `retrieve_relevant_evidence` uses pgvector
cosine distance between the job's `description_embedding` and every
`EvidenceItem.embedding` for the profile, both produced by the same
`embedding` tier (same `EMBED_DIM=2048` halfvec column on both sides,
confirmed by reading both models before assuming they're comparable) —
so the balanced-tier call sees the candidate's most relevant
accomplishments for THIS job, not everything they've ever done.

`evidence_spans` in the rubric output are quotes from the JOB
POSTING'S OWN TEXT (requirements/responsibilities/benefits), not from
the candidate's evidence bank — M1 §5's checklist item is explicit
about this ("validate every evidence span against the stored job
text"), and `validate_evidence_spans` below enforces it structurally:
a span the model claims but that doesn't actually appear verbatim in
the job's stored text is dropped, not trusted, since a hallucinated
quote asserting a requirement that isn't really there would be worse
than an incomplete evidence list.

Hard blockers (F4.5) are inferred from `Profile.visa_status` against
whatever the job text itself states about authorization/location,
not from a dedicated "excluded locations"/"required certifications"
config list — no such field exists on Persona/Profile yet, and adding
one wasn't asked for here; noted as a real scope limit rather than
silently assumed comprehensive.
"""

from __future__ import annotations

import uuid
from typing import Literal

from langchain_core.language_models.chat_models import BaseChatModel
from pydantic import BaseModel, Field
from sqlalchemy import func
from sqlalchemy.orm import Session

from applicient_api.models.discovery import Job
from applicient_api.models.profile import EvidenceItem, Profile

# --- Structured LLM output contracts ---


class PrefilterOutput(BaseModel):
    decision: Literal["keep", "drop", "review"] = Field(
        description="keep: clearly worth the full rubric pass. drop: clearly not a fit "
        "(wrong role/seniority/hard-excluded location, etc). review: genuinely ambiguous, "
        "let the full rubric decide rather than guessing here."
    )
    reason: str = Field(description="One sentence explaining the decision — this is kept forever, even for drops.")


class EvidenceSpan(BaseModel):
    quote: str = Field(description="An exact, verbatim substring copied from the job's own posting text.")
    supports: str = Field(description="What this quote is evidence for, e.g. 'seniority requirement' or 'required skill: Kubernetes'.")


class FitRubricOutput(BaseModel):
    recommendation: Literal["strong_apply", "apply", "stretch", "skip"]
    overall_score: float = Field(ge=0, le=100)

    hard_requirements_met: int = Field(ge=0)
    hard_requirements_total: int = Field(ge=0)
    hard_blocker: str | None = Field(
        default=None,
        description="Name the specific blocker if authorization/certification/excluded-location makes this "
        "job unworkable regardless of fit — e.g. 'requires US work authorization without sponsorship'. "
        "Forces recommendation=skip when set. Omit this field (leave it null) when there is no blocker — "
        "do NOT write 'no', 'none', 'n/a', or any other placeholder answer; those are treated as a real "
        "blocker being present, exactly like an actual description would be.",
    )

    experience_delta_years: float | None = Field(
        default=None,
        description="Candidate's relevant years minus the job's stated requirement. Positive = exceeds, "
        "negative = short. Null if the job states no experience requirement.",
    )
    skills_matched: list[str] = Field(default_factory=list)
    skills_partial: list[str] = Field(default_factory=list, description="Adjacent/transferable but not exact matches.")
    skills_missing: list[str] = Field(default_factory=list, description="Required/preferred skills the candidate's evidence never shows.")

    seniority_fit: Literal["below", "match", "above"] | None = None
    domain_fit: Literal["match", "partial", "mismatch"] | None = None
    location_fit: Literal["match", "partial", "mismatch", "blocked"] | None = None
    salary_overlap: Literal["above", "within", "below", "unknown"] = Field(
        description="MUST be 'unknown' if the job's salary is not stated — never guess a comparison against an unstated number."
    )
    company_stage_fit: Literal["match", "partial", "mismatch", "unknown"] | None = None
    language_fit: Literal["match", "partial", "mismatch", "unknown"] | None = None

    evidence_spans: list[EvidenceSpan] = Field(default_factory=list)
    gap_closers: str | None = Field(default=None, description="One short, concrete note on what would close the biggest gap, if any.")
    red_flags: list[str] = Field(default_factory=list, description="Concerns independent of fit — e.g. vague responsibilities, unrealistic scope for the stated level.")


_PREFILTER_SYSTEM_PROMPT = """You are the cheap first pass of a two-stage job-fit filter. Given a candidate's profile summary and a job posting, decide fast: keep (send to the expensive full rubric), drop (clearly not worth it), or review (genuinely ambiguous — let the full pass decide).

Be decisive about clear cases (obviously wrong seniority, obviously unrelated domain, obviously excluded by location/authorization) but do not drop anything merely uncertain — false negatives here are permanent, the job never gets a second look. When in doubt, keep or review, don't drop."""

_RUBRIC_SYSTEM_PROMPT = """You are scoring how well a candidate fits one specific job posting, using only the candidate data given to you and the job's own posting text. Never invent a fact about the candidate or the job that isn't stated.

Every evidence_spans quote must be copied VERBATIM from the job posting text you were given — not paraphrased, not from the candidate's side. If you cannot find an exact quote supporting something, don't include that span.

Salary: if the job's salary is not stated, salary_overlap MUST be "unknown" — never estimate or compare against a number the posting doesn't give.

Hard blockers: only set hard_blocker when the job text or the candidate's stated visa/authorization status makes this job genuinely unworkable regardless of skill fit (e.g. job requires authorization the candidate's profile says they don't have, with no stated sponsorship). A hard blocker forces recommendation=skip. Do not invent a blocker from mere uncertainty. When there is no blocker, leave the field null/omitted — do not answer it with "no", "none", "n/a", or any other word, since any non-empty text there is treated as a real blocker being present.

Experience gaps are a ranking penalty, not a blocker — a candidate short on stated years can still be "apply" or "stretch", never automatically "skip" for that reason alone."""


def _job_text(job: Job) -> str:
    parts = [job.requirements, job.responsibilities, job.benefits]
    return "\n\n".join(p for p in parts if p)


def _job_summary(job: Job) -> str:
    lines = [
        f"Title: {job.title}",
        f"Company: {job.company_name_raw}",
        f"Location: {job.location or 'not stated'}",
        f"Remote policy: {job.remote_policy or 'not stated'}",
        f"Seniority: {job.seniority or 'not stated'}",
        f"Employment type: {job.employment_type or 'not stated'}",
    ]
    if job.salary_min or job.salary_max:
        lines.append(f"Salary: {job.salary_min or '?'}-{job.salary_max or '?'} {job.salary_currency or ''}")
    else:
        lines.append("Salary: not stated")
    text = _job_text(job)
    if text:
        lines.append(f"\nPosting text:\n{text}")
    return "\n".join(lines)


def _profile_summary(profile: Profile, persona_name: str) -> str:
    p = profile.parsed_profile or {}
    lines = [
        f"Persona/target track: {persona_name}",
        f"Headline: {p.get('headline') or 'not stated'}",
        f"Location: {p.get('location') or 'not stated'}",
        f"Summary: {p.get('summary') or 'not stated'}",
        f"Skills: {', '.join(p.get('skills') or []) or 'not stated'}",
        f"Visa/work-authorization status: {profile.visa_status or 'not stated'}",
        f"Notice period (days): {profile.notice_period_days if profile.notice_period_days is not None else 'not stated'}",
    ]
    return "\n".join(lines)


def retrieve_relevant_evidence(session: Session, *, profile_id: uuid.UUID, job: Job, top_k: int = 8) -> list[EvidenceItem]:
    """Nearest evidence items to this job's description by cosine
    distance — both sides embedded by the same `embedding` tier. Jobs
    or evidence without an embedding yet just get an empty/unranked
    result rather than an error; scoring degrades gracefully to the
    profile summary alone in that case (F4's own tolerance for
    partial data, not a hard dependency)."""

    if job.description_embedding is None:
        return []
    return (
        session.query(EvidenceItem)
        .filter(EvidenceItem.profile_id == profile_id, EvidenceItem.embedding.isnot(None))
        .order_by(EvidenceItem.embedding.cosine_distance(job.description_embedding))
        .limit(top_k)
        .all()
    )


def _evidence_summary(items: list[EvidenceItem]) -> str:
    if not items:
        return "(no embedded evidence retrieved)"
    lines = []
    for item in items:
        header = " — ".join(p for p in [item.title, item.employer] if p)
        skills = f" [{', '.join(item.skills)}]" if item.skills else ""
        lines.append(f"- {header}: {item.text}{skills}")
    return "\n".join(lines)


def run_prefilter(model: BaseChatModel, *, job: Job, profile: Profile, persona_name: str) -> PrefilterOutput:
    structured = model.with_structured_output(PrefilterOutput)
    result = structured.invoke(
        [
            ("system", _PREFILTER_SYSTEM_PROMPT),
            ("user", f"CANDIDATE:\n{_profile_summary(profile, persona_name)}\n\nJOB:\n{_job_summary(job)}"),
        ]
    )
    if not isinstance(result, PrefilterOutput):
        raise RuntimeError(f"prefilter structured output call returned unexpected type: {type(result)}")
    return result


def run_fit_rubric(
    model: BaseChatModel, *, job: Job, profile: Profile, persona_name: str, evidence_items: list[EvidenceItem]
) -> FitRubricOutput:
    structured = model.with_structured_output(FitRubricOutput)
    prompt = (
        f"CANDIDATE:\n{_profile_summary(profile, persona_name)}\n\n"
        f"CANDIDATE'S MOST RELEVANT EVIDENCE FOR THIS JOB:\n{_evidence_summary(evidence_items)}\n\n"
        f"JOB:\n{_job_summary(job)}"
    )
    result = structured.invoke([("system", _RUBRIC_SYSTEM_PROMPT), ("user", prompt)])
    if not isinstance(result, FitRubricOutput):
        raise RuntimeError(f"fit rubric structured output call returned unexpected type: {type(result)}")
    return result


_HARD_BLOCKER_NEGATIVE_ANSWERS = {"no", "none", "n/a", "na", "false", "nil", "null"}


def normalize_hard_blocker(raw: str | None) -> str | None:
    """The field description alone doesn't reliably stop the model
    from "answering" the yes/no-shaped `hard_blocker` field with the
    word "no" (or "none"/"false"/a full "No — visa isn't stated..."
    sentence) instead of actually leaving it null — confirmed live: 20
    of 23 real non-null `hard_blocker` values were exactly this,
    including one on an 80/100-fit job that got silently forced to
    `recommendation=skip` over a literal "no". `if rubric.hard_blocker`
    treats any non-empty string as a real blocker, so this is applied
    before that check (and before persistence) rather than trusting
    the raw field value, same "don't trust prompt wording alone"
    discipline as query_expansion.py's query-count cap and
    cv_parsing.py's date formatting."""

    if raw is None:
        return None
    cleaned = raw.strip()
    if not cleaned:
        return None
    first_word = cleaned.split(maxsplit=1)[0].strip(".,:;\"'").lower()
    if first_word in _HARD_BLOCKER_NEGATIVE_ANSWERS:
        return None
    return cleaned


def validate_evidence_spans(spans: list[EvidenceSpan], job: Job) -> list[EvidenceSpan]:
    """Drops any span whose quote doesn't actually appear verbatim in
    the job's own stored text — a model claiming a quote that isn't
    really there is a hallucination, not evidence, and gets removed
    rather than trusted (M1 §5: "validate every evidence span against
    the stored job text")."""

    text = _job_text(job)
    return [span for span in spans if span.quote and span.quote in text]
