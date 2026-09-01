"""SaaS pivot — the back-office surface: a cross-tenant user list (the
thing routers/cost.py's admin-gated-but-still-per-caller endpoints
deliberately don't give an admin) and Plan CRUD so pricing/caps are
editable without a deploy. Every route here requires
`current_admin_user`."""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from applicient_api import schemas
from applicient_api.billing_service import current_period_spend_usd
from applicient_api.deps import current_admin_user, get_db
from applicient_api.models.billing import Plan, Subscription
from applicient_api.models.profile import User

router = APIRouter(prefix="/admin", tags=["admin"])


@router.get("/users", response_model=list[schemas.AdminUserOut])
def list_users(db: Session = Depends(get_db), _admin_id: uuid.UUID = Depends(current_admin_user)):
    users = db.query(User).order_by(User.created_at.desc()).all()
    subs_by_user = {s.user_id: s for s in db.query(Subscription).all()}
    plan_by_id = {p.id: p for p in db.query(Plan).all()}

    out = []
    for u in users:
        sub = subs_by_user.get(u.id)
        plan = plan_by_id.get(sub.plan_id) if sub else None
        spend = current_period_spend_usd(db, user_id=u.id, subscription=sub)
        out.append(
            schemas.AdminUserOut(
                id=u.id,
                email=u.email,
                role=u.role,
                is_active=u.is_active,
                created_at=u.created_at,
                plan_name=plan.name if plan else None,
                subscription_status=sub.status if sub else None,
                current_period_spend_usd=float(spend or 0),
            )
        )
    return out


@router.post("/users/{user_id}/suspend", response_model=schemas.AdminUserOut)
def suspend_user(user_id: uuid.UUID, db: Session = Depends(get_db), admin_id: uuid.UUID = Depends(current_admin_user)):
    return _set_active(db, user_id=user_id, admin_id=admin_id, is_active=False)


@router.post("/users/{user_id}/unsuspend", response_model=schemas.AdminUserOut)
def unsuspend_user(user_id: uuid.UUID, db: Session = Depends(get_db), admin_id: uuid.UUID = Depends(current_admin_user)):
    return _set_active(db, user_id=user_id, admin_id=admin_id, is_active=True)


def _set_active(db: Session, *, user_id: uuid.UUID, admin_id: uuid.UUID, is_active: bool) -> schemas.AdminUserOut:
    if user_id == admin_id and not is_active:
        raise HTTPException(422, "cannot suspend your own account")
    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(404, "user not found")
    user.is_active = is_active
    db.commit()
    return _admin_user_out(db, user)


@router.post("/users/{user_id}/promote", response_model=schemas.AdminUserOut)
def promote_user(user_id: uuid.UUID, db: Session = Depends(get_db), _admin_id: uuid.UUID = Depends(current_admin_user)):
    return _set_role(db, user_id=user_id, role="admin")


@router.post("/users/{user_id}/demote", response_model=schemas.AdminUserOut)
def demote_user(user_id: uuid.UUID, db: Session = Depends(get_db), admin_id: uuid.UUID = Depends(current_admin_user)):
    if user_id == admin_id:
        raise HTTPException(422, "cannot demote your own account")
    return _set_role(db, user_id=user_id, role="user")


def _set_role(db: Session, *, user_id: uuid.UUID, role: str) -> schemas.AdminUserOut:
    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(404, "user not found")
    user.role = role
    db.commit()
    return _admin_user_out(db, user)


def _admin_user_out(db: Session, user: User) -> schemas.AdminUserOut:
    sub = db.query(Subscription).filter_by(user_id=user.id).one_or_none()
    plan = db.get(Plan, sub.plan_id) if sub else None
    spend = current_period_spend_usd(db, user_id=user.id, subscription=sub)
    return schemas.AdminUserOut(
        id=user.id,
        email=user.email,
        role=user.role,
        is_active=user.is_active,
        created_at=user.created_at,
        plan_name=plan.name if plan else None,
        subscription_status=sub.status if sub else None,
        current_period_spend_usd=float(spend or 0),
    )


@router.get("/plans", response_model=list[schemas.PlanOut])
def list_plans(db: Session = Depends(get_db), _admin_id: uuid.UUID = Depends(current_admin_user)):
    return db.query(Plan).order_by(Plan.price_idr.asc()).all()


@router.post("/plans", response_model=schemas.PlanOut, status_code=201)
def create_plan(body: schemas.PlanCreate, db: Session = Depends(get_db), _admin_id: uuid.UUID = Depends(current_admin_user)):
    plan = Plan(
        name=body.name.strip(),
        price_idr=body.price_idr,
        monthly_usage_cap_usd=body.monthly_usage_cap_usd,
        is_active=body.is_active,
    )
    db.add(plan)
    db.commit()
    db.refresh(plan)
    return plan


@router.patch("/plans/{plan_id}", response_model=schemas.PlanOut)
def update_plan(
    plan_id: uuid.UUID,
    body: schemas.PlanUpdate,
    db: Session = Depends(get_db),
    _admin_id: uuid.UUID = Depends(current_admin_user),
):
    plan = db.get(Plan, plan_id)
    if plan is None:
        raise HTTPException(404, "plan not found")
    for field, value in body.model_dump(exclude_unset=True).items():
        setattr(plan, field, value)
    db.commit()
    db.refresh(plan)
    return plan
