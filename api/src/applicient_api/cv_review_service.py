"""Wires cv_score_engine.py/cv_fix_engine.py to a real Profile — both
raised directly by Adrian: general (non-job-specific) CV quality
feedback after a fresh parse, shown on the Composer's Base CV page,
plus a "fix my CV" action that rewrites weak evidence-bank wording in
place (never facts/metrics — see cv_fix_engine.py's own docstring).

Both reuse tailoring_engine.py's own `profile_summary`/
`evidence_bank_summary`/`retrieve_full_evidence_bank` helpers rather
than duplicating that formatting — same shape the tailoring pipeline
already grounds itself in, so scoring/fixing "sees" the same picture
tailoring does."""

from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy.orm import Session, sessionmaker

from applicient_api.cv_fix_engine import run_cv_fix
from applicient_api.cv_score_engine import run_cv_score
from applicient_api.embedding_service import embed_evidence_items
from applicient_api.models.profile import Persona, Preference, Profile
from applicient_api.tailoring_engine import evidence_bank_summary, profile_summary, retrieve_full_evidence_bank
from applicient_api.tier_resolution import resolve_embedding_tier, resolve_tier


class CvReviewError(Exception):
    pass


def _load_context(db: Session, *, profile_id: uuid.UUID, user_id: uuid.UUID) -> tuple[Profile, Persona, Preference | None]:
    profile = db.query(Profile).filter_by(id=profile_id, user_id=user_id).one_or_none()
    if profile is None:
        raise CvReviewError(f"profile {profile_id} not found")
    persona = db.query(Persona).filter_by(profile_id=profile_id, user_id=user_id).one_or_none()
    if persona is None:
        raise CvReviewError(f"no persona owns profile {profile_id}")
    preference = db.query(Preference).filter_by(persona_id=persona.id).one_or_none()
    return profile, persona, preference


def run_cv_score_for_profile(
    db: Session, *, profile_id: uuid.UUID, user_id: uuid.UUID, session_factory: sessionmaker
) -> Profile:
    """Free (no FeatureCreditCost row, confirmed directly with Adrian —
    grouped with CV parsing as "on the house"). Overwrites any prior
    score rather than versioning it, same as skill_gap_service.py's own
    syllabus — a fresh assessment of the CURRENT evidence bank is what
    matters, not a history of past ones."""

    profile, persona, preference = _load_context(db, profile_id=profile_id, user_id=user_id)
    evidence_items = retrieve_full_evidence_bank(db, profile_id=profile_id)
    if not evidence_items:
        raise CvReviewError("no evidence in this profile's bank yet — parse a CV or add evidence first")

    model = resolve_tier(db, user_id=user_id, tier="balanced", stage="cv-score", session_factory=session_factory)
    output = run_cv_score(
        model,
        profile_summary=profile_summary(profile, persona.name, preference),
        evidence_bank_summary=evidence_bank_summary(evidence_items),
    )
    profile.cv_score = output.model_dump(mode="json")
    profile.cv_scored_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(profile)
    return profile


def run_cv_fix_for_profile(
    db: Session, *, profile_id: uuid.UUID, user_id: uuid.UUID, session_factory: sessionmaker
) -> dict:
    """Costs credits (confirmed directly — first use still free via the
    existing credit_ledger.py rule, no special-casing needed here).
    Applies each returned revision as a real `EvidenceItem.text` UPDATE
    — a standing change every future tailored CV builds on, independently
    editable/reversible afterward like any other manual evidence edit
    (routers/evidence.py's own PATCH). Returns a small summary dict
    (updated item count + the engine's own `notes`), not the full
    Profile — the caller re-fetches the evidence bank itself to see
    the real, persisted result rather than trusting a echoed copy."""

    profile, persona, preference = _load_context(db, profile_id=profile_id, user_id=user_id)
    evidence_items = retrieve_full_evidence_bank(db, profile_id=profile_id)
    if not evidence_items:
        raise CvReviewError("no evidence in this profile's bank yet — parse a CV or add evidence first")

    model = resolve_tier(db, user_id=user_id, tier="balanced", stage="cv-fix", session_factory=session_factory)
    output = run_cv_fix(
        model,
        profile_summary=profile_summary(profile, persona.name, preference),
        evidence_bank_summary=evidence_bank_summary(evidence_items),
    )

    by_id = {item.id: item for item in evidence_items}
    changed_items = []
    for fix in output.items:
        item = by_id.get(fix.evidence_id)
        # A hallucinated evidence_id is dropped, not trusted — same
        # "don't trust a hallucinated reference" discipline
        # tailoring_engine.py's own docstring names for
        # validate_tailoring_evidence.
        if item is None or not fix.revised_text.strip():
            continue
        item.text = fix.revised_text.strip()
        # Same discipline routers/evidence.py's own manual-edit PATCH
        # already applies to a text change — the embedding vector is
        # now stale (built from the old text) and the item/profile
        # haven't been re-confirmed against the new wording, so both
        # need to say so rather than silently keep looking "verified."
        item.embedding = None
        item.verified = False
        changed_items.append(item)

    if changed_items:
        profile.revision += 1
        profile.confirmed = False
        try:
            embeddings_client, provider = resolve_embedding_tier(db, user_id=user_id)
            embed_evidence_items(
                db, embeddings_client, changed_items, user_id=user_id,
                session_factory=session_factory, provider=provider, stage="cv-fix",
            )
        except Exception as exc:
            db.rollback()
            raise CvReviewError(f"fix applied, but re-embedding failed: {str(exc)[:240]}") from exc

    db.commit()
    return {"updated_count": len(changed_items), "notes": output.notes}
