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

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, Numeric, String
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
    monthly_usage_cap_usd: Mapped[float] = mapped_column(Numeric(10, 2), nullable=False)
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
