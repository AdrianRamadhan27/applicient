"""M5 — real email+password signup/login, replacing the hardcoded
demo-user lookup `current_user_id` used to do. No `/auth/logout`:
bearer tokens are dropped client-side; no server-side revocation list
for this pass (short-lived 7-day tokens, no refresh).

SaaS pivot — signup() also bootstraps the admin role (ADMIN_EMAIL env
var, checked case-insensitively; no self-service path to admin exists
anywhere else) and provisions every new user onto the cheapest active
Plan (the free tier, by convention price_idr == 0 — see billing_service
for the same lookup used at upgrade time)."""

import os
import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from applicient_api import pipeline_stage_service, schemas
from applicient_api.auth import create_access_token, hash_password, verify_password
from applicient_api.billing_service import default_plan
from applicient_api.deps import current_user_id, get_db
from applicient_api.models.billing import Subscription
from applicient_api.models.profile import User

router = APIRouter(prefix="/auth", tags=["auth"])


@router.post("/signup", response_model=schemas.TokenOut, status_code=201)
def signup(body: schemas.SignupIn, db: Session = Depends(get_db)):
    email = body.email.strip().lower()
    if db.query(User).filter_by(email=email).one_or_none() is not None:
        raise HTTPException(409, "an account with this email already exists")
    admin_email = os.environ.get("ADMIN_EMAIL", "").strip().lower()
    role = "admin" if admin_email and email == admin_email else "user"
    user = User(email=email, password_hash=hash_password(body.password), role=role)
    db.add(user)
    db.commit()
    db.refresh(user)
    pipeline_stage_service.provision_default_stages(db, user_id=user.id)
    plan = default_plan(db)
    if plan is not None:
        db.add(Subscription(user_id=user.id, plan_id=plan.id, status="active"))
    db.commit()
    return schemas.TokenOut(access_token=create_access_token(user.id), user=user)


@router.post("/login", response_model=schemas.TokenOut)
def login(body: schemas.LoginIn, db: Session = Depends(get_db)):
    email = body.email.strip().lower()
    user = db.query(User).filter_by(email=email).one_or_none()
    if user is None or user.password_hash is None or not verify_password(body.password, user.password_hash):
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
