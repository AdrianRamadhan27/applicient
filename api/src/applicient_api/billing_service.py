"""SaaS pivot — Dodo Payments integration for flat subscription tiers.
Replaces Xendit (redirect-only, Indonesia-specific) — Adrian wanted
embedded/overlay checkout, which Dodo supports natively, and Dodo is a
merchant-of-record approvable for an individual with no registered
company, unlike Stripe.

Every field name/enum/shape below is taken directly from the installed
`dodopayments` SDK (not the docs site, which is sometimes lossy when
summarized) — confirmed live by introspecting `dodopayments==1.115.0`
during this build: `Product.product_id`, `CheckoutSessionResponse.
checkout_url`/`.session_id`, `Subscription.subscription_id`/`.status`/
`.customer.customer_id`/`.product_id`/`.previous_billing_date`/
`.next_billing_date`, `SubscriptionStatus` (`pending`/`active`/
`on_hold`/`paused`/`cancelled`/`failed`/`expired`/`past_due`),
`RecurringPrice` (type="recurring_price", payment_frequency_*,
subscription_period_*), and `client.webhooks.unwrap()` — which uses
the official `standardwebhooks` library internally (Standard Webhooks
spec: `webhook-id`/`webhook-signature`/`webhook-timestamp` headers,
HMAC-SHA256) and raises rather than silently skipping verification
when no key is configured.

Confirmed live (real test checkout, not assumed): Dodo does NOT treat
IDR as zero-decimal — `price` is "smallest denomination" for every
currency uniformly, IDR included, same as USD cents. A first attempt
that passed `price_idr` straight through rendered `Rp 96.000` as
"IDR 960.00" (off by exactly 100x) — `price_idr * 100` below is what
actually reproduces the intended Rupiah amount.

**Products are created on demand, not a manual dashboard step**
(`ensure_product_for_plan`) — the actual ask that started this pass.
Same "find-or-create, cached on the row" shape this codebase already
uses for a Source (`_find_or_create_manual_source`, routers/jobs.py)
or a scan Source (`_find_or_create_scan_source`, company_candidates.py).

**Polling is still the authoritative sync path, the webhook is still
just a fast nudge** — same "two adapters, one interface" shape M5
established for Gmail and the Xendit build before it used, kept
deliberately even though Dodo's webhook payload shape IS fully
confirmed this time (unlike Xendit's): re-deriving from a direct
`subscriptions.retrieve()` call is still simpler to reason about and
trust than parsing whichever specific webhook subtype happened to
arrive. `sync_subscription_from_dodo` is the one function that
actually mutates billing state; both the webhook handler and the
user-facing sync endpoint call it.
"""

from __future__ import annotations

import os
import uuid
from datetime import datetime, timezone

from dodopayments import AsyncDodoPayments
from fastapi import Depends, HTTPException
from sqlalchemy import func
from sqlalchemy.orm import Session

from applicient_api.deps import current_user_id, get_db
from applicient_api.models.billing import Plan, Subscription
from applicient_api.models.llm import LlmCall
from applicient_api.models.profile import User

_TAX_CATEGORY = "saas"
# Plain monthly recurring, no fixed-term contract — payment_frequency
# and subscription_period are set equal (both "every 1 Month") so the
# subscription just renews every cycle until cancelled, rather than
# ending after a fixed number of periods.
_PAYMENT_FREQUENCY_INTERVAL = "Month"
_PAYMENT_FREQUENCY_COUNT = 1
_SUBSCRIPTION_PERIOD_INTERVAL = "Month"
_SUBSCRIPTION_PERIOD_COUNT = 1


class DodoError(Exception):
    pass


def _api_key() -> str:
    value = os.environ.get("DODO_PAYMENTS_API_KEY")
    if not value:
        raise RuntimeError("DODO_PAYMENTS_API_KEY is not set")
    return value


def _environment() -> str:
    # "test_mode" / "live_mode" — the exact Literal the SDK's own
    # constructor takes, confirmed against its type signature.
    return os.environ.get("DODO_PAYMENTS_ENVIRONMENT", "test_mode")


def webhook_key() -> str | None:
    return os.environ.get("DODO_PAYMENTS_WEBHOOK_KEY")


