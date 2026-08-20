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
    """Deletes the profile and everything hung off it (evidence items,
    personas, and — transitively via DB FK cascade — documents, fit
    scores, prefilter results, and applications), then recreates a
    blank shell in its place. The app has no "create profile" path and
    every surface assumes exactly one profile exists per user (see
    seed.py), so a bare delete would strand the frontend; recreating
    keeps that invariant intact while giving the user an actual clean
    slate.
    """
    profile = db.query(Profile).filter_by(id=profile_id, user_id=user_id).one_or_none()
    if profile is None:
        raise HTTPException(404, "profile not found")

    db.delete(profile)
    db.flush()
    fresh = Profile(user_id=user_id, revision=1, confirmed=False)
    db.add(fresh)
    db.commit()
    db.refresh(fresh)
    return fresh
