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
token table.

Adrian, direct: verification MUST happen before a new account can sign
in — reversing this module's original "not a login gate" design.
signup() no longer returns a usable access_token (schemas.SignupOut is
just the email — see its own docstring); login() rejects an unverified
account with a 403 instead of letting it through; resend-verification
is now unauthenticated (by email, rate-limited by
rate_limit.check_rate_limit keyed on the email itself) since a
just-signed-up user has no token to authenticate with anymore. Google
login (google_login/google_callback) already sets email_verified=True
unconditionally (Google already proved the email) so this gate never
applies to that path — a Google user's very first login already
succeeds normally."""

import os
import secrets
import uuid
from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import RedirectResponse
from sqlalchemy.orm import Session

from applicient_api import credit_ledger, email_service, google_auth_service, pipeline_stage_service, schemas
from applicient_api.auth import (
    AuthError,
    create_access_token,
    create_password_reset_token,
    decode_access_token,
    decode_password_reset_token,
    hash_password,
    password_fingerprint,
    verify_password,
)
from applicient_api.billing_service import default_plan
from applicient_api.deps import current_user_id, get_db
from applicient_api.models.billing import Subscription
from applicient_api.models.profile import User
from applicient_api.rate_limit import check_rate_limit, rate_limit

router = APIRouter(prefix="/auth", tags=["auth"])

_VERIFY_TOKEN_TTL = timedelta(hours=24)
# Matches the frontend's own client-side cooldown timer (raised
# directly by Adrian) — this is the real enforcement, the frontend
# timer is just UX; a resend attempt inside the cooldown either way
# gets a 429 with Retry-After, never a silent no-op.
_RESEND_LIMIT = 1
_RESEND_WINDOW_SECONDS = 60
# Same cooldown shape as resend-verification above, keyed by email
# instead of a logged-in user (forgot-password is necessarily
# unauthenticated too).
_FORGOT_PASSWORD_LIMIT = 1
_FORGOT_PASSWORD_WINDOW_SECONDS = 60


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


async def _send_password_reset_email(user: User) -> None:
    # Only ever called with password_hash already known non-None (both
    # call sites check first) — a Google-only account has no password
    # to reset, and create_password_reset_token needs a real hash to
    # fingerprint.
    reset_token = create_password_reset_token(user.id, password_hash=user.password_hash)
    reset_url = f"{_frontend_url()}/reset-password?token={reset_token}"
    try:
        await email_service.send_password_reset_email(to=user.email, reset_url=reset_url)
    except (RuntimeError, email_service.EmailSendError):
        pass


async def _send_password_changed_email(user: User) -> None:
    try:
        await email_service.send_password_changed_email(
            to=user.email, forgot_password_url=f"{_frontend_url()}/forgot-password"
        )
    except (RuntimeError, email_service.EmailSendError):
        pass


def _provision_new_user(db: Session, user: User) -> None:
    """Shared onboarding for a brand-new row, whichever signup path
    created it (password or Google) — same steps signup() always did."""
    pipeline_stage_service.provision_default_stages(db, user_id=user.id)
    plan = default_plan(db)
    if plan is not None:
        db.add(Subscription(user_id=user.id, plan_id=plan.id, status="active"))
        # One-time starting grant — for the Free plan this is the ONLY
        # grant this user's account will ever get (see
        # credit_ledger.grant_monthly_credits' own docstring for why
        # that's true without a special case there: nothing else ever
        # calls it again for an account with no real Dodo subscription
        # behind it).
        credit_ledger.grant_monthly_credits(db, user_id=user.id, plan=plan)


@router.post("/signup", response_model=schemas.SignupOut, status_code=201)
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
    # No access_token — the account exists but can't sign in yet (see
    # login() below). The frontend takes this response straight to the
    # "check your email" waiting page, never to /console.
    return schemas.SignupOut(email=user.email)


@router.post("/login", response_model=schemas.TokenOut)
def login(body: schemas.LoginIn, db: Session = Depends(get_db)):
    email = body.email.strip().lower()
    user = db.query(User).filter_by(email=email).one_or_none()
    if user is not None and user.password_hash is None:
        raise HTTPException(401, 'this account uses Google sign-in — use "Continue with Google" instead')
    if user is None or not verify_password(body.password, user.password_hash):
        raise HTTPException(401, "incorrect email or password")
    if not user.email_verified:
        raise HTTPException(403, "please verify your email before signing in — check your inbox for the verification link")
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
async def resend_verification(body: schemas.ResendVerificationIn, db: Session = Depends(get_db)):
    """Unauthenticated by necessity — a just-signed-up user waiting on
    the "check your email" page has no access_token to authenticate
    with anymore (signup() stopped issuing one). Keyed and rate-limited
    by the email address itself rather than a user_id; always returns
    204 regardless of whether the address is registered/already
    verified/Google-only, so this can't be used to enumerate accounts."""

    email = body.email.strip().lower()
    check_rate_limit(
        f"resend-verification:{email}", limit=_RESEND_LIMIT, window_seconds=_RESEND_WINDOW_SECONDS
    )
    user = db.query(User).filter_by(email=email).one_or_none()
    if user is not None and not user.email_verified and user.password_hash is not None:
        await _send_verification_email(user)


