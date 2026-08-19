"""Dev seed data: one demo user + an empty, unconfirmed profile shell.

Idempotent — safe to run more than once. Not a migration: this is
throwaway local-dev convenience data, not schema, so it lives outside
Alembic's history (PRD's "clone and run in under 10 minutes" needs a
demo user to exist, but doesn't need it version-controlled as DDL).

Usage: uv run python -m applicient_api.seed
"""

from applicient_api.db import make_engine, make_session_factory
from applicient_api.models.profile import Profile, User

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

        profile = session.query(Profile).filter_by(user_id=user.id).one_or_none()
        if profile is None:
            profile = Profile(user_id=user.id, revision=1, confirmed=False)
            session.add(profile)
            session.flush()
            print(f"created empty profile shell {profile.id} (unconfirmed)")
        else:
            print(f"profile already exists: {profile.id} (confirmed={profile.confirmed})")

        session.commit()


if __name__ == "__main__":
    seed()
