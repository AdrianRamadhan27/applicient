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
from sqlalchemy import func
from sqlalchemy.orm import Session

from applicient_api import credit_ledger, email_service
from applicient_api.models.billing import CreditPack, Plan, Subscription
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


def plan_product_id(plan: Plan) -> str | None:
    """Whichever of the plan's two product ids matches the server's
    *current* DODO_PAYMENTS_ENVIRONMENT — test and live are fully
    separate catalogs in Dodo, so this is never a fallback/either-or,
    only the one that's actually valid against whatever mode `_client()`
    is about to talk to. Exposed (not `_`-prefixed) so routers/admin.py
    can use the same rule to decide whether an edited plan already has
    a product for the active environment, without duplicating the
    `_environment()` check there."""

    return plan.dodo_product_id_live if _environment() == "live_mode" else plan.dodo_product_id_test


def _set_plan_product_id(plan: Plan, product_id: str) -> None:
    if _environment() == "live_mode":
        plan.dodo_product_id_live = product_id
    else:
        plan.dodo_product_id_test = product_id


def _frontend_url() -> str:
    return os.environ.get("FRONTEND_URL", "http://localhost:3000")


def _price_body(item: Plan | CreditPack, *, recurring: bool = True) -> dict:
    """`item` is duck-typed — only `.price_idr` is read, which both
    `Plan` and `CreditPack` have (Phase 16's `CreditPack` mirrors
    `Plan`'s own shape deliberately). `recurring=False` is a Dodo
    `OneTimePrice` instead (confirmed live via SDK introspection,
    `dodopayments.types.price_param.OneTimePrice` — same
    `type`/`currency`/`discount`/`price` fields as `RecurringPrice`,
    just none of the subscription-period ones)."""

    body = {
        "type": "recurring_price" if recurring else "one_time_price",
        "currency": "IDR",
        # Dodo's `price` is "smallest denomination" for every currency
        # uniformly (confirmed live) — IDR isn't special-cased as
        # zero-decimal the way some processors treat it, so this needs
        # the same x100 every USD-cents example in Dodo's own docs
        # implies, or a Rp 96,000 plan renders as "IDR 960.00" instead.
        "price": item.price_idr * 100,
        "discount": 0,
    }
    if recurring:
        body.update(
            payment_frequency_count=_PAYMENT_FREQUENCY_COUNT,
            payment_frequency_interval=_PAYMENT_FREQUENCY_INTERVAL,
            subscription_period_count=_SUBSCRIPTION_PERIOD_COUNT,
            subscription_period_interval=_SUBSCRIPTION_PERIOD_INTERVAL,
            trial_period_days=0,
        )
    return body


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
    """Find-or-create this plan's Dodo Product for the server's
    *current* environment — "product creation into the setup," not a
    manual dashboard step, though the admin Plans page can also set
    one directly for a product that already exists in Dodo (e.g. one
    created by hand after moving from test to live). Returns None for
    a free plan (price_idr == 0): there's nothing to check out for a
    $0 tier, so it never gets a product. Idempotent per environment —
    a plan that already has a product id for the active environment is
    returned as-is, never recreated; switching environments (test <->
    live) naturally creates/uses the *other* column instead of
    colliding with it."""

    if plan.price_idr <= 0:
        return None
    existing = plan_product_id(plan)
    if existing:
        return existing

    client = _client()
    try:
        product = await client.products.create(name=plan.name, tax_category=_TAX_CATEGORY, price=_price_body(plan))
    except Exception as exc:
        raise DodoError(f"could not create a Dodo product for plan {plan.name!r}: {exc}") from exc

    _set_plan_product_id(plan, product.product_id)
    db.commit()
    return plan_product_id(plan)


async def sync_product_for_plan(db: Session, plan: Plan) -> None:
    """Called from the admin Plan CRUD's update path (routers/admin.py)
    so an edited name/price doesn't silently drift from what Dodo
    actually charges — confirmed live that both are patchable in place
    (only the pricing *model*, one-time vs recurring, is immutable).
    Only ever touches the *current* environment's product (test and
    live are separate Dodo objects — a price change made while running
    in test mode has nothing to do with the live product, and vice
    versa). A no-op if the active environment has no product id yet;
    ensure_product_for_plan is what creates one on first real need."""

    product_id = plan_product_id(plan)
    if not product_id:
        return
    client = _client()
    try:
        await client.products.update(product_id, name=plan.name, price=_price_body(plan))
    except Exception as exc:
        raise DodoError(f"could not update the Dodo product for plan {plan.name!r}: {exc}") from exc


