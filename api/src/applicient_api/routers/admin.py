"""SaaS pivot — the back-office surface: a cross-tenant user list (the
thing routers/cost.py's admin-gated-but-still-per-caller endpoints
deliberately don't give an admin) and Plan CRUD so pricing/caps are
editable without a deploy. Every route here requires
`current_admin_user`."""

from __future__ import annotations

import os
import uuid

import httpx
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from applicient_api import schemas
from applicient_api.billing_service import (
    DodoError,
    current_period_spend_usd,
    ensure_product_for_pack,
    ensure_product_for_plan,
    pack_product_id,
    plan_product_id,
    sync_product_for_pack,
    sync_product_for_plan,
)
from applicient_api.credit_ledger import admin_adjust_credits, get_balance
from applicient_api.deps import current_admin_user, get_db
from applicient_api.models.billing import CreditPack, FeatureCreditCost, Plan, Subscription
from applicient_api.models.profile import User

router = APIRouter(prefix="/admin", tags=["admin"])


def _browser_worker_url() -> str:
    return os.environ.get("BROWSER_WORKER_URL", "http://localhost:8100").rstrip("/")


# Adrian, direct: hit "2 concurrent browser sessions already open" in
# production and asked for an admin page to monitor + kill sessions.
# browser-worker has no auth of its own (reachable only from inside the
# compose network — see its own docstrings), so these routes are the
# real auth boundary: current_admin_user gates them, then they're a
# thin proxy onto browser-worker's own GET/DELETE /sessions (added
# alongside this same request — see browser_worker/sessions.py).
@router.get("/browser-sessions")
async def list_browser_sessions(_admin_id: uuid.UUID = Depends(current_admin_user)):
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.get(f"{_browser_worker_url()}/sessions")
        r.raise_for_status()
    except httpx.HTTPError as exc:
        raise HTTPException(502, f"could not reach browser-worker: {exc}")
    return r.json()


@router.delete("/browser-sessions/{session_id}")
async def kill_browser_session(session_id: str, _admin_id: uuid.UUID = Depends(current_admin_user)):
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            r = await client.delete(f"{_browser_worker_url()}/sessions/{session_id}")
    except httpx.HTTPError as exc:
        raise HTTPException(502, f"could not reach browser-worker: {exc}")
    if r.status_code == 404:
        raise HTTPException(404, "session not found — it may have already closed on its own")
    if r.is_error:
        raise HTTPException(502, f"browser-worker rejected the close request: {r.text}")
    return {"closed": session_id}


@router.delete("/browser-sessions")
async def kill_all_browser_sessions(_admin_id: uuid.UUID = Depends(current_admin_user)):
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            r = await client.delete(f"{_browser_worker_url()}/sessions")
        r.raise_for_status()
    except httpx.HTTPError as exc:
        raise HTTPException(502, f"could not reach browser-worker: {exc}")
    return r.json()


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
                credits_total=get_balance(db, user_id=u.id)["total"],
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
        credits_total=get_balance(db, user_id=user.id)["total"],
    )


@router.get("/plans", response_model=list[schemas.AdminPlanOut])
def list_plans(db: Session = Depends(get_db), _admin_id: uuid.UUID = Depends(current_admin_user)):
    return db.query(Plan).order_by(Plan.price_idr.asc()).all()


@router.post("/plans", response_model=schemas.AdminPlanOut, status_code=201)
async def create_plan(
    body: schemas.PlanCreate, db: Session = Depends(get_db), _admin_id: uuid.UUID = Depends(current_admin_user)
):
    plan = Plan(
        name=body.name.strip(),
        price_idr=body.price_idr,
        monthly_credits=body.monthly_credits,
        is_active=body.is_active,
        # Lets an admin attach an already-existing Dodo product (e.g.
        # one created by hand in the dashboard) instead of always
        # auto-creating a new one below — ensure_product_for_plan is a
        # no-op once either of these is already set.
        dodo_product_id_test=body.dodo_product_id_test,
        dodo_product_id_live=body.dodo_product_id_live,
    )
    db.add(plan)
    db.commit()
    db.refresh(plan)
    # "Product creation into the setup" — a paid plan gets its Dodo
    # Product created right away rather than waiting for the first
    # checkout to trigger it lazily (ensure_product_for_plan is
    # idempotent either way, so this is purely for immediate feedback
    # if Dodo rejects it, not a correctness requirement).
    try:
        await ensure_product_for_plan(db, plan)
    except DodoError as exc:
        raise HTTPException(502, f"plan saved, but its Dodo product could not be created: {exc}")
    return plan


