"""F1.5/M1 §3 — persona CRUD. Flat `/personas`, not nested under
`/profiles/{id}` — every persona owns its own `Profile` exclusively
(`Persona.profile_id`, `unique=True`), created fresh alongside it, so
the client never needs to know or pass a profile_id either way."""

import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from applicient_api import schemas
from applicient_api.deps import current_user_id, get_db
from applicient_api.models.profile import Persona, Profile

router = APIRouter(prefix="/personas", tags=["personas"])


@router.get("", response_model=list[schemas.PersonaOut])
def list_personas(db: Session = Depends(get_db), user_id: uuid.UUID = Depends(current_user_id)):
    return db.query(Persona).filter_by(user_id=user_id).all()


@router.post("", response_model=schemas.PersonaOut, status_code=201)
def create_persona(
    body: schemas.PersonaCreate, db: Session = Depends(get_db), user_id: uuid.UUID = Depends(current_user_id)
):
    # Every persona gets its own blank Profile — creating the 1st
    # persona is identical to creating the 5th, no "run the seed
    # command first" special case (that used to attach every new
    # persona to one shared, seed-created profile).
    profile = Profile(user_id=user_id, revision=1, confirmed=False)
    db.add(profile)
    db.flush()
    persona = Persona(
        user_id=user_id,
        profile_id=profile.id,
        name=body.name,
        base_cv_template=body.base_cv_template,
    )
    db.add(persona)
    db.commit()
    db.refresh(persona)
    return persona


def _owned_persona(db: Session, persona_id: uuid.UUID, user_id: uuid.UUID) -> Persona:
    persona = db.query(Persona).filter_by(id=persona_id, user_id=user_id).one_or_none()
    if persona is None:
        raise HTTPException(404, "persona not found")
    return persona


@router.patch("/{persona_id}", response_model=schemas.PersonaOut)
def update_persona(
    persona_id: uuid.UUID,
    body: schemas.PersonaUpdate,
    db: Session = Depends(get_db),
    user_id: uuid.UUID = Depends(current_user_id),
):
    persona = _owned_persona(db, persona_id, user_id)
    for field, value in body.model_dump(exclude_unset=True).items():
        setattr(persona, field, value)
    db.commit()
    db.refresh(persona)
    return persona


@router.delete("/{persona_id}", status_code=204)
def delete_persona(
    persona_id: uuid.UUID, db: Session = Depends(get_db), user_id: uuid.UUID = Depends(current_user_id)
):
    persona = _owned_persona(db, persona_id, user_id)
    # Delete via the Profile, not the Persona directly — Profile →
    # Persona cascade already exists (ondelete="CASCADE"), so this one
    # call correctly takes the persona, its evidence bank, and (via
    # their own existing FKs) its Preference/CompanyCandidate/documents/
    # scores down with it. Deleting the Persona row directly would
    # leave its now-exclusive Profile orphaned — there's no cascade in
    # that direction, confirmed live (a disposable test persona left a
    # real orphaned Profile row behind before this fix).
    profile = db.get(Profile, persona.profile_id)
    db.delete(profile)
    db.commit()
