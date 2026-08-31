"""Third-party login credentials (LinkedIn, etc.) — a small, separate
CRUD surface deliberately independent of FormAnswer (F6.3's reusable
answer memory): FormAnswer is a semantic-search *answer* store meant
for arbitrary form questions, not a secrets vault, and a raw password
landing there would be a real, persistent leak. Nothing here ever
returns a decrypted secret to a client — only `secret_hint`, same
masking discipline as ProviderConnectionOut.api_key_hint.
"""

import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from applicient_api import credential_service, schemas
from applicient_api.deps import current_user_id, get_db
from applicient_api.models.credentials import Credential

router = APIRouter(prefix="/credentials", tags=["credentials"])


@router.get("", response_model=list[schemas.CredentialOut])
def list_credentials(db: Session = Depends(get_db), user_id: uuid.UUID = Depends(current_user_id)):
    return credential_service.list_credentials(db, user_id=user_id)


@router.post("", response_model=schemas.CredentialOut, status_code=201)
def create_credential(
    body: schemas.CredentialCreate,
    db: Session = Depends(get_db),
    user_id: uuid.UUID = Depends(current_user_id),
):
    label = body.label.strip().lower()
    if not label:
        raise HTTPException(422, "label is required")
    existing = db.query(Credential).filter_by(user_id=user_id, label=label).one_or_none()
    if existing is not None:
        raise HTTPException(409, f"a credential labeled \"{label}\" already exists — delete it first to replace it")
    cred = credential_service.create_credential(
        db, user_id=user_id, label=label, identifier=body.identifier, secret=body.secret
    )
    db.commit()
    return cred


@router.delete("/{credential_id}", status_code=204)
def delete_credential(
    credential_id: uuid.UUID,
    db: Session = Depends(get_db),
    user_id: uuid.UUID = Depends(current_user_id),
):
    try:
        credential_service.delete_credential(db, user_id=user_id, credential_id=credential_id)
    except credential_service.CredentialNotFoundError:
        raise HTTPException(404, "credential not found")
    db.commit()
