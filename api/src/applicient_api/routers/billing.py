"""SaaS pivot — the regular-user-facing billing surface: see available
plans, see your own current plan/usage, start a Dodo checkout (opened
client-side as an embedded overlay, not a redirect), and re-sync after
the overlay reports success (billing_service.py's own docstring
explains why polling, not the webhook, is the authoritative path).

Phase 16 — credit-based billing. Every field a regular user can see
here is credits, never `$` (billing_service.current_period_spend_usd
still exists and is still accurate, it's just admin/internal-only now
— see AdminUserOut/AdminPlanOut). Also adds credit packs (standalone,
one-time purchases) and the user's own credit transaction history."""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session

from applicient_api import billing_service, credit_ledger, currency_service, schemas
from applicient_api.deps import current_user_id, get_db
from applicient_api.models.billing import CreditPack, CreditTransaction, FeatureCreditCost, Plan, Subscription
from applicient_api.models.profile import User

router = APIRouter(prefix="/billing", tags=["billing"])


@router.get("/currency", response_model=schemas.LocalizedCurrencyOut)
async def get_localized_currency(request: Request):
    """Adrian, direct: "cost of purchase... show in the currency of
    wherever the user is... also convert prices on our own pages" —
    public, same reasoning as /plans below (a signed-out visitor on the
    landing page needs this too). Real geo-IP + a real live FX rate
    (currency_service.py), never a guess — {"currency": null, "rate":
    null} means "just show the real IDR price," not "assume English/US."""

    result = await currency_service.resolve_display_currency(request)
    if result is None:
        return schemas.LocalizedCurrencyOut(currency=None, rate=None)
    return schemas.LocalizedCurrencyOut(currency=str(result["currency"]), rate=float(result["rate"]))


@router.get("/plans", response_model=list[schemas.PlanOut])
def list_available_plans(db: Session = Depends(get_db)):
    """Deliberately public, no auth dependency — pricing has to be
    visible to a signed-out visitor on the landing page before they'll
    ever sign up. Plan name/price/credits carry nothing sensitive."""

    return db.query(Plan).filter_by(is_active=True).order_by(Plan.price_idr.asc()).all()


@router.get("/credit-packs", response_model=list[schemas.CreditPackOut])
def list_credit_packs(db: Session = Depends(get_db)):
    return db.query(CreditPack).filter_by(is_active=True).order_by(CreditPack.price_idr.asc()).all()


@router.get("/feature-costs", response_model=list[schemas.FeatureCreditCostOut])
def list_feature_costs(db: Session = Depends(get_db)):
    """Public — the Assistant's own pre-flight confirmation ("this will
    use N credits, proceed?") and various "costs N credits" UI hints
    need to know real prices without admin access."""

    return db.query(FeatureCreditCost).filter_by(is_active=True).order_by(FeatureCreditCost.key.asc()).all()


@router.get("/credits/first-use-status")
def get_first_use_status(
    db: Session = Depends(get_db), user_id: uuid.UUID = Depends(current_user_id)
) -> dict[str, bool]:
    """Adrian, direct: "when its the free first time thing, it should
    say so in the credits cost tag beside the feature" — the frontend's
    CreditCostBadge needs to know, per feature, whether THIS user's
    next use would be free (credit_ledger.py's own first-use-free rule
    in charge_credits/insufficient_credits_message) to render "Free
    (first use)" instead of the real cost. `{feature_key: bool}`, true
    meaning "not used yet, next use is free" — auth-gated (unlike
    /feature-costs above, which stays public/pricing-only) since this
    is genuinely per-user state, not a shared price list."""

    rows = db.query(FeatureCreditCost).filter_by(is_active=True).all()
    return {
        row.key: not credit_ledger.has_used_feature_before(db, user_id=user_id, feature_key=row.key) for row in rows
    }