# --- Phase 16 — CreditPack's one-time-purchase equivalents of the
# three Plan functions just above. `pack_product_id`/`_set_pack_product_id`
# are plain aliases (plan_product_id/_set_plan_product_id only ever read
# or write `.dodo_product_id_test`/`_live`, which CreditPack has too —
# no real Plan-specific logic to duplicate) kept as separate names
# purely so call sites read naturally. ---


def pack_product_id(pack: CreditPack) -> str | None:
    return plan_product_id(pack)  # type: ignore[arg-type]  # duck-typed, see module note above


def _set_pack_product_id(pack: CreditPack, product_id: str) -> None:
    _set_plan_product_id(pack, product_id)  # type: ignore[arg-type]


async def ensure_product_for_pack(db: Session, pack: CreditPack) -> str | None:
    """Same find-or-create shape as ensure_product_for_plan, for a
    CreditPack's one-time product instead of a Plan's recurring one."""

    if pack.price_idr <= 0:
        return None
    existing = pack_product_id(pack)
    if existing:
        return existing

    client = _client()
    try:
        product = await client.products.create(
            name=pack.name, tax_category=_TAX_CATEGORY, price=_price_body(pack, recurring=False)
        )
    except Exception as exc:
        raise DodoError(f"could not create a Dodo product for credit pack {pack.name!r}: {exc}") from exc

    _set_pack_product_id(pack, product.product_id)
    db.commit()
    return pack_product_id(pack)


async def sync_product_for_pack(db: Session, pack: CreditPack) -> None:
    product_id = pack_product_id(pack)
    if not product_id:
        return
    client = _client()
    try:
        await client.products.update(product_id, name=pack.name, price=_price_body(pack, recurring=False))
    except Exception as exc:
        raise DodoError(f"could not update the Dodo product for credit pack {pack.name!r}: {exc}") from exc


async def start_pack_checkout(db: Session, *, user: User, subscription: Subscription, pack: CreditPack) -> str:
    """One-time purchase — unlike start_checkout (a Plan subscription),
    this never touches `subscription.pending_plan_id`/
    `dodo_checkout_session_id` (subscription-lifecycle fields with no
    meaning for a one-time buy); `subscription` is borrowed here only
    for its cached Dodo customer id via `_ensure_customer`. Which pack
    was bought travels in the checkout's own `metadata` instead — read
    back by the webhook/confirm path (routers/webhooks.py,
    confirm_credit_pack_purchase below), not stored on any row here."""

    product_id = await ensure_product_for_pack(db, pack)
    if product_id is None:
        raise DodoError(f"credit pack {pack.name!r} has no price — nothing to check out")
    customer_id = await _ensure_customer(db, user=user, subscription=subscription)

    client = _client()
    try:
        session = await client.checkout_sessions.create(
            product_cart=[{"product_id": product_id, "quantity": 1}],
            customer={"customer_id": customer_id},
            return_url=f"{_frontend_url()}/console/billing?dodo_return=1",
            metadata={"user_id": str(user.id), "credit_pack_id": str(pack.id)},
        )
    except Exception as exc:
        raise DodoError(f"could not start Dodo checkout: {exc}") from exc
    if not session.checkout_url:
        raise DodoError("Dodo checkout session was created but returned no checkout_url")
    return session.checkout_url


async def retrieve_payment(payment_id: str):
    """Thin wrapper — the one-time-purchase equivalent of
    sync_subscription_from_dodo's `subscriptions.retrieve` call, used
    by both the webhook's `payment.succeeded` branch (as a second real
    confirmation, not just trusting the webhook payload) and the
    frontend-triggered manual confirm endpoint for the same "polling is
    still the authoritative path" reason the module docstring gives."""

    client = _client()
    try:
        return await client.payments.retrieve(payment_id)
    except Exception as exc:
        raise DodoError(f"could not fetch Dodo payment {payment_id}: {exc}") from exc


def subscription_customer_id(subscription: Subscription) -> str | None:
    """Same rule as plan_product_id above, applied to the other half
    of the same bug (raised directly by Adrian) — a Dodo customer is
    also test/live-scoped, so this is never a fallback, only whichever
    column matches the server's current environment."""

    return subscription.dodo_customer_id_live if _environment() == "live_mode" else subscription.dodo_customer_id_test


