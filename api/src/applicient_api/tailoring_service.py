"""M3 §2 — wires tailoring_engine.py's pure LLM logic to persistence.
Mirrors scoring_service.py: opens and owns its own session via
session_factory, takes IDs not live ORM objects, safe to call from
asyncio.to_thread.

Claim verification (M3 §4) is not wired in yet — every Document this
produces is persisted with verified=False, same as it would be before
a first verifier pass ever ran. Rendering (M3 §3) is also separate;
this function's job ends at a persisted, unrendered JSON delta.
"""

from __future__ import annotations

import uuid

from sqlalchemy import func
from sqlalchemy.orm import sessionmaker

from applicient_api.models.discovery import Job
from applicient_api.models.documents import Document, JobGroup, JobGroupMember
from applicient_api.models.enums import DocumentType
from applicient_api.models.profile import Persona, Preference, Profile
from applicient_api.tailoring_engine import (
    TailoringOutput,
    retrieve_full_evidence_bank,
    run_tailoring,
    validate_tailoring_evidence,
)
from applicient_api.tier_resolution import resolve_tier


class TailoringError(Exception):
    pass


def tailor_job_group(
    session_factory: sessionmaker,
    *,
    job_group_id: uuid.UUID,
    user_id: uuid.UUID,
    agent_run_id: uuid.UUID | None = None,
) -> Document:
    with session_factory() as db:
        group = db.get(JobGroup, job_group_id)
        if group is None or group.user_id != user_id:
            raise TailoringError(f"job group {job_group_id} not found")

        persona = db.get(Persona, group.persona_id)
        profile = db.get(Profile, persona.profile_id)
        preference = db.query(Preference).filter_by(persona_id=persona.id).one_or_none()

        member_job_ids = [
            m.job_id for m in db.query(JobGroupMember).filter_by(job_group_id=group.id).all()
        ]
        jobs = db.query(Job).filter(Job.id.in_(member_job_ids)).all() if member_job_ids else []
        if not jobs and not group.target_role_title:
            raise TailoringError(
                f"job group {job_group_id} has no member jobs and no target role to tailor for"
            )

        evidence_items = retrieve_full_evidence_bank(db, profile_id=profile.id)
        if not evidence_items:
            raise TailoringError(f"profile {profile.id} has no evidence items to tailor from")

        deep_model = resolve_tier(
            db,
            user_id=user_id,
            tier="deep",
            stage="tailoring",
            agent_run_id=agent_run_id,
            session_factory=session_factory,
        )
        output = run_tailoring(
            deep_model,
            jobs=jobs,
            profile=profile,
            persona_name=persona.name,
            evidence_items=evidence_items,
            preference=preference,
            target_role_title=group.target_role_title,
            target_company=group.target_company,
        )
        validated = validate_tailoring_evidence(output, evidence_items)

        latest_version = (
            db.query(func.max(Document.version))
            .filter_by(job_group_id=group.id, persona_id=persona.id, doc_type=DocumentType.CV.value)
            .scalar()
            or 0
        )

        document = Document(
            user_id=user_id,
            job_group_id=group.id,
            persona_id=persona.id,
            profile_revision=profile.revision,
            doc_type=DocumentType.CV.value,
            version=latest_version + 1,
            json_delta=validated.model_dump(mode="json"),
            template=persona.base_cv_template,
            verified=False,
        )
        db.add(document)
        db.commit()
        db.refresh(document)
        return document


def save_document_delta(
    session_factory: sessionmaker, *, document_id: uuid.UUID, user_id: uuid.UUID, delta: TailoringOutput
) -> Document:
    """A hand edit to the structured delta itself — add/remove a whole
    section (an "experience card"), add/remove/reword a bullet, edit
    the summary — as opposed to `rendering_service.py`'s raw-.tex
    override, which edits the compiled output directly. Raised by
    Adrian: he wants a structured, per-section editing surface, not
    only a raw-source one.

    Still validated against the real evidence bank before saving (a
    client-supplied evidence_id is never trusted blindly, same
    discipline as the AI path), and — because the content just
    changed — `verified` is reset to False: whatever the claim
    verifier said about the PREVIOUS content no longer describes what
    is about to be saved. Re-verifying afterward is cheap (the
    dedicated "Re-verify" action), so this doesn't silently let an
    edited claim ride on a stale verified flag."""

    with session_factory() as db:
        document = db.query(Document).filter_by(id=document_id, user_id=user_id).one_or_none()
        if document is None:
            raise TailoringError(f"document {document_id} not found")

        persona = db.get(Persona, document.persona_id)
        profile = db.get(Profile, persona.profile_id)
        evidence_items = retrieve_full_evidence_bank(db, profile_id=profile.id)

        validated = validate_tailoring_evidence(delta, evidence_items)
        document.json_delta = validated.model_dump(mode="json")
        document.verified = False
        db.commit()
        db.refresh(document)
        return document