def _client() -> AsyncDodoPayments:
    return AsyncDodoPayments(bearer_token=_api_key(), webhook_key=webhook_key(), environment=_environment())


def _frontend_url() -> str:
    return os.environ.get("FRONTEND_URL", "http://localhost:3000")


def _price_body(plan: Plan) -> dict:
    return {
        "type": "recurring_price",
        "currency": "IDR",
        # Dodo's `price` is "smallest denomination" for every currency
        # uniformly (confirmed live) — IDR isn't special-cased as
        # zero-decimal the way some processors treat it, so this needs
        # the same x100 every USD-cents example in Dodo's own docs
        # implies, or a Rp 96,000 plan renders as "IDR 960.00" instead.
        "price": plan.price_idr * 100,
        "discount": 0,
        "payment_frequency_count": _PAYMENT_FREQUENCY_COUNT,
        "payment_frequency_interval": _PAYMENT_FREQUENCY_INTERVAL,
        "subscription_period_count": _SUBSCRIPTION_PERIOD_COUNT,
        "subscription_period_interval": _SUBSCRIPTION_PERIOD_INTERVAL,
        "trial_period_days": 0,
    }


def default_plan(db: Session) -> Plan | None:
    """The cheapest active plan (the free tier, by convention
    price_idr == 0) — every signup lands here (routers/auth.py), same
    lookup reused wherever "the default plan" is needed."""

    return db.query(Plan).filter_by(is_active=True).order_by(Plan.price_idr.asc()).first()


def period_start(subscription: Subscription | None) -> datetime:
    """A Dodo-backed subscription carries a real current_period_start
    once a first payment lands; a free-tier user with no billing
    history yet has none, so "current period" falls back to the start
    of the current UTC calendar month — a well-defined default rather
    than summing all-time spend."""

    if subscription is not None and subscription.current_period_start is not None:
        return subscription.current_period_start
    now = datetime.now(timezone.utc)
    return datetime(now.year, now.month, 1, tzinfo=timezone.utc)


async def ensure_product_for_plan(db: Session, plan: Plan) -> str | None:
    """Find-or-create this plan's Dodo Product — "product creation
    into the setup," not a manual dashboard step. Returns None for a
    free plan (price_idr == 0): there's nothing to check out for a $0
    tier, so it never gets a product. Idempotent — a plan that already
    has a dodo_product_id is returned as-is, never recreated."""

    if plan.price_idr <= 0:
        return None
    if plan.dodo_product_id:
        return plan.dodo_product_id

    client = _client()
    try:
        product = await client.products.create(name=plan.name, tax_category=_TAX_CATEGORY, price=_price_body(plan))
    except Exception as exc:
        raise DodoError(f"could not create a Dodo product for plan {plan.name!r}: {exc}") from exc

    plan.dodo_product_id = product.product_id
    db.commit()
    return plan.dodo_product_id


async def sync_product_for_plan(db: Session, plan: Plan) -> None:
    """Called from the admin Plan CRUD's update path (routers/admin.py)
    so an edited name/price doesn't silently drift from what Dodo
    actually charges — confirmed live that both are patchable in place
    (only the pricing *model*, one-time vs recurring, is immutable). A
    no-op for a plan with no product yet; ensure_product_for_plan is
    what creates one on first real need (plan creation, or the first
    checkout against it, whichever comes first)."""

    if not plan.dodo_product_id:
        return
    client = _client()
    try:
        await client.products.update(plan.dodo_product_id, name=plan.name, price=_price_body(plan))
    except Exception as exc:
        raise DodoError(f"could not update the Dodo product for plan {plan.name!r}: {exc}") from exc


async def _ensure_customer(db: Session, *, user: User, subscription: Subscription) -> str:
    if subscription.dodo_customer_id:
        return subscription.dodo_customer_id
    # No separate name field on User (same real, disclosed
    # simplification the Xendit build already made) — same
    # local-part-of-email convention reused here.
    name = user.email.split("@")[0]
    client = _client()
    try:
        customer = await client.customers.create(email=user.email, name=name)
    except Exception as exc:
        raise DodoError(f"could not create a Dodo customer: {exc}") from exc
    subscription.dodo_customer_id = customer.customer_id
    db.commit()
    return customer.customer_id


