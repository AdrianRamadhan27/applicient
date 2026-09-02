"""M5 — real email+password signup/login, replacing the hardcoded
demo-user lookup `current_user_id` used to do. No `/auth/logout`:
bearer tokens are dropped client-side; no server-side revocation list
for this pass (short-lived 7-day tokens, no refresh).

SaaS pivot — signup() also bootstraps the admin role (ADMIN_EMAIL env
var, checked case-insensitively; no self-service path to admin exists
anywhere else) and provisions every new user onto the cheapest active
Plan (the free tier, by convention price_idr == 0 — see billing_service
for the same lookup used at upgrade time).

v2 Phase 1 — email verification reuses create_access_token/
decode_access_token with a 24h TTL as the verification link's token,
same trick gmail.py's OAuth `state` param already uses — no separate
token table. Verification is NOT a login gate (see login()) — a
support-burden judgment call, not an oversight; unverified users can
still use the app, just see a resend-verification banner. Google login
(google_login/google_callback) is a separate flow from Gmail's connect
OAuth — see google_auth_service.py's own docstring for why it isn't a
reuse of that one."""

import os
import secrets
import uuid
from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import RedirectResponse
from sqlalchemy.orm import Session

from applicient_api import email_service, google_auth_service, pipeline_stage_service, schemas
from applicient_api.auth import AuthError, create_access_token, decode_access_token, hash_password, verify_password
from applicient_api.billing_service import default_plan
from applicient_api.deps import current_user_id, get_db
from applicient_api.models.billing import Subscription
from applicient_api.models.profile import User

router = APIRouter(prefix="/auth", tags=["auth"])

_VERIFY_TOKEN_TTL = timedelta(hours=24)


def _api_base_url() -> str:
    return os.environ.get("API_BASE_URL") or "http://localhost:8000"


def _frontend_url() -> str:
    return os.environ.get("FRONTEND_URL") or "http://localhost:3000"


async def _send_verification_email(user: User) -> None:
    verify_token = create_access_token(user.id, expires_delta=_VERIFY_TOKEN_TTL)
    verify_url = f"{_api_base_url()}/auth/verify-email?token={verify_token}"
    try:
        await email_service.send_verification_email(to=user.email, verify_url=verify_url)
    except (RuntimeError, email_service.EmailSendError):
        # Don't fail signup/resend over a flaky email provider or a
        # not-yet-configured RESEND_API_KEY — verification isn't a
        # login gate, so there's nothing to block here either way.
        pass


def _provision_new_user(db: Session, user: User) -> None:
    """Shared onboarding for a brand-new row, whichever signup path
    created it (password or Google) — same steps signup() always did."""
    pipeline_stage_service.provision_default_stages(db, user_id=user.id)
    plan = default_plan(db)
    if plan is not None:
        db.add(Subscription(user_id=user.id, plan_id=plan.id, status="active"))


@router.post("/signup", response_model=schemas.TokenOut, status_code=201)
async def signup(body: schemas.SignupIn, db: Session = Depends(get_db)):
    email = body.email.strip().lower()
    if db.query(User).filter_by(email=email).one_or_none() is not None:
        raise HTTPException(409, "an account with this email already exists")
    admin_email = os.environ.get("ADMIN_EMAIL", "").strip().lower()
    role = "admin" if admin_email and email == admin_email else "user"
    user = User(email=email, password_hash=hash_password(body.password), role=role)
    db.add(user)
    db.commit()
    db.refresh(user)
    _provision_new_user(db, user)
    db.commit()
    await _send_verification_email(user)
    return schemas.TokenOut(access_token=create_access_token(user.id), user=user)


@router.post("/login", response_model=schemas.TokenOut)
def login(body: schemas.LoginIn, db: Session = Depends(get_db)):
    email = body.email.strip().lower()
    user = db.query(User).filter_by(email=email).one_or_none()
    if user is not None and user.password_hash is None:
        raise HTTPException(401, 'this account uses Google sign-in — use "Continue with Google" instead')
    if user is None or not verify_password(body.password, user.password_hash):
        raise HTTPException(401, "incorrect email or password")
    if not user.is_active:
        raise HTTPException(403, "this account has been suspended")
    return schemas.TokenOut(access_token=create_access_token(user.id), user=user)


@router.get("/me", response_model=schemas.UserOut)
def me(db: Session = Depends(get_db), user_id: uuid.UUID = Depends(current_user_id)):
    user = db.query(User).filter_by(id=user_id).one_or_none()
    if user is None:
        raise HTTPException(404, "user not found")
    return user


@router.get("/verify-email")
def verify_email(token: str, db: Session = Depends(get_db)):
    try:
        user_id = decode_access_token(token)
    except AuthError:
        raise HTTPException(400, "invalid or expired verification link")
    user = db.query(User).filter_by(id=user_id).one_or_none()
    if user is None:
        raise HTTPException(404, "user not found")
    user.email_verified = True
    db.commit()
    return RedirectResponse(f"{_frontend_url()}/login?verified=1")


@router.post("/resend-verification", status_code=204)
async def resend_verification(db: Session = Depends(get_db), user_id: uuid.UUID = Depends(current_user_id)):
    user = db.query(User).filter_by(id=user_id).one_or_none()
    if user is None:
        raise HTTPException(404, "user not found")
    if user.email_verified:
        return
    await _send_verification_email(user)


@router.get("/google/login")
def google_login():
    state = secrets.token_urlsafe(24)
    try:
        url = google_auth_service.build_authorize_url(state)
    except RuntimeError as exc:
        raise HTTPException(503, f"Google sign-in is not configured: {exc}")
    return RedirectResponse(url)


@router.get("/google/callback")
async def google_callback(code: str, db: Session = Depends(get_db)):
    tokens = await google_auth_service.exchange_code(code)
    profile = await google_auth_service.fetch_google_profile(tokens["access_token"])
    google_id = profile["id"]
    email = profile["email"].strip().lower()

    user = db.query(User).filter_by(google_id=google_id).one_or_none()
    if user is None:
        user = db.query(User).filter_by(email=email).one_or_none()
        if user is not None:
            # Existing password account — link this Google identity to
            # it rather than creating a second row for the same person.
            user.google_id = google_id
            user.email_verified = True
        else:
            admin_email = os.environ.get("ADMIN_EMAIL", "").strip().lower()
            role = "admin" if admin_email and email == admin_email else "user"
            user = User(email=email, google_id=google_id, email_verified=True, role=role)
            db.add(user)
            db.flush()
            _provision_new_user(db, user)
    if not user.is_active:
        raise HTTPException(403, "this account has been suspended")
    db.commit()

    access_token = create_access_token(user.id)
    return RedirectResponse(f"{_frontend_url()}/auth/google/callback?token={access_token}")
