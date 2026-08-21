"""M3 §2/F5.1 — CV delta generation ("tailoring-agent").

Mirrors scoring_engine.py's shape (structured LLM output, a pure
validation helper, no persistence here — that's tailoring_service.py).
Two real differences from scoring:

1. Retrieval is the FULL evidence bank, not scoring's top-k-8 nearest
   neighbors (`retrieve_relevant_evidence`) — F5.1 needs every
   accomplishment available for selection, not a job-specific subset,
   and the model itself decides what to include/omit per group.

2. The target is a JobGroup (F5.10) — one or more jobs a single CV is
   meant to serve — not one job. The model tailors toward the whole
   set at once (common threads across the group), never producing a
   separate delta per member job.

The model never emits layout (F5.1) — only which evidence to include,
in what order, and how to phrase it. Every bullet/section must cite a
real EvidenceItem id; `validate_tailoring_evidence` below drops
anything that doesn't, the same "don't trust a hallucinated reference"
discipline as `validate_evidence_spans`.
"""

from __future__ import annotations

import uuid

from langchain_core.language_models.chat_models import BaseChatModel
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from applicient_api.llm_retry import invoke_structured_with_retry
from applicient_api.models.discovery import Job
from applicient_api.models.profile import EvidenceItem, Preference, Profile

# --- Structured LLM output contracts ---


class TailoredBullet(BaseModel):
    evidence_id: uuid.UUID = Field(description="The EvidenceItem this bullet is derived from — must be a real id from the evidence bank given to you.")
    text: str = Field(description="Rephrased/reweighted bullet text. Must not state anything the cited evidence item doesn't support — no new numbers, skills, or claims.")


class TailoredSection(BaseModel):
    evidence_id: uuid.UUID = Field(description="The EvidenceItem this section/entry represents (e.g. one job, one degree, one project) — a real id from the evidence bank.")
    bullets: list[TailoredBullet] = Field(default_factory=list)


class TailoringOutput(BaseModel):
    summary: str = Field(description="A tailored 2-4 sentence professional summary reflecting what this group of jobs has in common. Must be grounded in the candidate's real profile/evidence, not aspirational.")
    sections: list[TailoredSection] = Field(description="Selected evidence entries, in the order they should appear on the CV. Omit evidence irrelevant to every job in the group.")
    skills_highlight: list[str] = Field(default_factory=list, description="Skills to foreground in the Skills section — drawn only from the evidence bank's own `skills` fields, never invented.")
    rationale: str = Field(description="One paragraph explaining the tailoring choices made for this group, for the Composer's diff view.")


_TAILORING_SYSTEM_PROMPT = """You are tailoring a candidate's CV as a structured JSON delta against their master evidence bank, for a group of one or more job postings that a single CV must serve. When the group has more than one posting, tailor toward what they have IN COMMON — never produce content that only fits one posting at the expense of the others in the same group.

Rules:
- Select, reorder, and reweight from the evidence bank given to you. Never invent an accomplishment, employer, title, date, metric, or skill that isn't in the evidence bank.
- Every section you include MUST have at least one bullet, and every bullet must cite the evidence_id of the real evidence item it's derived from (a bullet may draw from a different item than its section's main evidence_id only when synthesizing something both items genuinely support together). A section with zero bullets is useless and will be discarded — if an evidence item doesn't warrant at least one real bullet, leave it out of `sections` entirely rather than including it empty.
- Rephrasing/reweighting is allowed (emphasize what these jobs value, reorder for relevance, tighten wording) — inventing new facts is not.
- Include enough sections and bullets to produce a real, substantive CV — do not leave `sections` sparse or empty when the evidence bank has relevant material to draw from.
- Never alter or imply a different date, employer, title, or degree classification than the evidence bank states (F5.9).
- Never generate claims about protected characteristics (F5.9)."""


def job_group_summary(jobs: list[Job]) -> str:
    blocks = []
    for job in jobs:
        parts = [
            f"Title: {job.title}",
            f"Company: {job.company_name_raw}",
            f"Seniority: {job.seniority or 'not stated'}",
        ]
        text = "\n\n".join(p for p in [job.requirements, job.responsibilities] if p)
        if text:
            parts.append(f"Requirements/responsibilities:\n{text}")
        blocks.append("\n".join(parts))
    return "\n\n---\n\n".join(blocks)


def profile_summary(profile: Profile, persona_name: str, preference: Preference | None = None) -> str:
    p = profile.parsed_profile or {}
    lines = [
        f"Persona/target track: {persona_name}",
        f"Headline: {p.get('headline') or 'not stated'}",
        f"Location: {p.get('location') or 'not stated'}",
        f"Summary: {p.get('summary') or 'not stated'}",
    ]
    if preference is not None and preference.target_roles:
        lines.append(f"Target roles: {', '.join(preference.target_roles)}")
    return "\n".join(lines)


