"""Third-party login credentials (LinkedIn, etc.) the application-agent
can use to sign in during a fill, without the secret ever passing
through the agent's own context. This is the service layer the
Credentials GUI screen calls and the one `browser_fill_credential`
tool (agents/browser_tools.py) reads from — both go through
`get_secret`, never a raw query, so decryption always happens in one
place.
"""

from __future__ import annotations

import uuid

from sqlalchemy.orm import Session

from applicient_api.models.credentials import Credential
from applicient_api.security import decrypt_api_key, encrypt_api_key, make_hint


class CredentialNotFoundError(Exception):
    pass


def list_credentials(session: Session, *, user_id: uuid.UUID) -> list[Credential]:
    return (
        session.query(Credential)
        .filter_by(user_id=user_id)
        .order_by(Credential.created_at.asc())
        .all()
    )


def create_credential(
    session: Session, *, user_id: uuid.UUID, label: str, identifier: str, secret: str
) -> Credential:
    cred = Credential(
        user_id=user_id,
        label=label.strip().lower(),
        identifier=identifier,
        secret_encrypted=encrypt_api_key(secret),
        secret_hint=make_hint(secret),
    )
    session.add(cred)
    session.flush()
    return cred


def delete_credential(session: Session, *, user_id: uuid.UUID, credential_id: uuid.UUID) -> None:
    cred = session.query(Credential).filter_by(id=credential_id, user_id=user_id).one_or_none()
    if cred is None:
        raise CredentialNotFoundError(str(credential_id))
    session.delete(cred)
    session.flush()


def get_secret(session: Session, *, user_id: uuid.UUID, label: str) -> tuple[str, str] | None:
    """Returns (identifier, decrypted secret) for this label, or None
    if nothing is stored under it. The only function in this codebase
    that ever decrypts a stored credential — called exclusively from
    `browser_fill_credential`'s tool body, never from anything that
    hands its result to an LLM."""

    cred = session.query(Credential).filter_by(user_id=user_id, label=label.strip().lower()).one_or_none()
    if cred is None:
        return None
    return cred.identifier, decrypt_api_key(cred.secret_encrypted)
