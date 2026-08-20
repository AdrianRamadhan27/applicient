"""F1.5/M1 §3 — persona CRUD. Flat `/personas`, not nested under
`/profiles/{id}` — every route here auto-resolves the caller's one
profile (same one-profile-per-user simplification the rest of the API
already leans on, e.g. Profile Studio's `profiles[0]`), so the client
never needs to know or pass a profile_id."""

import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from applicient_api import schemas
from applicient_api.deps import current_user_id, get_db
from applicient_api.models.profile import Persona, Profile

router = APIRouter(prefix="/personas", tags=["personas"])


def _owned_profile(db: Session, user_id: uuid.UUID) -> Profile:
    profile = db.query(Profile).filter_by(user_id=user_id).one_or_none()
    if profile is None:
        raise HTTPException(404, "no profile shell exists yet — run the API seed command first")
    return profile


@router.get("", response_model=list[schemas.PersonaOut])
def list_personas(db: Session = Depends(get_db), user_id: uuid.UUID = Depends(current_user_id)):
    return db.query(Persona).filter_by(user_id=user_id).all()


@router.post("", response_model=schemas.PersonaOut, status_code=201)
def create_persona(
    body: schemas.PersonaCreate, db: Session = Depends(get_db), user_id: uuid.UUID = Depends(current_user_id)
):
    profile = _owned_profile(db, user_id)
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
    db.delete(persona)
    db.commit()