def retrieve_full_evidence_bank(session: Session, *, profile_id: uuid.UUID) -> list[EvidenceItem]:
    """Every evidence item for this profile, not scoring's top-k
    subset — F5.1's tailoring-agent needs the whole bank available to
    choose from. Ordered by category then most-recent-first, a
    deterministic and human-sensible default reading order."""

    return (
        session.query(EvidenceItem)
        .filter(EvidenceItem.profile_id == profile_id)
        .order_by(EvidenceItem.category, EvidenceItem.date_start.desc().nullslast())
        .all()
    )


def evidence_bank_summary(items: list[EvidenceItem]) -> str:
    if not items:
        return "(no evidence items in this profile's bank)"
    lines = []
    for item in items:
        header = " — ".join(p for p in [item.title, item.employer] if p)
        skills = f" [skills: {', '.join(item.skills)}]" if item.skills else ""
        dates = ""
        if item.date_start or item.date_end:
            dates = f" ({item.date_start or '?'} to {item.date_end or 'present'})"
        lines.append(f"- [evidence_id={item.id}] ({item.category}) {header}{dates}: {item.text}{skills}")
    return "\n".join(lines)


def run_tailoring(
    model: BaseChatModel,
    *,
    jobs: list[Job],
    profile: Profile,
    persona_name: str,
    evidence_items: list[EvidenceItem],
    preference: Preference | None = None,
    prior_violations: list[str] | None = None,
) -> TailoringOutput:
    # A full tailored CV (several sections, several bullets each, plus
    # a rationale paragraph) is long enough to exceed a provider's
    # default max output tokens — confirmed live: a real run truncated
    # mid-JSON ("EOF while parsing a value") on the exact bullet-heavy
    # shape this call produces, not a flaky-model issue (this is
    # DeepSeek V4 Pro, the paid deep tier, not the free fast tier).
    # Bound here, not in tier_resolution.py, since this call's output
    # is unusually long compared to scoring/prefilter's — not a change
    # every tier-resolved call should inherit.
    structured = model.bind(max_tokens=8000).with_structured_output(TailoringOutput)
    prompt = (
        f"CANDIDATE:\n{profile_summary(profile, persona_name, preference)}\n\n"
        f"CANDIDATE'S FULL EVIDENCE BANK (cite evidence_id exactly as shown):\n{evidence_bank_summary(evidence_items)}\n\n"
        f"JOB GROUP ({len(jobs)} posting(s) this CV must serve):\n{job_group_summary(jobs)}"
    )
    if prior_violations:
        # F5.5 — regeneration attempt 2, the adversarial verifier's
        # specific findings fed back verbatim rather than a generic
        # "try again": every one of these was independently judged
        # against the evidence bank alone, without seeing the job(s),
        # so they're a real, specific correction, not a hint.
        violations_text = "\n".join(f"- {v}" for v in prior_violations)
        prompt += (
            "\n\nYOUR PREVIOUS ATTEMPT WAS REJECTED BY THE CLAIM VERIFIER. Fix these specific "
            f"violations — do not repeat them, and do not introduce new ones:\n{violations_text}"
        )
    result = invoke_structured_with_retry(structured, [("system", _TAILORING_SYSTEM_PROMPT), ("user", prompt)])
    if not isinstance(result, TailoringOutput):
        raise RuntimeError(f"tailoring structured output call returned unexpected type: {type(result)}")
    return result


def validate_tailoring_evidence(output: TailoringOutput, evidence_items: list[EvidenceItem]) -> TailoringOutput:
    """Drops any section/bullet citing an evidence_id that doesn't
    actually exist in this profile's bank — a model naming an id that
    isn't real is a hallucination, not evidence, same discipline as
    `validate_evidence_spans` in scoring_engine.py. A section left with
    zero valid bullets after this is dropped entirely."""

    real_ids = {item.id for item in evidence_items}
    valid_sections = []
    for section in output.sections:
        if section.evidence_id not in real_ids:
            continue
        valid_bullets = [b for b in section.bullets if b.evidence_id in real_ids]
        if not valid_bullets:
            continue
        valid_sections.append(TailoredSection(evidence_id=section.evidence_id, bullets=valid_bullets))
    return TailoringOutput(
        summary=output.summary,
        sections=valid_sections,
        skills_highlight=output.skills_highlight,
        rationale=output.rationale,
    )


def tailoring_claims_text(delta: TailoringOutput) -> str:
    """The claims a CV delta makes, formatted for claim_verifier.
    run_claim_verification — the summary plus every bullet, each
    naming the evidence_id it's supposed to be derived from."""

    lines = [f"[summary] {delta.summary}"]
    for section in delta.sections:
        for bullet in section.bullets:
            lines.append(f"[bullet, cites evidence_id={bullet.evidence_id}] {bullet.text}")
    return "\n".join(lines)