def _set_subscription_customer_id(subscription: Subscription, customer_id: str) -> None:
    if _environment() == "live_mode":
        subscription.dodo_customer_id_live = customer_id
    else:
        subscription.dodo_customer_id_test = customer_id


async def _ensure_customer(db: Session, *, user: User, subscription: Subscription) -> str:
    existing = subscription_customer_id(subscription)
    if existing:
        return existing
    # No separate name field on User (same real, disclosed
    # simplification the Xendit build already made) — same
    # local-part-of-email convention reused here.
    name = user.email.split("@")[0]
    client = _client()
    try:
        customer = await client.customers.create(email=user.email, name=name)
    except Exception as exc:
        raise DodoError(f"could not create a Dodo customer: {exc}") from exc
    _set_subscription_customer_id(subscription, customer.customer_id)
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


async def change_subscription_plan(db: Session, *, subscription: Subscription, new_plan: Plan) -> Subscription:
    """Upgrade or downgrade an ALREADY-PAID subscription to a
    different paid plan — confirmed directly with Adrian: takes effect
    at the next billing cycle, never immediately, unlike the
    free -> paid path above (a brand-new checkout, which activates as
    soon as payment succeeds — nothing to schedule there, so that path
    is untouched). Real Dodo call, not a local-only flag:
    `subscriptions.change_plan(effective_at="next_billing_date")`, the
    SDK's own documented mechanism for a scheduled change (confirmed
    live via `inspect.signature`, same discipline as every other Dodo
    call in this file). `proration_billing_mode="full_immediately"` —
    the ONLY mode Dodo's real API accepts alongside
    `effective_at="next_billing_date"` (confirmed live: `do_not_bill`
    was rejected with a 422 `INVALID_PRORATION_MODE_WITH_NEXT_BILLING_DATE`).
    Despite the name, nothing is charged right now — it describes how
    the new plan is billed once the change actually takes effect at
    the next renewal (the full new-plan price then, not a prorated
    partial charge), not an immediate charge today.

    Reuses `pending_plan_id`/`pending_plan_name` for a SCHEDULED
    change the same way it already means "in-flight checkout" — same
    "the plan this subscription is moving TO" concept either way.
    `sync_subscription_from_dodo`'s existing `dodo_sub.product_id`
    match-and-clear logic picks up the real switch once Dodo actually
    applies it at the next billing date, no separate code path needed.

    Requires an existing real Dodo subscription — raises DodoError if
    called against a still-Free (never-subscribed) account; the
    caller (routers/billing.py) is expected to route a Free-plan user
    through `start_checkout` instead."""

    if not subscription.dodo_subscription_id:
        raise DodoError("no active Dodo subscription to change — start a checkout instead")
    product_id = await ensure_product_for_plan(db, new_plan)
    if product_id is None:
        raise DodoError(f"plan {new_plan.name!r} has no price — nothing to change to")

    client = _client()
    try:
        await client.subscriptions.change_plan(
            subscription.dodo_subscription_id,
            product_id=product_id,
            proration_billing_mode="full_immediately",
            quantity=1,
            effective_at="next_billing_date",
        )
    except Exception as exc:
        raise DodoError(f"could not schedule the plan change: {exc}") from exc

    subscription.pending_plan_id = new_plan.id
    # A change scheduled while a cancellation was also scheduled
    # supersedes it — Dodo's own `change_plan` call already implies
    # "keep this subscription running," so the local flag has to agree
    # rather than the next sync finding a plan mismatch and a
    # cancel-at-period-end flag that no longer describes the account's
    # real intent.
    subscription.cancel_at_period_end = False
    db.commit()
    return subscription


async def undo_pending_plan_change(db: Session, *, subscription: Subscription) -> Subscription:
    """Cancels a scheduled (not-yet-effective) plan change made via
    change_subscription_plan above — `subscriptions.cancel_change_plan`,
    confirmed live via `inspect.signature` (no body, just the
    subscription id). A no-op, not an error, if nothing is actually
    pending — Dodo's own call is safe to make either way, and the
    local flag just gets cleared."""

    if subscription.dodo_subscription_id and subscription.pending_plan_id is not None:
        client = _client()
        try:
            await client.subscriptions.cancel_change_plan(subscription.dodo_subscription_id)
        except Exception as exc:
            raise DodoError(f"could not undo the scheduled plan change: {exc}") from exc
    subscription.pending_plan_id = None
    db.commit()
    return subscription


