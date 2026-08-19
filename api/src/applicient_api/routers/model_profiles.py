"""GUI-managed model tier bindings used by every agent stage."""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from applicient_api import schemas
from applicient_api.deps import current_user_id, get_db
from applicient_api.model_profiles import upsert_active_profile
from applicient_api.models.llm import ModelCatalogEntry, ModelProfile, ProviderConnection

router = APIRouter(prefix="/model-profiles", tags=["model-profiles"])

_ALLOWED_TIERS = {"fast", "balanced", "deep", "embedding"}


def _validate_bindings(
    db: Session,
    *,
    user_id: uuid.UUID,
    tier_bindings: dict[str, uuid.UUID],
    stage_overrides: dict[str, uuid.UUID],
) -> None:
    unknown_tiers = set(tier_bindings) - _ALLOWED_TIERS
    if unknown_tiers:
        raise HTTPException(422, f"unknown model tier(s): {', '.join(sorted(unknown_tiers))}")
    if "deep" not in tier_bindings or "embedding" not in tier_bindings:
        raise HTTPException(422, "deep and embedding tier bindings are required for CV ingest")

    all_ids = set(tier_bindings.values()) | set(stage_overrides.values())
    entries = (
        db.query(ModelCatalogEntry)
        .join(ProviderConnection, ModelCatalogEntry.provider_connection_id == ProviderConnection.id)
        .filter(
            ModelCatalogEntry.id.in_(all_ids),
            ProviderConnection.user_id == user_id,
        )
        .all()
    )
    by_id = {entry.id: entry for entry in entries}
    missing = sorted(str(entry_id) for entry_id in all_ids if entry_id not in by_id)
    if missing:
        raise HTTPException(422, f"catalog entry not found for this user: {', '.join(missing)}")

    for tier, entry_id in {**tier_bindings, **stage_overrides}.items():
        entry = by_id[entry_id]
        connection = db.get(ProviderConnection, entry.provider_connection_id)
        if connection is None or connection.status != "ok":
            raise HTTPException(409, f"provider connection for {entry.model_id} is not verified")
        if tier == "embedding" and "embedding" not in (entry.capabilities or []):
            raise HTTPException(422, f"{entry.model_id} is not an embedding model")
        if tier == "deep" and "structured_output" not in (entry.capabilities or []):
            raise HTTPException(422, f"{entry.model_id} does not advertise structured output")


@router.get("/active", response_model=schemas.ModelProfileOut | None)
def get_active_model_profile(
    db: Session = Depends(get_db), user_id: uuid.UUID = Depends(current_user_id)
):
    return db.query(ModelProfile).filter_by(user_id=user_id, is_active=True).one_or_none()


@router.put("/active", response_model=schemas.ModelProfileOut)
def save_active_model_profile(
    body: schemas.ModelProfileUpdate,
    db: Session = Depends(get_db),
    user_id: uuid.UUID = Depends(current_user_id),
):
    tier_bindings = {tier: str(entry_id) for tier, entry_id in body.tier_bindings.items()}
    stage_overrides = {stage: str(entry_id) for stage, entry_id in body.stage_overrides.items()}
    _validate_bindings(
        db,
        user_id=user_id,
        tier_bindings={tier: uuid.UUID(entry_id) for tier, entry_id in tier_bindings.items()},
        stage_overrides={stage: uuid.UUID(entry_id) for stage, entry_id in stage_overrides.items()},
    )
    profile = upsert_active_profile(
        db,
        user_id=user_id,
        name=body.name.strip() or "openrouter-budget",
        tier_bindings=tier_bindings,
        stage_overrides=stage_overrides,
    )
    db.commit()
    db.refresh(profile)
    return profile
