"""Dev seed data: one demo user.

Idempotent — safe to run more than once. Not a migration: this is
throwaway local-dev convenience data, not schema, so it lives outside
Alembic's history (PRD's "clone and run in under 10 minutes" needs a
demo user to exist, but doesn't need it version-controlled as DDL).

No profile shell is bootstrapped here anymore — every persona owns its
own `Profile` exclusively now (`Persona.profile_id`, `unique=True`),
created fresh alongside it by `routers/personas.py`'s `create_persona`.
A standalone profile with no owning persona doesn't fit that model, so
creating the user's first persona (from the app itself) is what
provisions their first profile too.

Usage: uv run python -m applicient_api.seed
"""

from applicient_api.db import make_engine, make_session_factory
from applicient_api.models.profile import User

DEMO_EMAIL = "demo@applicient.local"


def seed() -> None:
    engine = make_engine()
    Session = make_session_factory(engine)

    with Session() as session:
        user = session.query(User).filter_by(email=DEMO_EMAIL).one_or_none()
        if user is None:
            user = User(email=DEMO_EMAIL)
            session.add(user)
            session.flush()  # populate user.id via server_default before use below
            print(f"created user {user.id} ({user.email})")
        else:
            print(f"user already exists: {user.id} ({user.email})")

        session.commit()


if __name__ == "__main__":
    seed()