async def cancel_subscription(db: Session, *, subscription: Subscription) -> Subscription:
    """Schedules cancellation at the end of the current billing period
    — confirmed directly with Adrian: cancel always takes effect at
    the next cycle, never immediately (the user keeps what they
    already paid for until it actually ends). Real Dodo call:
    `subscriptions.update(cancel_at_next_billing_date=True)` (confirmed
    live via `inspect.signature`); Dodo itself will move the
    subscription to `status="cancelled"` at that date, which
    sync_subscription_from_dodo's existing status handling then
    reverts `plan_id` back to the Free tier for — see that function's
    own comment. Also clears any scheduled plan change — cancelling
    supersedes an upgrade/downgrade that hasn't taken effect yet."""

    if not subscription.dodo_subscription_id:
        raise DodoError("no active Dodo subscription to cancel")
    client = _client()
    try:
        await client.subscriptions.update(subscription.dodo_subscription_id, cancel_at_next_billing_date=True)
    except Exception as exc:
        raise DodoError(f"could not schedule cancellation: {exc}") from exc

    subscription.cancel_at_period_end = True
    subscription.pending_plan_id = None
    db.commit()
    return subscription


async def undo_cancel_subscription(db: Session, *, subscription: Subscription) -> Subscription:
    """Undoes a scheduled cancellation — `subscriptions.update(
    cancel_at_next_billing_date=False)`. A no-op, not an error, if
    nothing was actually scheduled."""

    if subscription.dodo_subscription_id and subscription.cancel_at_period_end:
        client = _client()
        try:
            await client.subscriptions.update(subscription.dodo_subscription_id, cancel_at_next_billing_date=False)
        except Exception as exc:
            raise DodoError(f"could not undo the scheduled cancellation: {exc}") from exc
    subscription.cancel_at_period_end = False
    db.commit()
    return subscription


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

    # Captured before either gets overwritten below — Phase 16's credit
    # grant needs to tell "first activation onto this plan" and "same
    # plan, real period rollover" apart from "just re-synced, nothing
    # actually changed" (a plain re-sync must never re-grant).
    previous_plan_id = subscription.plan_id
    previous_period_start = subscription.current_period_start

    subscription.dodo_subscription_id = dodo_sub.subscription_id
    _set_subscription_customer_id(subscription, dodo_sub.customer.customer_id)
    subscription.status = dodo_sub.status
    subscription.current_period_start = dodo_sub.previous_billing_date
    subscription.current_period_end = dodo_sub.next_billing_date
    # Mirrored straight from Dodo's own response field, never trusted
    # from our own optimistic write alone (cancel_subscription/
    # undo_cancel_subscription above set it too, but this is the real
    # sync path that keeps it honest against whatever Dodo's dashboard
    # or a webhook-driven change actually did).
    subscription.cancel_at_period_end = dodo_sub.cancel_at_next_billing_date

    if dodo_sub.status == "active":
        # Leftover from the dodo_product_id_test/_live split — this
        # used to filter on the old shared `dodo_product_id` column,
        # which no longer exists at all (would have raised on the very
        # next real sync). Matches against whichever of the two id
        # columns corresponds to the environment `dodo_sub` was
        # actually fetched from (the same one `_client()` just talked
        # to), same as plan_product_id's own read side.
        id_column = Plan.dodo_product_id_live if _environment() == "live_mode" else Plan.dodo_product_id_test
        plan = db.query(Plan).filter(id_column == dodo_sub.product_id).one_or_none()
        if plan is not None:
            subscription.plan_id = plan.id
            subscription.pending_plan_id = None
            # Phase 16 — grant credits exactly on a real activation or
            # rollover event, never on a plain re-sync that changed
            # nothing: either this subscription just moved onto a
            # DIFFERENT plan (a brand-new subscription, or an upgrade/
            # downgrade actually taking effect), or it's the SAME plan
            # but the billing period genuinely advanced (a real
            # rollover, not just calling sync again mid-period).
            plan_changed = plan.id != previous_plan_id
            period_advanced = (
                subscription.current_period_start is not None
                and subscription.current_period_start != previous_period_start
            )
            if plan_changed or period_advanced:
                credit_ledger.grant_monthly_credits(db, user_id=subscription.user_id, plan=plan)
                # Adrian, direct: "email notification for any purchase
                # whether its subscription or buy credits" — fires on
                # exactly the same activation/rollover condition the
                # credit grant above just did, `renewed` distinguishing
                # a same-plan rollover from a first activation/plan
                # change so the copy doesn't say "renewed" for a brand
                # new subscription. Best-effort, same non-blocking
                # treatment as every other email in this codebase — a
                # flaky provider must never break the real billing sync.
                await _send_purchase_email_best_effort(
                    db, subscription=subscription, plan=plan, renewed=(not plan_changed and period_advanced)
                )
    elif dodo_sub.status in ("cancelled", "expired"):
        # A scheduled cancel_subscription (above) reaching its actual
        # end date, or a subscription that lapsed some other way (a
        # failed renewal Dodo gave up retrying) — either way, this
        # account genuinely has no active paid subscription any more
        # and belongs back on the Free tier, not left pointing at a
        # plan_id it's no longer really paying for. Never re-grants
        # credits here — falling back to Free is a downgrade, not an
        # activation; the Free plan's own one-time grant already
        # happened at signup (credit_ledger.grant_monthly_credits'
        # own docstring).
        free_plan = default_plan(db)
        if free_plan is not None and subscription.plan_id != free_plan.id:
            # Adrian, direct: "notification if their subscription runs
            # out to ask to renew" — the plan that just ended, looked
            # up by `previous_plan_id` (captured above, before this
            # line overwrites `subscription.plan_id` to Free) so the
            # email names the real plan, not "Free".
            ended_plan = db.get(Plan, previous_plan_id)
            if ended_plan is not None:
                await _send_subscription_ended_email_best_effort(db, subscription=subscription, plan=ended_plan)
            subscription.plan_id = free_plan.id
        subscription.pending_plan_id = None
        subscription.cancel_at_period_end = False

    db.commit()
    return subscription


