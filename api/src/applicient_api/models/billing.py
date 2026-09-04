"""SaaS pivot — flat subscription tiers, billed through Dodo Payments
(merchant-of-record; approvable without a US entity/bank account,
unlike Stripe, and supports individuals with no registered company —
see docs/PRD or the plan doc for why this replaced Xendit). Deliberately
not metered/usage-based: pricing is a small fixed set of `Plan` rows
each carrying a hardcoded usage cap enforced against the existing
`LlmCall` cost ledger (F13) rather than a real per-request metering
integration.
"""

import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from applicient_api.db import Base, TimestampMixin, UUIDPKMixin, UserScopedMixin


class Plan(UUIDPKMixin, TimestampMixin, Base):
    """Not user-scoped — a small, admin-managed, shared set of tiers
    every user picks from (mirrors ModelCatalogEntry's "not user-scoped
    directly" reasoning). Editable through the admin back-office rather
    than hardcoded, so pricing/caps can change without a deploy."""

    __tablename__ = "plans"

    name: Mapped[str] = mapped_column(String(60), nullable=False)  # e.g. "Open to Work", "Unemployed"
    price_idr: Mapped[int] = mapped_column(Integer, nullable=False, default=0)  # smallest unit (Rupiah, no decimals)
    # `monthly_usage_cap_usd` (a real `$` cap column) removed entirely
    # (Adrian, direct — "why do users per tier still have internal
    # cap, remove that entirely"): it was genuinely vestigial, not
    # just hidden from regular users — `enforce_usage_cap`, the only
    # code that ever read it, had zero call sites since Phase 16
    # replaced it with `require_credits`/`charge_credits`; it just
    # kept showing up in the admin Plans page as "internal cap $X"
    # with nothing behind it. `monthly_credits` is the real, only cap
    # that does anything now — the number granted to the user each
    # period (or once, for the Free plan — see credit_ledger.py's own
    # docstring), admin-tunable independent of any `$` figure.
    monthly_credits: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)  # selectable at signup/upgrade
    # Dodo's own Product — auto-created on demand
    # (billing_service.ensure_product_for_plan) when empty, or set
    # directly through the admin Plans page for a product that already
    # exists in Dodo's dashboard. Split test/live rather than one
    # shared column: Dodo's test and live modes are fully separate
    # catalogs (a product made in one mode simply doesn't exist in the
    # other), so a single column meant switching DODO_PAYMENTS_ENVIRONMENT
    # would blindly reuse a test-mode product id against the live API
    # (or vice versa) — exactly what broke checkout after Adrian moved
    # the real products over to live mode. billing_service picks
    # whichever of these matches the server's current environment;
    # null for the free plan (price_idr == 0) in either case, since
    # there's nothing to check out for a $0 tier.
    dodo_product_id_test: Mapped[str | None] = mapped_column(String(120))
    dodo_product_id_live: Mapped[str | None] = mapped_column(String(120))


class Subscription(UUIDPKMixin, TimestampMixin, UserScopedMixin, Base):
    """One row per user — the user's current plan and Dodo billing
    state. `user_id` (via UserScopedMixin) has no unique constraint at
    the DB level; the service layer enforces "one active subscription
    per user" the same way every other UserScopedMixin table in this
    codebase leaves cross-table integrity to the app layer, not a FK."""

    __tablename__ = "subscriptions"

    plan_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("plans.id", ondelete="RESTRICT"), nullable=False)
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="active")  # pending/active/on_hold/paused/cancelled/failed/expired/past_due
    # Same split-by-environment reasoning as Plan.dodo_product_id_test/
    # _live above — a Dodo customer is also test/live-scoped, so
    # `_ensure_customer`'s cache-check (billing_service.py) would
    # otherwise reuse a test-mode customer id against the live API (or
    # vice versa) the moment DODO_PAYMENTS_ENVIRONMENT changes for a
    # user who was ever exercised in the other mode — the exact next
    # failure after the product-id one (raised directly by Adrian).
    dodo_customer_id_test: Mapped[str | None] = mapped_column(String(120))
    dodo_customer_id_live: Mapped[str | None] = mapped_column(String(120))
    current_period_start: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    current_period_end: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    # Dodo's checkout session for a subscription product creates the
    # real Subscription object directly once payment succeeds — a
    # single artifact, unlike Xendit's two-step token+recurring-plan
    # dance this replaced. `dodo_checkout_session_id` is only needed
    # while `pending_plan_id` is set (the in-flight window before a
    # real `dodo_subscription_id` exists); `dodo_subscription_id` is
    # what every later sync (webhook or manual) polls by.
    dodo_checkout_session_id: Mapped[str | None] = mapped_column(String(120))
    dodo_subscription_id: Mapped[str | None] = mapped_column(String(120))
    # The plan an in-progress checkout is upgrading *to* — distinct from
    # `plan_id` (the currently active plan) so a user mid-checkout stays
    # on their current plan/cap until the Dodo subscription is actually
    # confirmed active, not the moment they click "upgrade."
    pending_plan_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("plans.id", ondelete="SET NULL")
    )
    # Upgrade/downgrade/cancel (Adrian, direct: "should only apply in
    # the next billing cycle, except free -> paid, which applies
    # immediately") — mirrors Dodo's own `cancel_at_next_billing_date`
    # field on its Subscription object 1:1, re-synced on every real
    # sync (billing_service.sync_subscription_from_dodo), not written
    # optimistically and trusted forever. A scheduled PLAN CHANGE
    # (upgrade or downgrade to a different paid plan) reuses
    # `pending_plan_id` above rather than a second column — same
    # "the plan this subscription is moving TO" meaning either way,
    # just a Dodo `change_plan(effective_at="next_billing_date")` call
    # instead of a fresh checkout. This column is specifically for the
    # "cancel down to Free" case, which has no product/plan to point
    # `pending_plan_id` at.
    cancel_at_period_end: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)


