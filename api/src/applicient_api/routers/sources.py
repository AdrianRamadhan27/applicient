"""M1 §2/§3 — Source CRUD + test-connection, mirroring providers.py's
shape (F12.2/F12.5) for the discovery-source equivalent."""

import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from applicient_api import schemas, source_connections
from applicient_api.deps import current_user_id, get_db
from applicient_api.models.discovery import Source
from applicient_sources import get_adapter

router = APIRouter(prefix="/sources", tags=["sources"])


def _out(source: Source) -> schemas.SourceOut:
    out = schemas.SourceOut.model_validate(source)
    out.config = source_connections.sanitized_config(source.config)
    return out


@router.get("", response_model=list[schemas.SourceOut])
def list_sources(db: Session = Depends(get_db), user_id: uuid.UUID = Depends(current_user_id)):
    return [_out(s) for s in db.query(Source).filter_by(user_id=user_id).all()]


@router.post("", response_model=schemas.SourceOut, status_code=201)
def create_source(
    body: schemas.SourceCreate, db: Session = Depends(get_db), user_id: uuid.UUID = Depends(current_user_id)
):
    try:
        get_adapter(body.adapter_key)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc

    source = Source(
        user_id=user_id,
        name=body.name,
        tier=body.tier,
        adapter_key=body.adapter_key,
        config=source_connections.encrypted_config(body.config),
        rate_limit_config=body.rate_limit_config,
        enabled=body.enabled,
        status="untested",
    )
    db.add(source)
    db.commit()
    db.refresh(source)
    return _out(source)


def _owned_source(db: Session, source_id: uuid.UUID, user_id: uuid.UUID) -> Source:
    source = db.query(Source).filter_by(id=source_id, user_id=user_id).one_or_none()
    if source is None:
        raise HTTPException(404, "source not found")
    return source


@router.patch("/{source_id}", response_model=schemas.SourceOut)
def update_source(
    source_id: uuid.UUID,
    body: schemas.SourceUpdate,
    db: Session = Depends(get_db),
    user_id: uuid.UUID = Depends(current_user_id),
):
    source = _owned_source(db, source_id, user_id)
    updates = body.model_dump(exclude_unset=True)
    config = updates.pop("config", None)
    for field, value in updates.items():
        setattr(source, field, value)
    if config is not None:
        source.config = source_connections.encrypted_config(config)
        # A changed config is unverified until re-tested — same
        # discipline as ProviderConnection (F12.5): "untested or
        # failing connections cannot be bound," so a stale `ok` badge
        # after silently editing the board token/key would be a lie.
        source.status = "untested"
        source.last_error = None
    db.commit()
    db.refresh(source)
    return _out(source)


@router.delete("/{source_id}", status_code=204)
def delete_source(
    source_id: uuid.UUID, db: Session = Depends(get_db), user_id: uuid.UUID = Depends(current_user_id)
):
    source = _owned_source(db, source_id, user_id)
    db.delete(source)
    db.commit()


@router.post("/{source_id}/test", response_model=schemas.SourceOut)
def test_source(
    source_id: uuid.UUID, db: Session = Depends(get_db), user_id: uuid.UUID = Depends(current_user_id)
):
    source = _owned_source(db, source_id, user_id)
    result = source_connections.test_source(source)
    source.status = result.status
    source.last_verified_at = datetime.now(timezone.utc)
    source.last_error = result.error
    db.commit()
    db.refresh(source)
    return _out(source)
