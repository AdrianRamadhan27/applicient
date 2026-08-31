"""F6.6 — persistent, encrypted authenticated browser contexts. One
(persona, source) pair maps to at most one saved Playwright
`storage_state()` blob — cookies/localStorage captured after a real
login, Fernet-encrypted before it's ever written to object storage
(same mechanism as `Credential.secret_encrypted`, not a new one). Never
stores a password: the blob only ever comes from Playwright's own
`storage_state()`, which captures the resulting session, not anything
typed into a form.

Used by `agents/src/applicient_agents/application_service.py` to load
a saved session before a run's first `browser_open` and to save the
(possibly newly-authenticated) session back after a run interrupts or
finishes — the actual encrypt/decrypt and object-storage read/write
happen only here, mirroring `credential_service.py`'s "one place
decrypts" discipline.
"""

from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone

from sqlalchemy.orm import Session

from applicient_api.models.discovery import Job, JobSighting
from applicient_api.models.pipeline import BrowserContext
from applicient_api.object_storage import get_object, put_object
from applicient_api.security import decrypt_api_key, encrypt_api_key


def resolve_source_id(db: Session, job: Job) -> uuid.UUID | None:
    """Which Source this job's apply flow belongs to, for the
    BrowserContext lookup below. `Job` itself has no direct source_id
    (F3.3: a job can have N sightings, one per source it was seen on)
    — prefers the ATS/preferred sighting (F3.4's own "ATS over
    aggregator" precedent), falls back to the earliest sighting seen
    if no preference was ever recorded. Returns None only if a job
    somehow has no sightings at all, which nothing else in this
    codebase should ever produce."""

    if job.preferred_sighting_id is not None:
        sighting = db.get(JobSighting, job.preferred_sighting_id)
        if sighting is not None:
            return sighting.source_id
    sighting = (
        db.query(JobSighting).filter_by(job_id=job.id).order_by(JobSighting.first_seen_at.asc()).first()
    )
    return sighting.source_id if sighting else None


def load_storage_state(db: Session, *, user_id: uuid.UUID, persona_id: uuid.UUID, source_id: uuid.UUID) -> dict | None:
    ctx = (
        db.query(BrowserContext)
        .filter_by(user_id=user_id, persona_id=persona_id, source_id=source_id)
        .order_by(BrowserContext.created_at.desc())
        .first()
    )
    if ctx is None or ctx.storage_state_key is None:
        return None
    blob = get_object(ctx.storage_state_key)
    return json.loads(decrypt_api_key(blob))


def save_storage_state(
    db: Session, *, user_id: uuid.UUID, persona_id: uuid.UUID, source_id: uuid.UUID, storage_state: dict
) -> None:
    ctx = (
        db.query(BrowserContext)
        .filter_by(user_id=user_id, persona_id=persona_id, source_id=source_id)
        .order_by(BrowserContext.created_at.desc())
        .first()
    )
    if ctx is None:
        ctx = BrowserContext(user_id=user_id, persona_id=persona_id, source_id=source_id)
        db.add(ctx)
        db.flush()
    key = ctx.storage_state_key or f"browser-contexts/{persona_id}/{source_id}.enc"
    put_object(key, encrypt_api_key(json.dumps(storage_state)), "application/octet-stream")
    ctx.storage_state_key = key
    ctx.last_used_at = datetime.now(timezone.utc)
