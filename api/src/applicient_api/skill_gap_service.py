"""M3 §5/F5.13 — the skill-gap checklist. No LLM call: every member
job's latest FitScore already names its skills_missing (F4's existing
rubric output, paid for once at scoring time); the gap is just the
deduplicated union of that across the group.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import func
from sqlalchemy.orm import Session, sessionmaker

from applicient_api.embedding_service import embed_evidence_items
from applicient_api.models.discovery import Job
from applicient_api.models.documents import JobGroup, JobGroupMember, SkillGapItem
from applicient_api.models.enums import EvidenceCategory
from applicient_api.models.profile import EvidenceItem, Persona
from applicient_api.models.scoring import FitScore
from applicient_api.skill_gap_syllabus_engine import run_syllabus_generation
from applicient_api.tier_resolution import TierResolutionError, resolve_embedding_tier, resolve_tier


class SkillGapError(Exception):
    pass


def sync_skill_gap_items(db: Session, *, group: JobGroup) -> list[SkillGapItem]:
    """Creates a pending row for any newly-seen missing skill, and —
    raised by Adrian after removing a job left its skills stuck on the
    checklist forever — deletes the tracking row for any skill no
    member job asks for any more (whether it was pending or already
    `done`). This only removes the `SkillGapItem` row; a `done` item's
    linked `EvidenceItem` is never touched here, since self-attested
    evidence is a real fact about the candidate now, independent of
    which jobs happen to still be in this particular group."""

    member_job_ids = [m.job_id for m in db.query(JobGroupMember).filter_by(job_group_id=group.id).all()]

    missing_skills: set[str] = set()
    for job_id in member_job_ids:
        latest = (
            db.query(FitScore)
            .filter_by(job_id=job_id, persona_id=group.persona_id)
            .order_by(FitScore.created_at.desc())
            .first()
        )
        if latest:
            missing_skills.update(s.strip() for s in latest.skills_missing if s and s.strip())

    existing = db.query(SkillGapItem).filter_by(job_group_id=group.id).all()
    existing_texts = {item.skill_text for item in existing}

    changed = False
    for skill in missing_skills - existing_texts:
        db.add(SkillGapItem(job_group_id=group.id, skill_text=skill))
        changed = True

    for item in existing:
        if item.skill_text not in missing_skills:
            db.delete(item)
            changed = True

    if changed:
        db.commit()

    return db.query(SkillGapItem).filter_by(job_group_id=group.id).order_by(SkillGapItem.skill_text).all()


def complete_skill_gap_item(
    db: Session,
    *,
    group: JobGroup,
    item_id: uuid.UUID,
    user_id: uuid.UUID,
    session_factory: sessionmaker | None = None,
) -> SkillGapItem:
    item = db.query(SkillGapItem).filter_by(id=item_id, job_group_id=group.id).one_or_none()
    if item is None:
        raise SkillGapError(f"skill gap item {item_id} not found in group {group.id}")
    if item.status == "done":
        return item

    persona = db.get(Persona, group.persona_id)
    evidence = EvidenceItem(
        user_id=user_id,
        profile_id=persona.profile_id,
        category=EvidenceCategory.SKILL.value,
        text=f"Self-attested: learned/acquired {item.skill_text}.",
        skills=[item.skill_text],
        verified=True,
    )
    db.add(evidence)
    db.flush()

    # A real, previously-stated gap: without this, a self-attested
    # skill was usable by tailoring (retrieve_full_evidence_bank
    # doesn't filter on embedding) but invisible to scoring's top-k
    # cosine retrieval (retrieve_relevant_evidence). Best-effort — an
    # unconfigured/unreachable embedding tier shouldn't block the
    # checkbox itself succeeding, same tolerance cv.py already has for
    # a missing tier.
    if session_factory is not None:
        try:
            embeddings_client, provider = resolve_embedding_tier(db, user_id=user_id)
            embed_evidence_items(
                db,
                embeddings_client,
                [evidence],
                user_id=user_id,
                session_factory=session_factory,
                provider=provider,
                stage="skill-gap-checklist",
            )
        except TierResolutionError:
            pass

    item.status = "done"
    item.evidence_item_id = evidence.id
    db.commit()
    db.refresh(item)
    return item


def reopen_skill_gap_item(db: Session, *, group: JobGroup, item_id: uuid.UUID) -> SkillGapItem:
    """Unchecking is a full undo, not just flipping the status back —
    it also deletes the self-attested EvidenceItem `complete_skill_gap_item`
    created. Resetting status alone while leaving `evidence_item_id` set
    would let a later re-check hit the "already done" no-op instead of
    creating a fresh evidence row, and leaving the flag cleared but the
    stale id around would point at a row this checklist no longer
    considers current. Deleting it outright keeps checked ⇔ evidence-exists
    a real invariant instead of two states that can drift apart."""

    item = db.query(SkillGapItem).filter_by(id=item_id, job_group_id=group.id).one_or_none()
    if item is None:
        raise SkillGapError(f"skill gap item {item_id} not found in group {group.id}")
    if item.status == "pending":
        return item

    if item.evidence_item_id is not None:
        evidence = db.get(EvidenceItem, item.evidence_item_id)
        if evidence is not None:
            db.delete(evidence)

    item.status = "pending"
    item.evidence_item_id = None
    db.commit()
    db.refresh(item)
    return item


def generate_syllabus(
    db: Session,
    *,
    group: JobGroup,
    item_id: uuid.UUID,
    user_id: uuid.UUID,
    session_factory: sessionmaker,
    agent_run_id: uuid.UUID | None = None,
) -> SkillGapItem:
    """Phase 10 (v2 plan) — a short reference-links + project-ideas
    plan for one gap, generated fresh each call (overwrites any prior
    syllabus rather than versioning it — see the model's own comment
    for why). `job_context` grounds the recommendation in the actual
    roles this skill was flagged against, not just the bare skill name
    in isolation."""

    item = db.query(SkillGapItem).filter_by(id=item_id, job_group_id=group.id).one_or_none()
    if item is None:
        raise SkillGapError(f"skill gap item {item_id} not found in group {group.id}")

    member_job_ids = [m.job_id for m in db.query(JobGroupMember).filter_by(job_group_id=group.id).all()]
    jobs = db.query(Job).filter(Job.id.in_(member_job_ids)).all() if member_job_ids else []
    job_context = "\n".join(f"- {j.title} at {j.company_name_raw}" for j in jobs) or "(no job context available)"

    model = resolve_tier(
        db, user_id=user_id, tier="balanced", stage="skill-gap-syllabus",
        agent_run_id=agent_run_id, session_factory=session_factory,
    )
    output = run_syllabus_generation(model, skill_text=item.skill_text, job_context=job_context)

    item.syllabus = output.model_dump(mode="json")
    db.commit()
    db.refresh(item)
    return item
