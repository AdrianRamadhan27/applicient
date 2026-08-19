"""F12.9/F12.10 — named presets of tier bindings. The GUI (step 5)
will be the primary way these get created/edited; this is the service
function it will call, built now because tier resolution (step 4)
needs at least one active profile to resolve against.
"""

from __future__ import annotations

import uuid

from sqlalchemy.orm import Session

from applicient_api.models.llm import ModelProfile


def upsert_active_profile(
    session: Session,
    *,
    user_id: uuid.UUID,
    name: str,
    tier_bindings: dict[str, str],
    stage_overrides: dict[str, str] | None = None,
) -> ModelProfile:
    """Creates or updates the named profile and makes it the sole
    active one for this user (only one active profile at a time)."""

    session.query(ModelProfile).filter_by(user_id=user_id, is_active=True).update({"is_active": False})

    profile = session.query(ModelProfile).filter_by(user_id=user_id, name=name).one_or_none()
    if profile is None:
        profile = ModelProfile(user_id=user_id, name=name)
        session.add(profile)

    profile.tier_bindings = tier_bindings
    profile.stage_overrides = stage_overrides or {}
    profile.is_active = True
    session.flush()
    return profile