class FeatureCreditCost(UUIDPKMixin, TimestampMixin, Base):
    """Phase 16 — how many credits a single use of a given AI feature
    costs. Not user-scoped (a shared, admin-managed price list, same
    pattern as `Plan` and `ModelCatalogEntry`) and deliberately decoupled
    from real per-call `$` cost (`LlmCall.cost_usd`) — a fixed, simple,
    predictable number per feature, not a precise per-token bill. `key`
    is what credit_ledger.py's `require_credits`/`charge_credits` look
    up by (e.g. "cv-tailor", "interview-practice"); CV parsing has no
    row here at all — it's deliberately free, not priced at 0."""

    __tablename__ = "feature_credit_costs"

    key: Mapped[str] = mapped_column(String(60), nullable=False, unique=True)
    display_name: Mapped[str] = mapped_column(String(120), nullable=False)
    credit_cost: Mapped[int] = mapped_column(Integer, nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)


class CreditPack(UUIDPKMixin, TimestampMixin, Base):
    """Phase 16 — a standalone, one-time credit purchase. Mirrors `Plan`'s
    own shape deliberately (name/price/Dodo product ids split by
    environment) so checkout creation can reuse the exact same
    find-or-create-product logic (`ensure_product_for_plan`) — the only
    real difference from a `Plan` checkout is the Dodo price type
    (one-time, not recurring) and that it never touches `Subscription`
    at all. Purchased credits never expire (confirmed with Adrian) —
    landed in `CreditTransaction.bucket="purchased"`, never swept."""

    __tablename__ = "credit_packs"

    name: Mapped[str] = mapped_column(String(60), nullable=False)  # e.g. "Small", "Medium", "Large"
    price_idr: Mapped[int] = mapped_column(Integer, nullable=False)
    credits: Mapped[int] = mapped_column(Integer, nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    dodo_product_id_test: Mapped[str | None] = mapped_column(String(120))
    dodo_product_id_live: Mapped[str | None] = mapped_column(String(120))


class CreditTransaction(UUIDPKMixin, TimestampMixin, UserScopedMixin, Base):
    """Phase 16 — the single source of truth for a user's credit
    balance. Append-only, never updated — same "recompute from the
    ledger, never trust a denormalized copy" discipline
    `current_period_spend_usd` already applies to `$` spend today, just
    for credits. A user's balance is always `SUM(amount)`, optionally
    filtered by `bucket`; there is no separate balance column anywhere
    else to drift out of sync with this table. See credit_ledger.py for
    the functions that write these rows and the reasoning behind
    `bucket`'s two values."""

    __tablename__ = "credit_transactions"

    # monthly_grant | purchase | usage | admin_grant | admin_adjustment | expiration
    type: Mapped[str] = mapped_column(String(20), nullable=False)
    # "monthly" — swept to 0 at the next period rollover (monthly_grant,
    # and any usage that drew from it). "purchased" — never swept
    # (purchase, admin_grant/admin_adjustment, and any usage that drew
    # from it) — this is what actually implements "purchased credits
    # never expire" without needing per-row expiry dates: a period
    # rollover only ever touches bucket="monthly" rows.
    bucket: Mapped[str] = mapped_column(String(20), nullable=False)
    amount: Mapped[int] = mapped_column(Integer, nullable=False)  # signed: + grant/purchase, - usage/expiration/deduction
    balance_after: Mapped[int] = mapped_column(Integer, nullable=False)  # running total in `bucket`, after this row
    description: Mapped[str] = mapped_column(String(255), nullable=False)
    admin_user_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"))
    feature_key: Mapped[str | None] = mapped_column(String(60))
    agent_run_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("agent_runs.id", ondelete="SET NULL"))
    credit_purchase_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("credit_packs.id", ondelete="SET NULL")
    )
    # Set only for type="purchase" rows — the real idempotency key for
    # record_purchase (credit_ledger.py): a webhook retry, or the
    # webhook and the frontend's own manual confirm both landing for
    # the SAME real Dodo payment, must never credit twice.
    # credit_purchase_id alone can't tell "duplicate event for this
    # purchase" apart from "a genuine second purchase of the same
    # pack" — this can.
    dodo_payment_id: Mapped[str | None] = mapped_column(String(120), unique=True)