@router.post("/forgot-password", status_code=204)
async def forgot_password(body: schemas.ForgotPasswordIn, db: Session = Depends(get_db)):
    """Adrian, direct: "Need to add forgot password in sign in... on
    forgot password there must be an email to verify the password
    change." Unauthenticated by necessity — same anti-enumeration shape
    as resend_verification above: always 204 whether or not the
    address is registered/Google-only, rate-limited by the email
    itself, never reveals which case it was."""

    email = body.email.strip().lower()
    check_rate_limit(
        f"forgot-password:{email}", limit=_FORGOT_PASSWORD_LIMIT, window_seconds=_FORGOT_PASSWORD_WINDOW_SECONDS
    )
    user = db.query(User).filter_by(email=email).one_or_none()
    if user is not None and user.password_hash is not None:
        await _send_password_reset_email(user)


@router.post("/reset-password", status_code=204)
async def reset_password(body: schemas.ResetPasswordIn, db: Session = Depends(get_db)):
    """The link _send_password_reset_email above emailed out lands the
    frontend on a real form (new password), which POSTs here. The
    token's embedded password fingerprint (auth.py's own
    password_fingerprint) is checked against the user's CURRENT
    password_hash — not just decoded — so a reset link stops working
    the moment the password actually changes by any means (including a
    second, later reset), without needing a revocation table."""

    try:
        user_id, token_fingerprint = decode_password_reset_token(body.token)
    except AuthError:
        raise HTTPException(400, "this reset link is invalid or has expired — request a new one")
    user = db.query(User).filter_by(id=user_id).one_or_none()
    if user is None or user.password_hash is None:
        raise HTTPException(400, "this reset link is invalid or has expired — request a new one")
    if token_fingerprint != password_fingerprint(user.password_hash):
        raise HTTPException(400, "this reset link has already been used — request a new one")
    user.password_hash = hash_password(body.new_password)
    db.commit()
    await _send_password_changed_email(user)


@router.post(
    "/change-password",
    status_code=204,
    dependencies=[Depends(rate_limit("change-password", limit=5, window_seconds=300))],
)
async def change_password(
    body: schemas.ChangePasswordIn, db: Session = Depends(get_db), user_id: uuid.UUID = Depends(current_user_id)
):
    """Adrian, direct: "Need to add change password in the profile."
    Authenticated, unlike reset-password above (this account can
    already prove who it is via its bearer token) — so the real check
    here is the CURRENT password, not a fingerprinted email link.
    A Google-only account (password_hash is None) has nothing to
    verify against — this becomes "set a password" for it instead of
    "change," the one case current_password is allowed to be omitted."""

    user = db.query(User).filter_by(id=user_id).one_or_none()
    if user is None:
        raise HTTPException(404, "user not found")
    if user.password_hash is not None:
        if not body.current_password or not verify_password(body.current_password, user.password_hash):
            raise HTTPException(401, "current password is incorrect")
    user.password_hash = hash_password(body.new_password)
    db.commit()
    await _send_password_changed_email(user)


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
