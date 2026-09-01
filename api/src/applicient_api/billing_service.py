"""SaaS pivot — Xendit integration for flat subscription tiers.

Xendit's real API (confirmed against their live docs, not assumed) has
no single "create a subscription" call the way Stripe does. A flat-fee
recurring plan needs two separate steps:

1. **Pay and Save** (`POST /sessions`, `session_type: "PAY"`,
   `mode: "PAYMENT_LINK"`, `allow_save_payment_method: "FORCED"`) — a
   hosted checkout page that collects the first payment *and* a
   reusable `payment_token_id`.
2. **Create the recurring plan** (`POST /recurring/plans`) — once a
   `payment_token_id` exists, this establishes the actual monthly
   charge going forward.

Hand-rolled httpx calls, matching this codebase's existing
httpx-over-SDK convention for third-party providers (gmail_service.py,
providers/google_ai_studio.py) — no Xendit Python SDK dependency.

**Polling is the authoritative sync path, webhooks are a best-effort
nudge** — the same "two adapters, one interface" shape M5 already
established for Gmail (push webhook vs. poll), for the same reason:
Xendit's webhook payload shapes could not be fully confirmed from their
docs during this build (their reference pages are incomplete for the
`payment_session.completed` event specifically), so trusting an
unconfirmed field name to move real money state would be reckless.
`sync_subscription_from_xendit` re-derives truth from a direct
authenticated GET against Xendit's own API — a shape that *is*
confirmed (it's the same response schema the create calls return) —
and both the webhook handler and the user-facing "sync" endpoint call
this one function rather than each parsing payloads independently.
"""

from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone

import httpx
from fastapi import Depends, HTTPException
from sqlalchemy import func
from sqlalchemy.orm import Session

from applicient_api.deps import current_user_id, get_db
from applicient_api.models.billing import Plan, Subscription
from applicient_api.models.llm import LlmCall
from applicient_api.models.profile import User

API_ROOT = "https://api.xendit.co"


class XenditError(Exception):
    pass


def _secret_key() -> str:
    value = os.environ.get("XENDIT_SECRET_KEY")
    if not value:
        raise RuntimeError("XENDIT_SECRET_KEY is not set")
    return value


def webhook_token() -> str | None:
    return os.environ.get("XENDIT_WEBHOOK_TOKEN")


def _checkout_return_base_url() -> str:
    """Xendit rejects non-HTTPS success_return_url/cancel_return_url
    outright (confirmed live: a plain http:// FRONTEND_URL 400s the
    whole checkout-session creation, not just the eventual redirect).
    FRONTEND_URL is `http://localhost:3000` in every local-dev setup
    this codebase has ever shipped — real deployments are HTTPS by the
    time this matters, so this only ever falls back locally. The
    fallback destination itself doesn't need to be reachable: the
    billing page's "Sync payment status" button (routers/billing.py's
    /sync) doesn't depend on the redirect landing anywhere in
    particular, only on the user completing payment on Xendit's own
    hosted page and then coming back to check status themselves."""

    url = os.environ.get("FRONTEND_URL", "http://localhost:3000")
    return url if url.startswith("https://") else "https://xendit.co"


async def _request(method: str, path: str, *, json: dict | None = None) -> dict:
    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.request(method, f"{API_ROOT}{path}", auth=(_secret_key(), ""), json=json)
    if resp.status_code >= 400:
        raise XenditError(f"{method} {path} -> {resp.status_code}: {resp.text[:500]}")
    return resp.json()


def default_plan(db: Session) -> Plan | None:
    """The cheapest active plan (the free tier, by convention
    price_idr == 0) — every signup lands here (routers/auth.py), same
    lookup reused wherever "the default plan" is needed."""

    return db.query(Plan).filter_by(is_active=True).order_by(Plan.price_idr.asc()).first()


def period_start(subscription: Subscription | None) -> datetime:
    """Xendit-backed subscriptions carry a real current_period_start
    once a first payment lands; a free-tier user with no billing
    history yet has none, so "current period" falls back to the start
    of the current UTC calendar month — a well-defined default rather
    than summing all-time spend."""

    if subscription is not None and subscription.current_period_start is not None:
        return subscription.current_period_start
    now = datetime.now(timezone.utc)
    return datetime(now.year, now.month, 1, tzinfo=timezone.utc)


async def _ensure_customer(db: Session, *, user: User, subscription: Subscription) -> str:
    if subscription.xendit_customer_id:
        return subscription.xendit_customer_id
    given_names = user.email.split("@")[0]  # no separate name field on User — a real, disclosed simplification
    body = await _request(
        "POST", "/customers",
        json={
            "reference_id": str(user.id),
            "type": "INDIVIDUAL",
            "email": user.email,
            "individual_detail": {"given_names": given_names},
        },
    )
    customer_id = body["id"]
    subscription.xendit_customer_id = customer_id
    db.commit()
    return customer_id


