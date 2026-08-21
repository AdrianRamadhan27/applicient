"""F1 — Profile Studio backend. Profile confirmation is the downstream
truth gate; persona/preference management (F1.4/F1.5) land with later steps."""

import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from applicient_api import schemas
from applicient_api.deps import current_user_id, get_db
from applicient_api.models.profile import EvidenceItem, Profile

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