async def _send_purchase_email_best_effort(
    db: Session, *, subscription: Subscription, plan: Plan, renewed: bool
) -> None:
    user = db.get(User, subscription.user_id)
    if user is None:
        return
    try:
        await email_service.send_subscription_purchase_email(
            to=user.email,
            plan_name=plan.name,
            price_idr=plan.price_idr,
            monthly_credits=plan.monthly_credits,
            renewed=renewed,
            billing_url=f"{_frontend_url()}/console/billing",
        )
    except (RuntimeError, email_service.EmailSendError):
        pass


async def _send_subscription_ended_email_best_effort(db: Session, *, subscription: Subscription, plan: Plan) -> None:
    user = db.get(User, subscription.user_id)
    if user is None:
        return
    try:
        await email_service.send_subscription_ended_email(
            to=user.email, plan_name=plan.name, billing_url=f"{_frontend_url()}/console/billing"
        )
    except (RuntimeError, email_service.EmailSendError):
        pass


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
        # A webhook only ever fires from whichever mode it's actually
        # configured for — matches against the customer-id column for
        # the environment this server is currently running as, same as
        # subscription_customer_id's own read side.
        id_column = (
            Subscription.dodo_customer_id_live if _environment() == "live_mode" else Subscription.dodo_customer_id_test
        )
        return db.query(Subscription).filter(id_column == dodo_customer_id).one_or_none()
    return None


def current_period_spend_usd(db: Session, *, user_id: uuid.UUID, subscription: Subscription | None) -> float:
    spend = (
        db.query(func.coalesce(func.sum(LlmCall.cost_usd), 0))
        .filter(LlmCall.user_id == user_id, LlmCall.created_at >= period_start(subscription))
        .scalar()
    )
    return float(spend or 0)


# `enforce_usage_cap` (the real `$`-cap dependency this replaced) is
# gone entirely, model column included (models/billing.py) — Adrian,
# direct: it had zero call sites left since Phase 16's credit_ledger.py
# (`require_credits`/`charge_credits`) took over every gate this used
# to sit on; it was pure vestige, still showing up as "internal cap $X"
# in the admin Plans page with nothing behind it. `current_period_spend_usd`
# above stays — real admin-facing cost visibility, not a cap.
