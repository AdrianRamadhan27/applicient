"""F1 — Profile Studio backend. Profile confirmation is the downstream
truth gate; persona/preference management (F1.4/F1.5) land with later steps."""

import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from applicient_api import schemas
from applicient_api.credit_ledger import FEATURE_CV_FIX, charge_credits, require_credits
from applicient_api.cv_review_service import CvReviewError, run_cv_fix_for_profile, run_cv_score_for_profile
from applicient_api.deps import current_user_id, get_db, get_session_factory
from applicient_api.models.profile import EvidenceItem, Profile
from applicient_api.rate_limit import rate_limit
from applicient_api.tier_resolution import TierResolutionError

router = APIRouter(prefix="/profiles", tags=["profiles"])


@router.get("", response_model=list[schemas.ProfileOut])
def list_profiles(db: Session = Depends(get_db), user_id: uuid.UUID = Depends(current_user_id)):
    return db.query(Profile).filter_by(user_id=user_id).all()


@router.get("/{profile_id}", response_model=schemas.ProfileOut)
def get_profile(profile_id: uuid.UUID, db: Session = Depends(get_db), user_id: uuid.UUID = Depends(current_user_id)):
    profile = db.query(Profile).filter_by(id=profile_id, user_id=user_id).one_or_none()
    if profile is None:
        raise HTTPException(404, "profile not found")
    return profile


@router.patch("/{profile_id}", response_model=schemas.ProfileOut)
def update_profile(
    profile_id: uuid.UUID,
    body: schemas.ProfileUpdate,
    db: Session = Depends(get_db),
    user_id: uuid.UUID = Depends(current_user_id),
):
    profile = db.query(Profile).filter_by(id=profile_id, user_id=user_id).one_or_none()
    if profile is None:
        raise HTTPException(404, "profile not found")

    updates = body.model_dump(exclude_unset=True)
    if updates.get("confirmed") is True:
        evidence_items = db.query(EvidenceItem).filter_by(profile_id=profile_id).all()
        if not evidence_items:
            raise HTTPException(409, "parse a CV or add evidence before confirming the profile")
        if any(item.embedding is None for item in evidence_items):
            raise HTTPException(409, "every evidence item must be embedded before confirming the profile")

    content_changed = any(field != "confirmed" for field in updates)
    for field, value in updates.items():
        setattr(profile, field, value)

    if "confirmed" in updates:
        # Confirmation is the single user-controlled gate for downstream
        # agents. Keep the per-item flag in lockstep so a future query can
        # safely filter on either the profile or the evidence row.
        db.query(EvidenceItem).filter_by(profile_id=profile_id).update(
            {"verified": bool(updates["confirmed"])},
            synchronize_session="fetch",
        )

    if content_changed:
        profile.revision += 1
        profile.confirmed = False
        db.query(EvidenceItem).filter_by(profile_id=profile_id).update(
            {"verified": False},
            synchronize_session="fetch",
        )

    db.commit()
    db.refresh(profile)
    return profile


@router.post("/{profile_id}/reset", response_model=schemas.ProfileOut)
def reset_profile(
    profile_id: uuid.UUID, db: Session = Depends(get_db), user_id: uuid.UUID = Depends(current_user_id)
):
    """Clears this profile's own fields and deletes its evidence items,
    in place — does NOT delete-and-recreate the `Profile` row itself.

    That used to be safe because every persona shared the one profile
    a user had (deleting it cascaded away every persona too, and
    recreating a fresh shell kept the app's then-standing "exactly one
    profile" invariant intact). Now that every persona owns its
    profile exclusively (`Persona.profile_id`, `unique=True`), deleting
    the row would cascade-delete the very persona resetting it — a
    "reset my profile" action must never delete the persona. Deleting
    a persona entirely (which *should* take its profile down with it)
    is `routers/personas.py`'s `delete_persona`, a distinct action.
    """
    profile = db.query(Profile).filter_by(id=profile_id, user_id=user_id).one_or_none()
    if profile is None:
        raise HTTPException(404, "profile not found")

    db.query(EvidenceItem).filter_by(profile_id=profile_id).delete()
    profile.raw_cv_object_key = None
    profile.parsed_profile = {}
    profile.parsed_at = None
    profile.confirmed = False
    profile.visa_status = None
    profile.notice_period_days = None
    profile.revision += 1
    db.commit()
    db.refresh(profile)
    return profile


@router.post(
    "/{profile_id}/cv-score",
    response_model=schemas.ProfileOut,
    dependencies=[Depends(rate_limit("cv-score", limit=10, window_seconds=60))],
)
def score_cv(
    profile_id: uuid.UUID, db: Session = Depends(get_db), user_id: uuid.UUID = Depends(current_user_id)
):
    """Adrian, direct: "after user upload cv there needs to be cv
    scoring... to give analysis and feedback." Free — no
    require_credits/charge_credits here at all, same as CV parsing
    itself (cv_review_service.py's own docstring)."""

    try:
        return run_cv_score_for_profile(db, profile_id=profile_id, user_id=user_id, session_factory=get_session_factory())
    except CvReviewError as exc:
        raise HTTPException(409, str(exc))
    except TierResolutionError as exc:
        raise HTTPException(422, f"model routing not configured: {exc}")


@router.post(
    "/{profile_id}/cv-fix",
    response_model=schemas.CvFixResultOut,
    dependencies=[
        Depends(rate_limit("cv-fix", limit=5, window_seconds=60)),
        Depends(require_credits(FEATURE_CV_FIX, label="fixing your CV")),
    ],
)
def fix_cv(
    profile_id: uuid.UUID, db: Session = Depends(get_db), user_id: uuid.UUID = Depends(current_user_id)
):
    """"Fix my CV" (Adrian, direct) — general wording improvement
    across the whole evidence bank, informed by the persona's own
    preferences but not tailored to any specific job. See
    cv_fix_engine.py's own docstring for the "wording only, never
    facts" rule and cv_review_service.py for how each revision is
    applied as a real EvidenceItem.text update."""

    try:
        result = run_cv_fix_for_profile(db, profile_id=profile_id, user_id=user_id, session_factory=get_session_factory())
    except CvReviewError as exc:
        raise HTTPException(409, str(exc))
    except TierResolutionError as exc:
        raise HTTPException(422, f"model routing not configured: {exc}")
    charge_credits(db, user_id=user_id, feature_key=FEATURE_CV_FIX, label="fixing your CV")
    return result
