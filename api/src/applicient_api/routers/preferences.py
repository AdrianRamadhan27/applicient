"""F1.4/F1.9/M2 §2 — per-persona preferences. Nested under
`/personas/{persona_id}/preferences` since it's a 1:1 singleton
resource per persona, not a freestanding collection.

GET 404s until the first PUT — there is no auto-created empty row
(unlike Persona itself), since a Preference nobody has ever saved
shouldn't clutter the DB with a dozen null columns that were never
really "set." The GUI treats a 404 here as "show the empty
questionnaire," not an error.

PUT is an upsert with PATCH-shaped semantics (`exclude_unset`) even
though the URL is a singleton — the row may not exist yet on first
save. Any field present in the payload bumps `Persona.revision` (same
trigger shape as `routers/profiles.py`'s `content_changed`), which is
what lets `FitScore`/`PrefilterResult`'s `persona_revision` stamp
actually mean something (M2 §1/§3)."""

import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from applicient_api import schemas
from applicient_api.deps import current_user_id, get_db
from applicient_api.models.profile import Persona, Preference

router = APIRouter(prefix="/personas/{persona_id}/preferences", tags=["preferences"])


def _owned_persona(db: Session, persona_id: uuid.UUID, user_id: uuid.UUID) -> Persona:
    persona = db.query(Persona).filter_by(id=persona_id, user_id=user_id).one_or_none()
    if persona is None:
        raise HTTPException(404, "persona not found")
    return persona


@router.get("", response_model=schemas.PreferenceOut)
def get_preference(
    persona_id: uuid.UUID, db: Session = Depends(get_db), user_id: uuid.UUID = Depends(current_user_id)
):
    _owned_persona(db, persona_id, user_id)
    preference = db.query(Preference).filter_by(persona_id=persona_id, user_id=user_id).one_or_none()
    if preference is None:
        raise HTTPException(404, "no preferences saved yet for this persona")
    return preference


@router.put("", response_model=schemas.PreferenceOut)
def upsert_preference(
    persona_id: uuid.UUID,
    body: schemas.PreferenceUpsert,
    db: Session = Depends(get_db),
    user_id: uuid.UUID = Depends(current_user_id),
):
    persona = _owned_persona(db, persona_id, user_id)
    updates = body.model_dump(exclude_unset=True)

    preference = db.query(Preference).filter_by(persona_id=persona_id, user_id=user_id).one_or_none()
    if preference is None:
        preference = Preference(user_id=user_id, persona_id=persona_id)
        db.add(preference)

    for field, value in updates.items():
        setattr(preference, field, value)

    if updates:
        persona.revision += 1

    db.commit()
    db.refresh(preference)
    return preference
