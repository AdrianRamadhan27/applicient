"""F12.2/F12.5/F12.7 — the actual routes the Models & Providers screen
calls. Thin wrappers over connections.py's service layer.

SaaS pivot — admin-only. ProviderConnection stops being private-to-the-
user data and becomes the single admin-configured set of connections
the whole deployment's LLM calls resolve against (see
tier_resolution.py); `user_id` on each row now means "which admin
configured this," not "who it's private to.\""""

import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from applicient_api import connections, schemas
from applicient_api.deps import current_admin_user, get_db
from applicient_api.models.llm import AudioSettings, EmbeddingIndex, ModelCatalogEntry, ModelProfile, ProviderConnection

router = APIRouter(prefix="/provider-connections", tags=["providers"])
audio_settings_router = APIRouter(prefix="/audio-settings", tags=["providers"])


@router.get("", response_model=list[schemas.ProviderConnectionOut])
def list_connections(db: Session = Depends(get_db), user_id: uuid.UUID = Depends(current_admin_user)):
    return db.query(ProviderConnection).filter_by(user_id=user_id).all()


@router.post("", response_model=schemas.ProviderConnectionOut, status_code=201)
def create_connection(
    body: schemas.ProviderConnectionCreate,
    db: Session = Depends(get_db),
    user_id: uuid.UUID = Depends(current_admin_user),
):
    if body.provider == "openai_compatible" and not body.base_url:
        raise HTTPException(422, "base_url is required for an openai_compatible provider")

    conn = connections.create_connection(
        db,
        user_id=user_id,
        provider=body.provider,
        api_key=body.api_key,
        base_url=body.base_url,
        label=body.label,
    )
    db.commit()
    return conn


def _owned_connection(db: Session, connection_id: uuid.UUID, user_id: uuid.UUID) -> ProviderConnection:
    conn = db.query(ProviderConnection).filter_by(id=connection_id, user_id=user_id).one_or_none()
    if conn is None:
        raise HTTPException(404, "provider connection not found")
    return conn


def _catalog_ids(db: Session, connection_id: uuid.UUID) -> set[uuid.UUID]:
    return {
        row[0]
        for row in db.query(ModelCatalogEntry.id).filter_by(provider_connection_id=connection_id).all()
    }


def _delete_blocker(db: Session, *, user_id: uuid.UUID, connection_id: uuid.UUID) -> str | None:
    """Return a user-facing reason if deleting this connection would leave
    a model profile or embedding index pointing at deleted catalog rows."""

    entry_ids = _catalog_ids(db, connection_id)
    if not entry_ids:
        return None

    entry_id_strings = {str(entry_id) for entry_id in entry_ids}
    profile_uses: list[str] = []
    for profile in db.query(ModelProfile).filter_by(user_id=user_id).all():
        for tier, entry_id in {**(profile.tier_bindings or {}), **(profile.stage_overrides or {})}.items():
            if str(entry_id) in entry_id_strings:
                profile_uses.append(f"{profile.name} ({tier})")

    if profile_uses:
        return (
            "rebind or remove these model-profile bindings first: "
            + ", ".join(profile_uses)
        )

    indexed = (
        db.query(EmbeddingIndex.id)
        .filter(
            EmbeddingIndex.user_id == user_id,
            EmbeddingIndex.model_catalog_entry_id.in_(entry_ids),
        )
        .first()
    )
    if indexed is not None:
        return "its catalog model is still used by an embedding index"

    return None


@router.delete("/{connection_id}", status_code=204)
def delete_connection(
    connection_id: uuid.UUID,
    db: Session = Depends(get_db),
    user_id: uuid.UUID = Depends(current_admin_user),
):
    conn = _owned_connection(db, connection_id, user_id)
    blocker = _delete_blocker(db, user_id=user_id, connection_id=connection_id)
    if blocker:
        raise HTTPException(409, f"cannot delete provider connection: {blocker}")

    connections.delete_connection(db, conn)
    db.commit()


@router.post("/{connection_id}/test", response_model=schemas.ProviderConnectionOut)
def test_connection(
    connection_id: uuid.UUID, db: Session = Depends(get_db), user_id: uuid.UUID = Depends(current_admin_user)
):
    conn = _owned_connection(db, connection_id, user_id)
    connections.test_connection(db, conn)
    db.commit()
    return conn


@router.post("/{connection_id}/refresh-catalog", response_model=list[schemas.ModelCatalogEntryOut])
def refresh_catalog(
    connection_id: uuid.UUID, db: Session = Depends(get_db), user_id: uuid.UUID = Depends(current_admin_user)
):
    conn = _owned_connection(db, connection_id, user_id)
    entries = connections.refresh_catalog(db, conn)
    db.commit()
    return entries


@router.get("/{connection_id}/catalog", response_model=list[schemas.ModelCatalogEntryOut])
def get_catalog(
    connection_id: uuid.UUID, db: Session = Depends(get_db), user_id: uuid.UUID = Depends(current_admin_user)
):
    _owned_connection(db, connection_id, user_id)
    return (
        db.query(ModelCatalogEntry)
        .filter_by(provider_connection_id=connection_id)
        .order_by(ModelCatalogEntry.model_id)
        .all()
    )


# Phase 11 (v2 plan) — interview practice's STT/TTS model + voice,
# configured here rather than a second admin screen since it reuses
# the exact same catalog (transcription/speech-capability entries,
# refreshed the same way chat/embedding ones already are). Deployment-
# wide singleton — get-or-create, not a list of named presets like
# ModelProfile, since there's only ever one "the" audio config
# interview_media.py resolves against.
def _get_or_create_audio_settings(db: Session, *, user_id: uuid.UUID) -> AudioSettings:
    settings = db.query(AudioSettings).first()
    if settings is None:
        settings = AudioSettings(user_id=user_id)
        db.add(settings)
        db.flush()
    return settings


@audio_settings_router.get("", response_model=schemas.AudioSettingsOut)
def get_audio_settings(db: Session = Depends(get_db), user_id: uuid.UUID = Depends(current_admin_user)):
    settings = _get_or_create_audio_settings(db, user_id=user_id)
    db.commit()
    return settings


def _validate_catalog_entry(db: Session, entry_id: uuid.UUID | None, capability: str) -> None:
    if entry_id is None:
        return
    entry = db.get(ModelCatalogEntry, entry_id)
    if entry is None:
        raise HTTPException(422, f"model catalog entry {entry_id} not found — refresh the provider's catalog first")
    if capability not in entry.capabilities:
        raise HTTPException(422, f"{entry.model_id} isn't tagged '{capability}' — pick a model from that section of the catalog")


@audio_settings_router.put("", response_model=schemas.AudioSettingsOut)
def update_audio_settings(
    body: schemas.AudioSettingsUpdate, db: Session = Depends(get_db), user_id: uuid.UUID = Depends(current_admin_user)
):
    _validate_catalog_entry(db, body.transcribe_catalog_entry_id, "transcription")
    _validate_catalog_entry(db, body.speech_catalog_entry_id, "speech")

    settings = _get_or_create_audio_settings(db, user_id=user_id)
    settings.transcribe_catalog_entry_id = body.transcribe_catalog_entry_id
    settings.speech_catalog_entry_id = body.speech_catalog_entry_id
    settings.speech_voice = body.speech_voice
    settings.speech_voice_secondary = body.speech_voice_secondary
    settings.user_id = user_id
    db.commit()
    db.refresh(settings)
    return settings
