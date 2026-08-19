"""FastAPI dependencies. No auth yet — v1 is single-user/local-first
(PRD §3.1) — but `current_user_id` is the one seam where an auth layer
plugs in later without touching every route."""

from __future__ import annotations

import uuid
from collections.abc import Generator

from fastapi import Depends
from sqlalchemy.orm import Session, sessionmaker

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


def current_user_id(db: Session = Depends(get_db)) -> uuid.UUID:
    """Placeholder for auth (PRD §2.2 non-goal for v1, §3.1 single-user
    local-first): resolves to the one demo user rather than a real
    identity. Every route that needs a user takes this, so swapping in
    real auth later is one function, not N call sites."""

    user = db.query(User).filter_by(email="demo@applicient.local").one()
    return user.id
