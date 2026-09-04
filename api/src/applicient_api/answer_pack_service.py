"""M3 §6/F6.8 — wires answer_pack_engine.py's pure LLM logic to
persistence. Mirrors tailoring_service.py/cover_letter_service.py —
see tailoring_service.py for the concurrency/session-ownership
reasoning, unchanged here. The one real difference: this generation
step takes `questions` as an explicit input (user-supplied, pasted
from the real application — this system has no scraped screening-
question data to draw from, that's M4/F6 territory).
"""

from __future__ import annotations

import uuid

from sqlalchemy import func
from sqlalchemy.orm import sessionmaker

from applicient_api.answer_pack_engine import run_answer_pack_generation, validate_answer_pack_evidence
from applicient_api.models.discovery import Job
from applicient_api.models.documents import Document, JobGroup, JobGroupMember
from applicient_api.models.enums import DocumentType
from applicient_api.models.profile import Persona, Preference, Profile
from applicient_api.tailoring_engine import retrieve_full_evidence_bank
from applicient_api.tailoring_service import TailoringError
from applicient_api.tier_resolution import resolve_tier


def generate_answer_pack(
    session_factory: sessionmaker,
    *,
    job_group_id: uuid.UUID,
    user_id: uuid.UUID,
    questions: list[str],
    agent_run_id: uuid.UUID | None = None,
) -> Document:
    if not questions:
        raise TailoringError("at least one screening question is required")

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
                f"job group {job_group_id} has no member jobs and no target role to answer for"
            )

        evidence_items = retrieve_full_evidence_bank(db, profile_id=profile.id)
        if not evidence_items:
            raise TailoringError(f"profile {profile.id} has no evidence items to draw from")

        deep_model = resolve_tier(
            db,
            user_id=user_id,
            tier="deep",
            stage="answer-pack",
            agent_run_id=agent_run_id,
            session_factory=session_factory,
        )
        output = run_answer_pack_generation(
            deep_model,
            questions=questions,
            jobs=jobs,
            profile=profile,
            persona_name=persona.name,
            evidence_items=evidence_items,
            preference=preference,
            target_role_title=group.target_role_title,
            target_company=group.target_company,
        )
        validated = validate_answer_pack_evidence(output, evidence_items)

        latest_version = (
            db.query(func.max(Document.version))
            .filter_by(job_group_id=group.id, persona_id=persona.id, doc_type=DocumentType.ANSWER_PACK.value)
            .scalar()
            or 0
        )

        document = Document(
            user_id=user_id,
            job_group_id=group.id,
            persona_id=persona.id,
            profile_revision=profile.revision,
            doc_type=DocumentType.ANSWER_PACK.value,
            version=latest_version + 1,
            json_delta=validated.model_dump(mode="json"),
            template=persona.base_cv_template,
            verified=False,
        )
        db.add(document)
        db.commit()
        db.refresh(document)
        return document
