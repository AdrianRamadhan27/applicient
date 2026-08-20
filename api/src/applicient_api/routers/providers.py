"""F12.2/F12.5/F12.7 — the actual routes the Models & Providers screen
calls. Thin wrappers over connections.py's service layer."""

import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from applicient_api import connections, schemas
from applicient_api.deps import current_user_id, get_db
from applicient_api.models.llm import ModelCatalogEntry, ProviderConnection

router = APIRouter(prefix="/provider-connections", tags=["providers"])


@router.get("", response_model=list[schemas.ProviderConnectionOut])
def list_connections(db: Session = Depends(get_db), user_id: uuid.UUID = Depends(current_user_id)):
    return db.query(ProviderConnection).filter_by(user_id=user_id).all()


@router.post("", response_model=schemas.ProviderConnectionOut, status_code=201)
def create_connection(
    body: schemas.ProviderConnectionCreate,
    db: Session = Depends(get_db),
    user_id: uuid.UUID = Depends(current_user_id),
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


@router.post("/{connection_id}/test", response_model=schemas.ProviderConnectionOut)
def test_connection(
    connection_id: uuid.UUID, db: Session = Depends(get_db), user_id: uuid.UUID = Depends(current_user_id)
):
    conn = _owned_connection(db, connection_id, user_id)
    connections.test_connection(db, conn)
    db.commit()
    return conn


@router.post("/{connection_id}/refresh-catalog", response_model=list[schemas.ModelCatalogEntryOut])
def refresh_catalog(
    connection_id: uuid.UUID, db: Session = Depends(get_db), user_id: uuid.UUID = Depends(current_user_id)
):
    conn = _owned_connection(db, connection_id, user_id)
    entries = connections.refresh_catalog(db, conn)
    db.commit()
    return entries


@router.get("/{connection_id}/catalog", response_model=list[schemas.ModelCatalogEntryOut])
def get_catalog(
    connection_id: uuid.UUID, db: Session = Depends(get_db), user_id: uuid.UUID = Depends(current_user_id)
):
    _owned_connection(db, connection_id, user_id)
    return (
        db.query(ModelCatalogEntry)
        .filter_by(provider_connection_id=connection_id)
        .order_by(ModelCatalogEntry.model_id)
        .all()
    )
