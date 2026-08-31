"""F12.9/F12.10 — named presets of tier bindings. The GUI is the
primary way these get created/edited/switched; these are the service
functions it calls.

A user may have any number of profiles, but every other stage in this
codebase (radar.py, tier_resolution.py, routers/job_groups.py,
routers/cv.py) resolves "which model runs this" by querying
`ModelProfile.is_active=True` directly — there is no shared resolver
function for that lookup, so every write path here must preserve the
"at most one active profile per user" invariant on its own. A user
with at least one profile should always have exactly one active;
zero profiles means zero active, which is the only state where tier
resolution has nothing to resolve against (surfaced to the user as
"no active model configuration" wherever that resolution happens).
"""

from __future__ import annotations

import uuid

from sqlalchemy.orm import Session

from applicient_api.models.llm import ModelProfile


class ModelProfileNotFoundError(Exception):
    pass


def list_profiles(session: Session, *, user_id: uuid.UUID) -> list[ModelProfile]:
    return (
        session.query(ModelProfile)
        .filter_by(user_id=user_id)
        .order_by(ModelProfile.created_at.asc())
        .all()
    )


def create_profile(
    session: Session,
    *,
    user_id: uuid.UUID,
    name: str,
    tier_bindings: dict[str, str],
    stage_overrides: dict[str, str] | None = None,
) -> ModelProfile:
    """A brand-new preset, independent of whatever is already active.
    Only auto-activated when it's this user's first profile ever —
    otherwise a second/third preset would silently steal activity from
    whichever one the user is currently relying on."""

    is_first = session.query(ModelProfile).filter_by(user_id=user_id).count() == 0
    profile = ModelProfile(
        user_id=user_id,
        name=name,
        tier_bindings=tier_bindings,
        stage_overrides=stage_overrides or {},
        is_active=is_first,
    )
    session.add(profile)
    session.flush()
    return profile


def update_profile(
    session: Session,
    *,
    user_id: uuid.UUID,
    profile_id: uuid.UUID,
    name: str,
    tier_bindings: dict[str, str],
    stage_overrides: dict[str, str] | None = None,
) -> ModelProfile:
    """Edits a specific profile's own bindings/name — does not touch
    which profile is active."""

    profile = session.query(ModelProfile).filter_by(id=profile_id, user_id=user_id).one_or_none()
    if profile is None:
        raise ModelProfileNotFoundError(str(profile_id))
    profile.name = name
    profile.tier_bindings = tier_bindings
    profile.stage_overrides = stage_overrides or {}
    session.flush()
    return profile


def activate_profile(session: Session, *, user_id: uuid.UUID, profile_id: uuid.UUID) -> ModelProfile:
    profile = session.query(ModelProfile).filter_by(id=profile_id, user_id=user_id).one_or_none()
    if profile is None:
        raise ModelProfileNotFoundError(str(profile_id))

    session.query(ModelProfile).filter(
        ModelProfile.user_id == user_id,
        ModelProfile.is_active.is_(True),
        ModelProfile.id != profile.id,
    ).update({"is_active": False})

    profile.is_active = True
    session.flush()
    return profile


def delete_profile(session: Session, *, user_id: uuid.UUID, profile_id: uuid.UUID) -> None:
    profile = session.query(ModelProfile).filter_by(id=profile_id, user_id=user_id).one_or_none()
    if profile is None:
        raise ModelProfileNotFoundError(str(profile_id))

    was_active = profile.is_active
    session.delete(profile)
    session.flush()

    if was_active:
        # Never silently leave every other stage's `is_active=True`
        # lookup with nothing to find just because the deleted profile
        # happened to be the active one — hand activity to whichever
        # remaining profile was edited most recently.
        remaining = (
            session.query(ModelProfile)
            .filter_by(user_id=user_id)
            .order_by(ModelProfile.updated_at.desc())
            .first()
        )
        if remaining is not None:
            remaining.is_active = True
            session.flush()