async def start_checkout(db: Session, *, user: User, subscription: Subscription, plan: Plan) -> str:
    """Creates a Dodo checkout session for `plan` and returns its
    checkout_url — the frontend opens this in the embedded overlay
    (dodopayments-checkout), it does not redirect the browser away.
    `return_url` is still set as a safety net in case the overlay ever
    does navigate the full page after payment (Dodo appends
    subscription_id/status query params to it when it does); the
    primary success path is the overlay SDK's own `checkout.redirect`
    event firing client-side, read directly from the event payload."""

    product_id = await ensure_product_for_plan(db, plan)
    if product_id is None:
        raise DodoError(f"plan {plan.name!r} has no price — nothing to check out")
    customer_id = await _ensure_customer(db, user=user, subscription=subscription)

    client = _client()
    try:
        session = await client.checkout_sessions.create(
            product_cart=[{"product_id": product_id, "quantity": 1}],
            customer={"customer_id": customer_id},
            return_url=f"{_frontend_url()}/console/billing?dodo_return=1",
            metadata={"user_id": str(user.id), "subscription_id": str(subscription.id)},
        )
    except Exception as exc:
        raise DodoError(f"could not start Dodo checkout: {exc}") from exc
    if not session.checkout_url:
        raise DodoError("Dodo checkout session was created but returned no checkout_url")

    subscription.dodo_checkout_session_id = session.session_id
    subscription.pending_plan_id = plan.id
    db.commit()
    return session.checkout_url


async def sync_subscription_from_dodo(
    db: Session, subscription: Subscription, *, dodo_subscription_id: str | None = None
) -> Subscription:
    """Re-derives subscription state from Dodo directly via GET — the
    one source of truth this integration relies on. `dodo_subscription_id`
    is accepted explicitly since the very first sync for a brand-new
    subscription happens before `subscription.dodo_subscription_id` is
    set on our own row (the frontend reads it fresh off the checkout
    overlay's success event / the return_url's own query param); every
    later call can omit it and this falls back to the id already
    stored. A no-op if there's nothing to sync yet. Safe to call
    repeatedly — idempotent by construction."""

    target_id = dodo_subscription_id or subscription.dodo_subscription_id
    if not target_id:
        return subscription

    client = _client()
    try:
        dodo_sub = await client.subscriptions.retrieve(target_id)
    except Exception as exc:
        raise DodoError(f"could not fetch Dodo subscription {target_id}: {exc}") from exc

    subscription.dodo_subscription_id = dodo_sub.subscription_id
    subscription.dodo_customer_id = dodo_sub.customer.customer_id
    subscription.status = dodo_sub.status
    subscription.current_period_start = dodo_sub.previous_billing_date
    subscription.current_period_end = dodo_sub.next_billing_date

    if dodo_sub.status == "active":
        plan = db.query(Plan).filter_by(dodo_product_id=dodo_sub.product_id).one_or_none()
        if plan is not None:
            subscription.plan_id = plan.id
            subscription.pending_plan_id = None

    db.commit()
    return subscription


def unwrap_webhook_event(payload: bytes, headers: dict[str, str]):
    """Verifies + parses an incoming Dodo webhook — raises (via the
    SDK's own `standardwebhooks`-backed check) rather than silently
    accepting an unsigned/mis-signed request. `payload` must be the
    exact raw request body; verification hashes it directly."""

    return _client().webhooks.unwrap(payload.decode(), headers=headers)


def find_subscription_by_dodo_ids(
    db: Session, *, dodo_subscription_id: str | None, dodo_customer_id: str | None
) -> Subscription | None:
    """Webhook events (server-to-server, no authenticated user context)
    need a way to find which of our own Subscription rows to re-sync.
    Tried in order: the Dodo subscription id itself (set once the
    first sync for that subscription has ever happened), then the Dodo
    customer id (set from _ensure_customer before the very first
    checkout, so it's always there even for the very first
    subscription.active event that arrives before anything else has
    captured a subscription_id)."""

    if dodo_subscription_id:
        found = db.query(Subscription).filter_by(dodo_subscription_id=dodo_subscription_id).one_or_none()
        if found is not None:
            return found
    if dodo_customer_id:
        return db.query(Subscription).filter_by(dodo_customer_id=dodo_customer_id).one_or_none()
    return None


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
