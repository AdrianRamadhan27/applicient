"""M3 §6/F5.7 — wires cover_letter_engine.py's pure LLM logic to
persistence. Mirrors tailoring_service.py's tailor_job_group exactly,
just a different doc_type/content shape — see that module for the
concurrency/session-ownership reasoning, unchanged here.
"""

from __future__ import annotations

import uuid

from sqlalchemy import func
from sqlalchemy.orm import sessionmaker

from applicient_api.cover_letter_engine import (
    run_cover_letter_generation,
    validate_cover_letter_evidence,
)
from applicient_api.models.discovery import Job
from applicient_api.models.documents import Document, JobGroup, JobGroupMember
from applicient_api.models.enums import DocumentType
from applicient_api.models.profile import Persona, Preference, Profile
from applicient_api.tailoring_engine import retrieve_full_evidence_bank
from applicient_api.tailoring_service import TailoringError
from applicient_api.tier_resolution import resolve_tier


def generate_cover_letter(
    session_factory: sessionmaker,
    *,
    job_group_id: uuid.UUID,
    user_id: uuid.UUID,
    tone: str = "neutral",
    length: str = "medium",
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
                f"job group {job_group_id} has no member jobs and no target role to write a cover letter for"
            )

        evidence_items = retrieve_full_evidence_bank(db, profile_id=profile.id)
        if not evidence_items:
            raise TailoringError(f"profile {profile.id} has no evidence items to draw from")

        deep_model = resolve_tier(
            db,
            user_id=user_id,
            tier="deep",
            stage="cover-letter",
            agent_run_id=agent_run_id,
            session_factory=session_factory,
        )
        output = run_cover_letter_generation(
            deep_model,
            jobs=jobs,
            profile=profile,
            persona_name=persona.name,
            evidence_items=evidence_items,
            preference=preference,
            tone=tone,
            length=length,
            target_role_title=group.target_role_title,
            target_company=group.target_company,
        )
        validated = validate_cover_letter_evidence(output, evidence_items)

        latest_version = (
            db.query(func.max(Document.version))
            .filter_by(job_group_id=group.id, persona_id=persona.id, doc_type=DocumentType.COVER_LETTER.value)
            .scalar()
            or 0
        )

        document = Document(
            user_id=user_id,
            job_group_id=group.id,
            persona_id=persona.id,
            profile_revision=profile.revision,
            doc_type=DocumentType.COVER_LETTER.value,
            version=latest_version + 1,
            json_delta=validated.model_dump(mode="json"),
            template=persona.base_cv_template,
            verified=False,
        )
        db.add(document)
        db.commit()
        db.refresh(document)
        return document
