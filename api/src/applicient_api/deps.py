"""FastAPI dependencies. M5 — current_user_id now resolves a real
signed-in user from a bearer token instead of a hardcoded demo lookup;
this was the one seam the placeholder version's own docstring already
promised auth would plug into without touching every route."""

from __future__ import annotations

import uuid
from collections.abc import Generator

from fastapi import Depends, Header, HTTPException
from sqlalchemy.orm import Session, sessionmaker

from applicient_api.auth import AuthError, decode_access_token
from applicient_api.db import make_engine, make_session_factory
from applicient_api.models.profile import User

_engine = make_engine()
_session_factory: sessionmaker = make_session_factory(_engine)


def get_session_factory() -> sessionmaker:
    return _session_factory


def get_db() -> Generator[Session, None, None]:
    session = _session_factory()
    try:
        yield session
    finally:
        session.close()


def current_user_id(
    authorization: str | None = Header(default=None), token: str | None = None
) -> uuid.UUID:
    """Every route that needs a user takes this — swapping the
    identity source is one function, not N call sites.

    Accepts the token either as a normal `Authorization: Bearer` header
    (every real fetch call) or as a `?token=` query param — the one
    exception is `<img src>` for the live-browser screenshot view
    (pipeline/page.tsx), which the browser fetches directly and can't
    attach a custom header to."""

    raw = None
    if authorization and authorization.startswith("Bearer "):
        raw = authorization.removeprefix("Bearer ").strip()
    elif token:
        raw = token
    if not raw:
        raise HTTPException(401, "not authenticated")
    try:
        return decode_access_token(raw)
    except AuthError:
        raise HTTPException(401, "not authenticated")


def current_admin_user(
    user_id: uuid.UUID = Depends(current_user_id), db: Session = Depends(get_db)
) -> uuid.UUID:
    """SaaS pivot — gates the admin-only surfaces (provider connections,
    model profiles, cost/usage). A DB lookup, not a JWT `role` claim:
    tokens are 7-day/no-refresh, so a claim baked into the token would
    go stale if a role changed mid-session; this always reads the
    current row. First (and, deliberately, only) second-layer auth
    dependency in this codebase — every other route only ever checks
    "is this a valid token," not "is this specific user allowed here."
    """

    user = db.query(User).filter_by(id=user_id).one_or_none()
    if user is None or user.role != "admin":
        raise HTTPException(403, "admin access required")
    return user_id