def _subscription_out(db: Session, subscription: Subscription, plan: Plan) -> schemas.SubscriptionOut:
    pending_plan = db.get(Plan, subscription.pending_plan_id) if subscription.pending_plan_id else None
    balance = credit_ledger.get_balance(db, user_id=subscription.user_id)
    return schemas.SubscriptionOut(
        plan_id=plan.id,
        plan_name=plan.name,
        price_idr=plan.price_idr,
        monthly_credits=plan.monthly_credits,
        credits_monthly=balance["monthly"],
        credits_purchased=balance["purchased"],
        credits_total=balance["total"],
        status=subscription.status,
        current_period_end=subscription.current_period_end,
        pending_plan_id=subscription.pending_plan_id,
        pending_plan_name=pending_plan.name if pending_plan else None,
        cancel_at_period_end=subscription.cancel_at_period_end,
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
    """Free -> Paid only — a brand-new Dodo subscription, active as
    soon as payment succeeds (confirmed directly with Adrian: this is
    the one case that applies IMMEDIATELY, not at the next billing
    cycle). An already-paid account changing plans belongs on
    POST /billing/change-plan instead, which schedules the change
    rather than starting a second, competing subscription — rejected
    here rather than silently doing the wrong thing."""

    user = db.get(User, user_id)
    subscription = db.query(Subscription).filter_by(user_id=user_id).one_or_none()
    if user is None or subscription is None:
        raise HTTPException(404, "no subscription found for this account")
    plan = db.query(Plan).filter_by(id=body.plan_id, is_active=True).one_or_none()
    if plan is None:
        raise HTTPException(404, "plan not found or no longer offered")
    if plan.id == subscription.plan_id:
        raise HTTPException(409, "already on this plan")
    current_plan = db.get(Plan, subscription.plan_id)
    if current_plan is not None and current_plan.price_idr > 0:
        raise HTTPException(409, "already on a paid plan — use change-plan to switch, not a new checkout")
    try:
        checkout_url = await billing_service.start_checkout(
            db, user=user, subscription=subscription, plan=plan, preferred_currency=body.currency,
        )
    except billing_service.DodoError as exc:
        raise HTTPException(502, f"Dodo checkout could not be started: {exc}")
    return schemas.CheckoutOut(checkout_url=checkout_url)


@router.post("/change-plan", response_model=schemas.SubscriptionOut)
async def change_plan(
    body: schemas.CheckoutIn, db: Session = Depends(get_db), user_id: uuid.UUID = Depends(current_user_id)
):
    """Upgrade or downgrade an already-paid subscription to a
    different paid plan — scheduled for the next billing cycle
    (confirmed directly with Adrian), not immediate. Free -> Paid
    stays on POST /billing/checkout above; switching a paid account
    DOWN to Free is POST /billing/cancel below (Free has no product to
    "change plan" to — cancelling naturally reverts the account once
    the current paid period actually ends)."""

    subscription = db.query(Subscription).filter_by(user_id=user_id).one_or_none()
    if subscription is None:
        raise HTTPException(404, "no subscription found for this account")
    new_plan = db.query(Plan).filter_by(id=body.plan_id, is_active=True).one_or_none()
    if new_plan is None:
        raise HTTPException(404, "plan not found or no longer offered")
    if new_plan.price_idr <= 0:
        raise HTTPException(409, "to move down to the Free plan, cancel your subscription instead")
    if new_plan.id == subscription.plan_id:
        raise HTTPException(409, "already on this plan")
    current_plan = db.get(Plan, subscription.plan_id)
    if current_plan is None or current_plan.price_idr <= 0:
        raise HTTPException(409, "not currently on a paid plan — use checkout to subscribe instead")
    try:
        subscription = await billing_service.change_subscription_plan(db, subscription=subscription, new_plan=new_plan)
    except billing_service.DodoError as exc:
        raise HTTPException(502, f"could not schedule the plan change: {exc}")
    return _subscription_out(db, subscription, current_plan)


@router.post("/change-plan/undo", response_model=schemas.SubscriptionOut)
async def undo_change_plan(db: Session = Depends(get_db), user_id: uuid.UUID = Depends(current_user_id)):
    subscription = db.query(Subscription).filter_by(user_id=user_id).one_or_none()
    if subscription is None:
        raise HTTPException(404, "no subscription found for this account")
    try:
        subscription = await billing_service.undo_pending_plan_change(db, subscription=subscription)
    except billing_service.DodoError as exc:
        raise HTTPException(502, f"could not undo the scheduled plan change: {exc}")
    plan = db.get(Plan, subscription.plan_id)
    if plan is None:
        raise HTTPException(404, "this account's plan no longer exists")
    return _subscription_out(db, subscription, plan)


@router.post("/cancel", response_model=schemas.SubscriptionOut)
async def cancel_subscription(db: Session = Depends(get_db), user_id: uuid.UUID = Depends(current_user_id)):
    """Schedules cancellation at the end of the current billing period
    (confirmed directly with Adrian — never immediate). The account
    keeps its current paid plan/credits until the period genuinely
    ends, at which point it reverts to Free (billing_service.
    sync_subscription_from_dodo's own status handling)."""

    subscription = db.query(Subscription).filter_by(user_id=user_id).one_or_none()
    if subscription is None:
        raise HTTPException(404, "no subscription found for this account")
    plan = db.get(Plan, subscription.plan_id)
    if plan is None or plan.price_idr <= 0:
        raise HTTPException(409, "nothing to cancel — already on the Free plan")
    try:
        subscription = await billing_service.cancel_subscription(db, subscription=subscription)
    except billing_service.DodoError as exc:
        raise HTTPException(502, f"could not schedule cancellation: {exc}")
    return _subscription_out(db, subscription, plan)


@router.post("/cancel/undo", response_model=schemas.SubscriptionOut)
async def undo_cancel_subscription(db: Session = Depends(get_db), user_id: uuid.UUID = Depends(current_user_id)):
    subscription = db.query(Subscription).filter_by(user_id=user_id).one_or_none()
    if subscription is None:
        raise HTTPException(404, "no subscription found for this account")
    try:
        subscription = await billing_service.undo_cancel_subscription(db, subscription=subscription)
    except billing_service.DodoError as exc:
        raise HTTPException(502, f"could not undo the scheduled cancellation: {exc}")
    plan = db.get(Plan, subscription.plan_id)
    if plan is None:
        raise HTTPException(404, "this account's plan no longer exists")
    return _subscription_out(db, subscription, plan)


@router.post("/sync", response_model=schemas.SubscriptionOut)
async def sync_subscription(
    dodo_subscription_id: str | None = None,
    db: Session = Depends(get_db),
    user_id: uuid.UUID = Depends(current_user_id),
):
    """Called by the frontend right after the checkout overlay reports
    success — `dodo_subscription_id` comes straight from that event's
    own payload (or, as a fallback, the `subscription_id` query param
    Dodo appends to return_url if it ever does a full navigation
    instead). See billing_service.py's own docstring for why this
    polling path, not the webhook, is what this integration actually
    trusts to mutate billing state."""

    subscription = db.query(Subscription).filter_by(user_id=user_id).one_or_none()
    if subscription is None:
        raise HTTPException(404, "no subscription found for this account")
    try:
        subscription = await billing_service.sync_subscription_from_dodo(
            db, subscription, dodo_subscription_id=dodo_subscription_id
        )
    except billing_service.DodoError as exc:
        raise HTTPException(502, f"could not sync with Dodo: {exc}")
    plan = db.get(Plan, subscription.plan_id)
    if plan is None:
        raise HTTPException(404, "this account's plan no longer exists")
    return _subscription_out(db, subscription, plan)


@router.post("/credit-packs/{pack_id}/checkout", response_model=schemas.CheckoutOut)
async def start_pack_checkout(
    pack_id: uuid.UUID,
    currency: str | None = None,
    db: Session = Depends(get_db),
    user_id: uuid.UUID = Depends(current_user_id),
):
    user = db.get(User, user_id)
    subscription = db.query(Subscription).filter_by(user_id=user_id).one_or_none()
    if user is None or subscription is None:
        raise HTTPException(404, "no subscription found for this account")
    pack = db.query(CreditPack).filter_by(id=pack_id, is_active=True).one_or_none()
    if pack is None:
        raise HTTPException(404, "credit pack not found or no longer offered")
    try:
        checkout_url = await billing_service.start_pack_checkout(
            db, user=user, subscription=subscription, pack=pack, preferred_currency=currency,
        )
    except billing_service.DodoError as exc:
        raise HTTPException(502, f"Dodo checkout could not be started: {exc}")
    return schemas.CheckoutOut(checkout_url=checkout_url)


@router.post("/credit-packs/confirm")
async def confirm_pack_purchase(
    dodo_payment_id: str, db: Session = Depends(get_db), user_id: uuid.UUID = Depends(current_user_id)
):
    """The one-time-purchase equivalent of /billing/sync — called by
    the frontend right after the checkout overlay reports a successful
    payment, `dodo_payment_id` straight from that event's own payload.
    Same "webhook is a nudge, this polling path is what's actually
    trusted" reasoning; record_purchase's own dodo_payment_id
    idempotency guard makes this safe to call even if the webhook
    already credited it first."""

    try:
        payment = await billing_service.retrieve_payment(dodo_payment_id)
    except billing_service.DodoError as exc:
        raise HTTPException(502, f"could not confirm payment with Dodo: {exc}")
    if payment.status != "succeeded":
        raise HTTPException(422, f"this payment has not succeeded (status: {payment.status})")
    metadata = payment.metadata or {}
    pack_id = metadata.get("credit_pack_id")
    metadata_user_id = metadata.get("user_id")
    if not pack_id or str(metadata_user_id) != str(user_id):
        raise HTTPException(422, "this payment does not match a credit pack purchase for this account")
    pack = db.get(CreditPack, pack_id)
    if pack is None:
        raise HTTPException(404, "credit pack not found")
    credit_ledger.record_purchase(db, user_id=user_id, pack=pack, dodo_payment_id=dodo_payment_id)
    return {"credits": credit_ledger.get_balance(db, user_id=user_id)["total"]}


@router.get("/credits/transactions", response_model=list[schemas.CreditTransactionOut])
def list_credit_transactions(
    limit: int = 50,
    before: uuid.UUID | None = None,
    db: Session = Depends(get_db),
    user_id: uuid.UUID = Depends(current_user_id),
):
    """Paginated, newest first — "before" is the last id from the
    previous page (a plain offset would drift under concurrent writes;
    this doesn't). The literal ask: "user can see each credit
    transaction"."""

    query = db.query(CreditTransaction).filter_by(user_id=user_id)
    if before is not None:
        cursor = db.get(CreditTransaction, before)
        if cursor is not None:
            query = query.filter(CreditTransaction.created_at < cursor.created_at)
    return query.order_by(CreditTransaction.created_at.desc()).limit(min(limit, 200)).all()
