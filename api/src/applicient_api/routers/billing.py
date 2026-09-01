"""SaaS pivot — the regular-user-facing billing surface: see available
plans, see your own current plan/usage, start a Xendit checkout,
manually trigger a re-sync after returning from the hosted checkout
page (billing_service.py's own docstring explains why polling, not the
webhook, is the authoritative path this pass)."""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from applicient_api import billing_service, schemas
from applicient_api.deps import current_user_id, get_db
from applicient_api.models.billing import Plan, Subscription
from applicient_api.models.profile import User

router = APIRouter(prefix="/billing", tags=["billing"])


@router.get("/plans", response_model=list[schemas.PlanOut])
def list_available_plans(db: Session = Depends(get_db)):
    """Deliberately public, no auth dependency — pricing has to be
    visible to a signed-out visitor on the landing page before they'll
    ever sign up. Plan name/price/cap carry nothing sensitive."""

    return db.query(Plan).filter_by(is_active=True).order_by(Plan.price_idr.asc()).all()


def _subscription_out(db: Session, subscription: Subscription, plan: Plan) -> schemas.SubscriptionOut:
    pending_plan = db.get(Plan, subscription.pending_plan_id) if subscription.pending_plan_id else None
    spend = billing_service.current_period_spend_usd(db, user_id=subscription.user_id, subscription=subscription)
    return schemas.SubscriptionOut(
        plan_id=plan.id,
        plan_name=plan.name,
        price_idr=plan.price_idr,
        monthly_usage_cap_usd=float(plan.monthly_usage_cap_usd),
        status=subscription.status,
        current_period_spend_usd=spend,
        current_period_end=subscription.current_period_end,
        pending_plan_name=pending_plan.name if pending_plan else None,
    )


@router.get("/subscription", response_model=schemas.SubscriptionOut)
def get_my_subscription(db: Session = Depends(get_db), user_id: uuid.UUID = Depends(current_user_id)):
    subscription = db.query(Subscription).filter_by(user_id=user_id).one_or_none()
    if subscription is None:
        raise HTTPException(404, "no subscription found for this account")
    plan = db.get(Plan, subscription.plan_id)
    if plan is None:
        raise HTTPException(404, "this account's plan no longer exists")
    return _subscription_out(db, subscription, plan)


@router.post("/checkout", response_model=schemas.CheckoutOut)
async def start_checkout(
    body: schemas.CheckoutIn, db: Session = Depends(get_db), user_id: uuid.UUID = Depends(current_user_id)
):
    user = db.get(User, user_id)
    subscription = db.query(Subscription).filter_by(user_id=user_id).one_or_none()
    if user is None or subscription is None:
        raise HTTPException(404, "no subscription found for this account")
    plan = db.query(Plan).filter_by(id=body.plan_id, is_active=True).one_or_none()
    if plan is None:
        raise HTTPException(404, "plan not found or no longer offered")
    if plan.id == subscription.plan_id:
        raise HTTPException(409, "already on this plan")
    try:
        checkout_url = await billing_service.start_checkout(db, user=user, subscription=subscription, plan=plan)
    except billing_service.XenditError as exc:
        raise HTTPException(502, f"Xendit checkout could not be started: {exc}")
    return schemas.CheckoutOut(checkout_url=checkout_url)


@router.post("/sync", response_model=schemas.SubscriptionOut)
async def sync_subscription(db: Session = Depends(get_db), user_id: uuid.UUID = Depends(current_user_id)):
    """Called by the frontend when the user lands back on /billing after
    Xendit's hosted checkout page (`?xendit=success`) — see
    billing_service.py's own docstring for why this polling path, not
    the webhook, is what this integration actually trusts."""

    subscription = db.query(Subscription).filter_by(user_id=user_id).one_or_none()
    if subscription is None:
        raise HTTPException(404, "no subscription found for this account")
    try:
        subscription = await billing_service.sync_subscription_from_xendit(db, subscription)
    except billing_service.XenditError as exc:
        raise HTTPException(502, f"could not sync with Xendit: {exc}")
    plan = db.get(Plan, subscription.plan_id)
    if plan is None:
        raise HTTPException(404, "this account's plan no longer exists")
    return _subscription_out(db, subscription, plan)