@router.patch("/plans/{plan_id}", response_model=schemas.AdminPlanOut)
async def update_plan(
    plan_id: uuid.UUID,
    body: schemas.PlanUpdate,
    db: Session = Depends(get_db),
    _admin_id: uuid.UUID = Depends(current_admin_user),
):
    plan = db.get(Plan, plan_id)
    if plan is None:
        raise HTTPException(404, "plan not found")
    changed = body.model_dump(exclude_unset=True)
    for field, value in changed.items():
        setattr(plan, field, value)
    db.commit()
    db.refresh(plan)

    # Keep Dodo's own product in sync rather than letting it silently
    # drift from what this row now says — a still-free plan that just
    # got a real price needs a product created for the first time; an
    # already-paid plan whose name/price changed gets that product
    # patched in place (confirmed live: both are patchable, only the
    # pricing model itself is immutable).
    if "name" in changed or "price_idr" in changed:
        try:
            if plan_product_id(plan):
                await sync_product_for_plan(db, plan)
            else:
                await ensure_product_for_plan(db, plan)
        except DodoError as exc:
            raise HTTPException(502, f"plan saved, but its Dodo product could not be updated: {exc}")
    return plan


# --- Phase 16 — feature credit costs (admin-tunable, see
# credit_ledger.py's own docstring for why these are a fixed price per
# feature, decoupled from real per-call $ cost). ---


@router.get("/feature-costs", response_model=list[schemas.FeatureCreditCostOut])
def list_feature_costs(db: Session = Depends(get_db), _admin_id: uuid.UUID = Depends(current_admin_user)):
    return db.query(FeatureCreditCost).order_by(FeatureCreditCost.key.asc()).all()


@router.patch("/feature-costs/{feature_cost_id}", response_model=schemas.FeatureCreditCostOut)
def update_feature_cost(
    feature_cost_id: uuid.UUID,
    body: schemas.FeatureCreditCostUpdate,
    db: Session = Depends(get_db),
    _admin_id: uuid.UUID = Depends(current_admin_user),
):
    row = db.get(FeatureCreditCost, feature_cost_id)
    if row is None:
        raise HTTPException(404, "feature cost not found")
    for field, value in body.model_dump(exclude_unset=True).items():
        setattr(row, field, value)
    db.commit()
    db.refresh(row)
    return row


# --- Phase 16 — credit packs (standalone, one-time purchases). Same
# CRUD + Dodo-product-sync shape as Plan above, just a one-time price
# instead of recurring (billing_service.ensure_product_for_pack/
# sync_product_for_pack). ---


@router.get("/credit-packs", response_model=list[schemas.AdminCreditPackOut])
def list_credit_packs_admin(db: Session = Depends(get_db), _admin_id: uuid.UUID = Depends(current_admin_user)):
    return db.query(CreditPack).order_by(CreditPack.price_idr.asc()).all()


@router.post("/credit-packs", response_model=schemas.AdminCreditPackOut, status_code=201)
async def create_credit_pack(
    body: schemas.CreditPackCreate, db: Session = Depends(get_db), _admin_id: uuid.UUID = Depends(current_admin_user)
):
    pack = CreditPack(
        name=body.name.strip(),
        price_idr=body.price_idr,
        credits=body.credits,
        is_active=body.is_active,
        dodo_product_id_test=body.dodo_product_id_test,
        dodo_product_id_live=body.dodo_product_id_live,
    )
    db.add(pack)
    db.commit()
    db.refresh(pack)
    try:
        await ensure_product_for_pack(db, pack)
    except DodoError as exc:
        raise HTTPException(502, f"credit pack saved, but its Dodo product could not be created: {exc}")
    return pack


@router.patch("/credit-packs/{pack_id}", response_model=schemas.AdminCreditPackOut)
async def update_credit_pack(
    pack_id: uuid.UUID,
    body: schemas.CreditPackUpdate,
    db: Session = Depends(get_db),
    _admin_id: uuid.UUID = Depends(current_admin_user),
):
    pack = db.get(CreditPack, pack_id)
    if pack is None:
        raise HTTPException(404, "credit pack not found")
    changed = body.model_dump(exclude_unset=True)
    for field, value in changed.items():
        setattr(pack, field, value)
    db.commit()
    db.refresh(pack)

    if "name" in changed or "price_idr" in changed:
        try:
            if pack_product_id(pack):
                await sync_product_for_pack(db, pack)
            else:
                await ensure_product_for_pack(db, pack)
        except DodoError as exc:
            raise HTTPException(502, f"credit pack saved, but its Dodo product could not be updated: {exc}")
    return pack


# --- Phase 16 — admin grant/subtract credits. Transaction-based, not a
# value edit (raised directly by Adrian): the only effect this endpoint
# has is a new CreditTransaction row via admin_adjust_credits, which is
# what makes it show up in the user's own history as "Granted by
# admin"/"Deducted by admin" with the reason attached — there is no
# balance column here to PATCH instead. ---


@router.post("/users/{user_id}/credits/adjust", response_model=schemas.CreditTransactionOut)
def adjust_user_credits(
    user_id: uuid.UUID,
    body: schemas.CreditAdjustIn,
    db: Session = Depends(get_db),
    admin_id: uuid.UUID = Depends(current_admin_user),
):
    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(404, "user not found")
    return admin_adjust_credits(db, user_id=user_id, admin_user_id=admin_id, amount=body.amount, reason=body.reason.strip())
