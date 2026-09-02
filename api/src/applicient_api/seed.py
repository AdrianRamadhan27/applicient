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

M5 — real auth means the demo user needs a real password to log in
with. DEMO_USER_PASSWORD is dev-only convenience, loudly not meant for
anything deployed; if a demo user already exists without a password
(pre-M5 row), this backfills one on the next seed run rather than
leaving it permanently unable to log in.

Usage: uv run python -m applicient_api.seed
"""

import os

from applicient_api.auth import hash_password
from applicient_api.billing_service import default_plan
from applicient_api.db import make_engine, make_session_factory
from applicient_api.models.billing import Subscription
from applicient_api.models.profile import User
from applicient_api.pipeline_stage_service import provision_default_stages

DEMO_EMAIL = "demo@applicient.local"
DEMO_USER_PASSWORD = os.environ.get("DEMO_USER_PASSWORD", "applicient-dev")


def seed() -> None:
    engine = make_engine()
    Session = make_session_factory(engine)
    admin_email = os.environ.get("ADMIN_EMAIL", "").strip().lower()

    with Session() as session:
        user = session.query(User).filter_by(email=DEMO_EMAIL).one_or_none()
        if user is None:
            role = "admin" if admin_email and DEMO_EMAIL == admin_email else "user"
            # email_verified=True — this account bypasses signup()'s real
            # verification-email flow entirely (constructed directly, not
            # via the endpoint), so leaving it False would show a
            # perpetual "verify your email" banner for a dev-only seed.
            user = User(
                email=DEMO_EMAIL, password_hash=hash_password(DEMO_USER_PASSWORD), role=role, email_verified=True
            )
            session.add(user)
            session.flush()  # populate user.id via server_default before use below
            print(f"created user {user.id} ({user.email}, role={role}) — dev password from DEMO_USER_PASSWORD")
        else:
            print(f"user already exists: {user.id} ({user.email})")
            if user.password_hash is None:
                user.password_hash = hash_password(DEMO_USER_PASSWORD)
                print("  backfilled password_hash from DEMO_USER_PASSWORD")
            if admin_email and DEMO_EMAIL == admin_email and user.role != "admin":
                user.role = "admin"
                print("  promoted to admin (matches ADMIN_EMAIL)")

        session.flush()
        provision_default_stages(session, user_id=user.id)
        if session.query(Subscription).filter_by(user_id=user.id).one_or_none() is None:
            plan = default_plan(session)
            if plan is not None:
                session.add(Subscription(user_id=user.id, plan_id=plan.id, status="active"))
                print(f"  subscribed to plan {plan.name!r}")
        session.commit()


if __name__ == "__main__":
    seed()
