"""M3 §4/F5.4-F5.5 — wires claim_verifier.py's pure LLM logic to
persistence and the regeneration loop.

Split into granular steps (`run_verification_attempt`,
`regenerate_from_last_verification`) rather than one opaque
verify-then-maybe-regenerate function, so a caller — `routers/job_groups.py`'s
SSE stream — can yield a real progress event between each one instead
of the whole thing looking like a single black-box "verifying" step
that might silently take 2-4x as long as it looked like it would.

The overall flow a caller drives:
1. `run_verification_attempt(attempt_number=1)` against the
   already-tailored Document — never the job posting/group.
2. If clean, done. If not, `regenerate_from_last_verification` feeds
   the SPECIFIC violations back into one regeneration attempt (F5.5's
   hard cap is enforced by MAX_ATTEMPTS, not by this module refusing a
   3rd call — a caller simply never makes one).
3. `run_verification_attempt(attempt_number=2)` on the regenerated
   delta. `document.verified` reflects whatever this final attempt's
   outcome actually was — never silently forced true.

Both attempts' ClaimVerification rows are kept (distinguished by
attempt_number) — the full audit history survives even though only the
Document's json_delta reflects the latest attempt.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy.orm import sessionmaker

from applicient_api.answer_pack_engine import (
    AnswerPackOutput,
    answer_pack_claims_text,
    run_answer_pack_generation,
    validate_answer_pack_evidence,
)
from applicient_api.claim_verifier import all_claims_clean, run_claim_verification
from applicient_api.cover_letter_engine import (
    CoverLetterOutput,
    cover_letter_claims_text,
    run_cover_letter_generation,
    validate_cover_letter_evidence,
)
from applicient_api.models.documents import ClaimVerification, Document, JobGroup, JobGroupMember
from applicient_api.models.discovery import Job
from applicient_api.models.enums import DocumentType
from applicient_api.models.profile import Persona, Preference, Profile
from applicient_api.tailoring_engine import (
    TailoringOutput,
    retrieve_full_evidence_bank,
    run_tailoring,
    tailoring_claims_text,
    validate_tailoring_evidence,
)
from applicient_api.tier_resolution import resolve_tier

MAX_ATTEMPTS = 2  # F5.5 — hard cap


class VerificationError(Exception):
    pass


def _get_document(db, document_id: uuid.UUID, user_id: uuid.UUID) -> Document:
    document = db.query(Document).filter_by(id=document_id, user_id=user_id).one_or_none()
    if document is None:
        raise VerificationError(f"document {document_id} not found")
    return document


def _persist_verdicts(db, *, document_id: uuid.UUID, output, attempt_number: int, model_id: str | None) -> None:
    now = datetime.now(timezone.utc)
    for claim in output.claims:
        valid_evidence_ids = []
        for raw_id in claim.evidence_ids:
            try:
                valid_evidence_ids.append(uuid.UUID(str(raw_id)))
            except ValueError:
                continue  # a hallucinated/malformed id is dropped, not trusted
        db.add(
            ClaimVerification(
                document_id=document_id,
                claim_text=claim.claim_text,
                evidence_ids=valid_evidence_ids,
                verdict=claim.verdict,
                rationale=claim.rationale,
                attempt_number=attempt_number,
                model_used=model_id,
                verified_at=now,
            )
        )


def run_verification_attempt(
    session_factory: sessionmaker,
    *,
    document_id: uuid.UUID,
    user_id: uuid.UUID,
    attempt_number: int,
    agent_run_id: uuid.UUID | None = None,
) -> tuple[Document, bool]:
    """Verifies the document's CURRENT json_delta, persists this
    attempt's ClaimVerification rows, and sets `document.verified` only
    when the outcome is actually final — clean (any attempt), or dirty
    on the last allowed attempt. Returns (document, clean) so the
    caller knows whether to schedule a regeneration."""

    with session_factory() as db:
        document = _get_document(db, document_id, user_id)
        persona = db.get(Persona, document.persona_id)
        profile = db.get(Profile, persona.profile_id)
        evidence_items = retrieve_full_evidence_bank(db, profile_id=profile.id)

        deep_model = resolve_tier(
            db,
            user_id=user_id,
            tier="deep",
            stage="claim-verification",
            agent_run_id=agent_run_id,
            session_factory=session_factory,
        )
        # Doc-type-agnostic verifier (claim_verifier.py), doc-type-
        # specific claims formatting — a CV's bullets vs. a cover
        # letter's paragraphs are shaped differently, but neither
        # shape leaks into the verifier itself.
        if document.doc_type == DocumentType.COVER_LETTER.value:
            claims_text = cover_letter_claims_text(CoverLetterOutput.model_validate(document.json_delta))
        elif document.doc_type == DocumentType.ANSWER_PACK.value:
            claims_text = answer_pack_claims_text(AnswerPackOutput.model_validate(document.json_delta))
        else:
            claims_text = tailoring_claims_text(TailoringOutput.model_validate(document.json_delta))
        output = run_claim_verification(deep_model, claims_text=claims_text, evidence_items=evidence_items)
        model_id = getattr(deep_model, "model_name", None)
        _persist_verdicts(db, document_id=document.id, output=output, attempt_number=attempt_number, model_id=model_id)

        clean = all_claims_clean(output)
        if clean:
            document.verified = True
        elif attempt_number >= MAX_ATTEMPTS:
            document.verified = False
        db.commit()
        db.refresh(document)
        return document, clean


def regenerate_from_last_verification(
    session_factory: sessionmaker,
    *,
    document_id: uuid.UUID,
    user_id: uuid.UUID,
    agent_run_id: uuid.UUID | None = None,
) -> Document:
    """F5.5 — one regeneration attempt, the SPECIFIC violations from
    the most recent verification attempt fed back verbatim (not just
    "try again"). Updates the document's json_delta in place."""

    with session_factory() as db:
        document = _get_document(db, document_id, user_id)
        persona = db.get(Persona, document.persona_id)
        profile = db.get(Profile, persona.profile_id)
        evidence_items = retrieve_full_evidence_bank(db, profile_id=profile.id)

        latest_attempt = (
            db.query(ClaimVerification.attempt_number)
            .filter_by(document_id=document.id)
            .order_by(ClaimVerification.attempt_number.desc())
            .limit(1)
            .scalar()
        ) or 0
        bad_rows = (
            db.query(ClaimVerification)
            .filter_by(document_id=document.id, attempt_number=latest_attempt)
            .filter(ClaimVerification.verdict.in_(["unsupported", "inflated"]))
            .all()
        )
        feedback = [f'"{r.claim_text}" was flagged {r.verdict.upper()}: {r.rationale}' for r in bad_rows]

        group = db.get(JobGroup, document.job_group_id)
        member_job_ids = [m.job_id for m in db.query(JobGroupMember).filter_by(job_group_id=group.id).all()]
        jobs = db.query(Job).filter(Job.id.in_(member_job_ids)).all()
        preference = db.query(Preference).filter_by(persona_id=persona.id).one_or_none()

        generation_model = resolve_tier(
            db,
            user_id=user_id,
            tier="deep",
            stage="tailoring-regeneration",
            agent_run_id=agent_run_id,
            session_factory=session_factory,
        )
        if document.doc_type == DocumentType.COVER_LETTER.value:
            retried_letter = run_cover_letter_generation(
                generation_model,
                jobs=jobs,
                profile=profile,
                persona_name=persona.name,
                evidence_items=evidence_items,
                preference=preference,
                prior_violations=feedback,
            )
            validated_letter = validate_cover_letter_evidence(retried_letter, evidence_items)
            document.json_delta = validated_letter.model_dump(mode="json")
        elif document.doc_type == DocumentType.ANSWER_PACK.value:
            # The questions themselves aren't stored separately — each
            # existing answer already carries its own question text
            # (AnswerPackAnswer.question), so they're recovered from
            # the document's own current json_delta rather than
            # needing a parallel "questions" column to stay in sync.
            existing = AnswerPackOutput.model_validate(document.json_delta)
            questions = [a.question for a in existing.answers]
            retried_answers = run_answer_pack_generation(
                generation_model,
                questions=questions,
                jobs=jobs,
                profile=profile,
                persona_name=persona.name,
                evidence_items=evidence_items,
                preference=preference,
                prior_violations=feedback,
            )
            validated_answers = validate_answer_pack_evidence(retried_answers, evidence_items)
            document.json_delta = validated_answers.model_dump(mode="json")
        else:
            retried_cv = run_tailoring(
                generation_model,
                jobs=jobs,
                profile=profile,
                persona_name=persona.name,
                evidence_items=evidence_items,
                preference=preference,
                prior_violations=feedback,
            )
            validated_cv = validate_tailoring_evidence(retried_cv, evidence_items)
            document.json_delta = validated_cv.model_dump(mode="json")
        db.commit()
        db.refresh(document)
        return document


def verify_and_gate(
    session_factory: sessionmaker,
    *,
    document_id: uuid.UUID,
    user_id: uuid.UUID,
    agent_run_id: uuid.UUID | None = None,
) -> Document:
    """Convenience wrapper driving the full loop in one call (used by
    ad hoc scripts/tests) — `routers/job_groups.py`'s real SSE stream
    calls the granular functions above directly instead, so it can
    yield a progress event between each step."""

    document, clean = run_verification_attempt(
        session_factory, document_id=document_id, user_id=user_id, attempt_number=1, agent_run_id=agent_run_id
    )
    if clean:
        return document
    regenerate_from_last_verification(
        session_factory, document_id=document_id, user_id=user_id, agent_run_id=agent_run_id
    )
    document, _ = run_verification_attempt(
        session_factory, document_id=document_id, user_id=user_id, attempt_number=2, agent_run_id=agent_run_id
    )
    return document