async def start_checkout(db: Session, *, user: User, subscription: Subscription, plan: Plan) -> str:
    """Creates the Pay-and-Save hosted session for `plan` and returns
    the checkout URL to redirect the user to. Stores enough on
    `subscription` for `sync_subscription_from_xendit` to pick the
    session back up later — by user action (the return-page "sync"
    call) or by a webhook nudge, whichever arrives."""

    customer_id = await _ensure_customer(db, user=user, subscription=subscription)
    reference_id = str(subscription.id)
    body = await _request(
        "POST", "/sessions",
        json={
            "reference_id": reference_id,
            "session_type": "PAY",
            "mode": "PAYMENT_LINK",
            "currency": "IDR",
            "country": "ID",
            "amount": plan.price_idr,
            "customer_id": customer_id,
            "allow_save_payment_method": "FORCED",
            "success_return_url": f"{_checkout_return_base_url()}/billing?xendit=success",
            "cancel_return_url": f"{_checkout_return_base_url()}/billing?xendit=cancelled",
        },
    )
    subscription.xendit_payment_session_id = body["payment_session_id"]
    subscription.pending_plan_id = plan.id
    db.commit()
    return body["payment_link_url"]


async def _create_recurring_plan(*, customer_id: str, payment_token_id: str, plan: Plan, reference_id: str) -> dict:
    return await _request(
        "POST", "/recurring/plans",
        json={
            "reference_id": reference_id,
            "customer_id": customer_id,
            "currency": "IDR",
            "amount": plan.price_idr,
            "payment_tokens": [{"payment_token_id": payment_token_id, "rank": 1}],
            "schedule": {
                "interval": "MONTH",
                "interval_count": 1,
                "anchor_date": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
            },
            # The first cycle was already paid via the Pay-and-Save
            # session that produced this payment_token_id — charging
            # again immediately here would double-bill.
            "immediate_payment": False,
        },
    )


async def sync_subscription_from_xendit(db: Session, subscription: Subscription) -> Subscription:
    """Re-derives subscription state from Xendit directly via GET, the
    one confirmed-shape source of truth this integration relies on.
    A no-op if there's nothing pending. Safe to call repeatedly —
    idempotent by construction (re-checking an already-active recurring
    plan just re-confirms it, doesn't recreate anything)."""

    if subscription.xendit_recurring_plan_id:
        body = await _request("GET", f"/recurring/plans/{subscription.xendit_recurring_plan_id}")
        if body.get("status") == "ACTIVE":
            subscription.status = "active"
            db.commit()
        return subscription

    if not subscription.xendit_payment_session_id or not subscription.pending_plan_id:
        return subscription

    session_body = await _request("GET", f"/sessions/{subscription.xendit_payment_session_id}")
    status = session_body.get("status")
    if status not in ("COMPLETED", "SUCCEEDED"):
        return subscription

    payment_token_id = session_body.get("payment_token_id")
    if not payment_token_id:
        # Completed but no token yet is a real, if unexpected, Xendit
        # response shape — surfaced plainly rather than silently
        # treated as success with nothing to charge future cycles with.
        raise XenditError(f"payment session {subscription.xendit_payment_session_id} completed with no payment_token_id")

    plan = db.get(Plan, subscription.pending_plan_id)
    if plan is None:
        raise XenditError(f"pending plan {subscription.pending_plan_id} no longer exists")

    recurring = await _create_recurring_plan(
        customer_id=subscription.xendit_customer_id, payment_token_id=payment_token_id,
        plan=plan, reference_id=str(subscription.id),
    )
    subscription.xendit_payment_token_id = payment_token_id
    subscription.xendit_recurring_plan_id = recurring["id"]
    subscription.plan_id = plan.id
    subscription.pending_plan_id = None
    subscription.status = "active"
    subscription.current_period_start = datetime.now(timezone.utc)
    subscription.current_period_end = datetime.now(timezone.utc) + timedelta(days=30)
    db.commit()
    return subscription


def current_period_spend_usd(db: Session, *, user_id: uuid.UUID, subscription: Subscription | None) -> float:
    spend = (
        db.query(func.coalesce(func.sum(LlmCall.cost_usd), 0))
        .filter(LlmCall.user_id == user_id, LlmCall.created_at >= period_start(subscription))
        .scalar()
    )
    return float(spend or 0)


def enforce_usage_cap(db: Session = Depends(get_db), user_id: uuid.UUID = Depends(current_user_id)) -> None:
    """FastAPI dependency, same `dependencies=[Depends(...)]` route-option
    shape as rate_limit.py — gates the same expensive/LLM-triggering
    routes, checked alongside (not instead of) the per-user rate limit.
    A user with no Subscription row at all (shouldn't happen given
    signup/seed.py both provision one, but not asserted here) is let
    through rather than blocked by a data gap that isn't their fault."""

    subscription = db.query(Subscription).filter_by(user_id=user_id).one_or_none()
    if subscription is None:
        return
    plan = db.get(Plan, subscription.plan_id)
    if plan is None:
        return
    spend = current_period_spend_usd(db, user_id=user_id, subscription=subscription)
    if spend >= float(plan.monthly_usage_cap_usd):
        raise HTTPException(
            402,
            f"usage cap reached for the {plan.name} plan (${float(plan.monthly_usage_cap_usd):.2f}/mo) "
            "— upgrade to continue this month",
        )


def find_subscription_by_reference(db: Session, reference_id: str) -> Subscription | None:
    """`reference_id` on every Xendit object we create is this
    subscription's own id (see start_checkout) — used by the webhook
    handler to find which row to re-sync without trusting any other
    field name in a payload whose exact shape isn't fully confirmed."""

    try:
        subscription_id = uuid.UUID(reference_id)
    except (ValueError, TypeError):
        return None
    return db.get(Subscription, subscription_id)
