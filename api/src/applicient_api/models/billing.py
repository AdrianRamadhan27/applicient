"""SaaS pivot — flat subscription tiers, billed through Xendit
(Indonesian payment gateway; Stripe isn't approvable without a US
entity/bank account). Deliberately not metered/usage-based: Xendit has
no native metering API, so pricing is a small fixed set of `Plan` rows
each carrying a hardcoded usage cap enforced against the existing
`LlmCall` cost ledger (F13) rather than inventing a separate metering
concept.
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

    name: Mapped[str] = mapped_column(String(60), nullable=False)  # e.g. "Free", "Pro"
    price_idr: Mapped[int] = mapped_column(Integer, nullable=False, default=0)  # smallest unit (Rupiah, no decimals)
    monthly_usage_cap_usd: Mapped[float] = mapped_column(Numeric(10, 2), nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)  # selectable at signup/upgrade


class Subscription(UUIDPKMixin, TimestampMixin, UserScopedMixin, Base):
    """One row per user — the user's current plan and Xendit billing
    state. `user_id` (via UserScopedMixin) has no unique constraint at
    the DB level; the service layer enforces "one active subscription
    per user" the same way every other UserScopedMixin table in this
    codebase leaves cross-table integrity to the app layer, not a FK."""

    __tablename__ = "subscriptions"

    plan_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("plans.id", ondelete="RESTRICT"), nullable=False)
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="active")  # trialing/active/past_due/canceled
    xendit_customer_id: Mapped[str | None] = mapped_column(String(120))
    current_period_start: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    current_period_end: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    # Xendit's real flow for a flat-fee recurring plan is two calls, not
    # one (confirmed against their live API docs, not assumed): a
    # "Pay and Save" hosted checkout session first (collects the first
    # payment AND a reusable payment_token_id), then a separate
    # POST /recurring/plans using that token for every cycle after.
    # These three track that in-flight, two-step process; all null once
    # a plan is fully active and none is pending.
    xendit_payment_session_id: Mapped[str | None] = mapped_column(String(120))
    xendit_payment_token_id: Mapped[str | None] = mapped_column(String(120))
    xendit_recurring_plan_id: Mapped[str | None] = mapped_column(String(120))
    # The plan an in-progress checkout is upgrading *to* — distinct from
    # `plan_id` (the currently active plan) so a user mid-checkout stays
    # on their current plan/cap until the recurring plan is actually
    # confirmed active, not the moment they click "upgrade."
    pending_plan_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("plans.id", ondelete="SET NULL")
    )
