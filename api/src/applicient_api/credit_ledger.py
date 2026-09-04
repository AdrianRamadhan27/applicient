"""Phase 16 — the credit-based billing layer users actually see and pay
with. Deliberately separate from, and never derived from, the precise
per-token `$` cost tracking (`LlmCall.cost_usd`, billing_service.py's own
`current_period_spend_usd`) — that stays exactly as it was, admin/internal
real-cost visibility only (`cost.py`, the admin users list). Credits are
a coarser, fixed-cost-per-feature accounting layer on top of a real,
append-only transaction ledger (`CreditTransaction`) — there is no cached
balance column anywhere; a user's balance is always recomputed as
SUM(amount) over their own rows, same "recompute from the ledger, never
trust a denormalized copy" discipline billing_service.py already applies
to `$` spend, just for credits.

Two buckets, not one, because "purchased credits never expire but monthly
credits reset each period" (both confirmed directly with Adrian) can't be
represented by a single running total — `bucket="monthly"` is swept to 0
at every period rollover (grant_monthly_credits), `bucket="purchased"`
never is (purchases, and admin grants/adjustments, which should behave
like a permanent adjustment too, not evaporate at the next rollover).
Spending always drains "monthly" first, "purchased" only for whatever's
left over — strictly better for the user than the other order.
"""

from __future__ import annotations

import uuid

from fastapi import Depends, HTTPException
from sqlalchemy import func, text
from sqlalchemy.orm import Session

from applicient_api.deps import current_user_id, get_db
from applicient_api.models.billing import CreditPack, CreditTransaction, FeatureCreditCost, Plan

# Canonical feature keys — routers import these rather than typing the
# string literal at each call site, so a typo can't silently create a
# second, never-priced, always-free "feature" by accident. CV parsing
# deliberately has none: no FeatureCreditCost row for it, ever, on the
# house per Adrian — cv_review_service.py's own CV SCORING joins it
# there for the same reason (confirmed directly), while CV FIXING
# below does get priced (a real, lasting evidence-bank rewrite, not
# just a read).
FEATURE_CV_TAILOR = "cv-tailor"
FEATURE_CV_FIX = "cv-fix"
FEATURE_COVER_LETTER = "cover-letter"
FEATURE_ANSWER_PACK = "answer-pack"
FEATURE_RADAR_RUN = "radar-run"
FEATURE_APPLICATION_APPLY = "application-apply"
FEATURE_INTERVIEW_PRACTICE = "interview-practice"
FEATURE_SKILL_GAP_SYLLABUS = "skill-gap-syllabus"

_BUCKET_MONTHLY = "monthly"
_BUCKET_PURCHASED = "purchased"


def _lock_user_credits(db: Session, user_id: uuid.UUID) -> None:
    """A coarse but real fix for the read-balance-then-write-transaction
    race two concurrent credit-mutating calls for the same user could
    otherwise hit (checked balance, both proceed, total goes negative).
    A Postgres advisory lock scoped to this DB transaction and this
    user only — released automatically on commit/rollback, never held
    across requests. Cheap enough to always take before any write here
    depends on a balance read."""

    db.execute(text("SELECT pg_advisory_xact_lock(hashtext(:key))"), {"key": str(user_id)})


def _bucket_balance(db: Session, *, user_id: uuid.UUID, bucket: str) -> int:
    total = (
        db.query(func.coalesce(func.sum(CreditTransaction.amount), 0))
        .filter(CreditTransaction.user_id == user_id, CreditTransaction.bucket == bucket)
        .scalar()
    )
    return int(total or 0)


def get_balance(db: Session, *, user_id: uuid.UUID) -> dict:
    monthly = _bucket_balance(db, user_id=user_id, bucket=_BUCKET_MONTHLY)
    purchased = _bucket_balance(db, user_id=user_id, bucket=_BUCKET_PURCHASED)
    return {"monthly": monthly, "purchased": purchased, "total": monthly + purchased}


def get_feature_cost_row(db: Session, feature_key: str) -> FeatureCreditCost | None:
    """Public counterpart to `_feature_cost` below, for callers that
    need the real display name too, not just the integer cost —
    orchestrator_service.py's own pre-flight interrupt descriptions
    (see build_credit_interrupt_descriptions) are the reason this
    exists."""

    return db.query(FeatureCreditCost).filter_by(key=feature_key, is_active=True).one_or_none()


def _feature_cost(db: Session, feature_key: str) -> int:
    row = db.query(FeatureCreditCost).filter_by(key=feature_key, is_active=True).one_or_none()
    if row is None:
        # No priced row at all (or deactivated) = deliberately free —
        # never blocks, never charges. CV parsing's whole point, and
        # also the easiest way for an admin to make something free
        # again later without deleting its cost-history rows.
        return 0
    return row.credit_cost


def _write_transaction(
    db: Session,
    *,
    user_id: uuid.UUID,
    type_: str,
    bucket: str,
    amount: int,
    description: str,
    admin_user_id: uuid.UUID | None = None,
    feature_key: str | None = None,
    agent_run_id: uuid.UUID | None = None,
    credit_purchase_id: uuid.UUID | None = None,
    dodo_payment_id: str | None = None,
) -> CreditTransaction:
    new_balance = _bucket_balance(db, user_id=user_id, bucket=bucket) + amount
    row = CreditTransaction(
        user_id=user_id,
        type=type_,
        bucket=bucket,
        amount=amount,
        balance_after=new_balance,
        description=description,
        admin_user_id=admin_user_id,
        feature_key=feature_key,
        agent_run_id=agent_run_id,
        credit_purchase_id=credit_purchase_id,
        dodo_payment_id=dodo_payment_id,
    )
    db.add(row)
    db.commit()
    return row


def _insufficient_message(label: str) -> str:
    return f"Not enough credits for {label} — upgrade your plan or buy more credits to continue."


def has_used_feature_before(db: Session, *, user_id: uuid.UUID, feature_key: str) -> bool:
    """The one signal first-use-free logic trusts — whether this user
    has ever been charged (`type="usage"`) OR already had a first use
    marked free (`type="first_use_free"`) for this exact feature.
    Including `first_use_free` itself is what makes this idempotent:
    the very act of granting a free first use is what makes the
    SECOND use no longer free — without it, a feature that's never
    actually deducted anything (only ever writes `$0` marker rows)
    would look "never used" forever and stay free indefinitely."""

    return (
        db.query(CreditTransaction.id)
        .filter(
            CreditTransaction.user_id == user_id,
            CreditTransaction.feature_key == feature_key,
            CreditTransaction.type.in_(("usage", "first_use_free")),
        )
        .first()
        is not None
    )


def insufficient_credits_message(db: Session, *, user_id: uuid.UUID, feature_key: str, label: str | None = None) -> str | None:
    """The actual check behind `require_credits` below, factored out
    as a plain function (no `Depends()`/HTTP coupling) so a caller that
    ISN'T a FastAPI route can run the exact same check. The orchestrator
    agent's own tools (orchestrator_tools.py) are the real reason this
    exists: `run_discovery`/`tailor_cv`/etc. call straight into the
    same shared service functions the HTTP routes do (`run_radar_search`,
    `tailor_job_group`, ...), bypassing `require_credits`'s route-level
    gate entirely — without this, a 0-balance account could still
    trigger a full expensive run through the Assistant, wasting the
    work, with the (already-wired) `charge_credits` call only failing
    at the very end. Returns a human-readable message if the balance
    doesn't cover it, else None.

    A first-ever use of `feature_key` never blocks, regardless of
    balance (Adrian, direct: "for first time users each of the
    features cost no credit at all first time using it. This is to
    ensure they can finish onboarding without running out of
    credits") — a brand-new account with 0 purchased credits and an
    exhausted monthly grant should still be able to try every feature
    once. The matching charge_credits call below is what actually
    honors this by writing $0 instead of a real deduction."""

    cost = _feature_cost(db, feature_key)
    if cost <= 0:
        return None
    if not has_used_feature_before(db, user_id=user_id, feature_key=feature_key):
        return None
    balance = get_balance(db, user_id=user_id)
    if balance["total"] < cost:
        return _insufficient_message(label or feature_key)
    return None


def require_credits(feature_key: str, *, label: str | None = None):
    """FastAPI dependency FACTORY — `Depends(require_credits(FEATURE_CV_TAILOR))`
    at a route, same `dependencies=[...]` shape `enforce_usage_cap` used
    before it. A pure balance CHECK, never mutates anything — the
    matching `charge_credits(...)` call happens explicitly wherever that
    route's own stream logs success. Kept as two separate steps (not one
    check-and-charge) specifically so interview practice can check at
    `/start` but only actually charge once, at real session completion —
    see `interview_service.py`."""

    def _dep(db: Session = Depends(get_db), user_id: uuid.UUID = Depends(current_user_id)) -> None:
        message = insufficient_credits_message(db, user_id=user_id, feature_key=feature_key, label=label)
        if message:
            raise HTTPException(402, message)

    return _dep


def charge_credits(
    db: Session, *, user_id: uuid.UUID, feature_key: str, agent_run_id: uuid.UUID | None = None, label: str | None = None
) -> None:
    """Deducts the fixed cost of one use of `feature_key` — drains
    `bucket="monthly"` first, falls back to `bucket="purchased"` only
    for whatever the monthly balance doesn't cover. A no-op (writes
    nothing) if the feature has no priced row. Raises the same 402
    shape `require_credits` does if the balance somehow doesn't cover
    it — shouldn't happen (the route's own `require_credits` dependency
    already gated this request), but this never silently goes negative
    even under the rare race `_lock_user_credits` doesn't fully close
    across separate requests without a shared lock scope.

    Idempotent per `agent_run_id` when one is passed — some features
    (the application agent especially: several distinct terminal states
    across a start + one or more resume calls, all sharing one
    `AgentRun`) could otherwise reach a "successful" branch more than
    once for the SAME real attempt; passing the same `agent_run_id`
    every time makes a second call here a safe no-op instead of a
    double charge (covers both a real charge AND a first-use-free
    marker below — a retried call for the same run must not grant a
    second free pass any more than it should double-charge).

    The user's first-ever use of `feature_key` is free — writes a real
    `$0` `first_use_free` transaction (never a silent no-op: that row
    is what `insufficient_credits_message`/this function's own next
    call use to know the free pass has already been spent) instead of
    the real deduction below. Adrian, direct: onboarding shouldn't be
    something a brand-new, 0-purchased-credits account can run out of
    credits partway through."""

    cost = _feature_cost(db, feature_key)
    if cost <= 0:
        return
    if agent_run_id is not None:
        already_charged = (
            db.query(CreditTransaction.id)
            .filter_by(agent_run_id=agent_run_id, feature_key=feature_key)
            .filter(CreditTransaction.type.in_(("usage", "first_use_free")))
            .first()
        )
        if already_charged is not None:
            return
    _lock_user_credits(db, user_id)

    display_label = label or feature_key
    if not has_used_feature_before(db, user_id=user_id, feature_key=feature_key):
        _write_transaction(
            db, user_id=user_id, type_="first_use_free", bucket=_BUCKET_MONTHLY, amount=0,
            description=f"First use of {display_label} — free (on the house)",
            feature_key=feature_key, agent_run_id=agent_run_id,
        )
        return

    balance = get_balance(db, user_id=user_id)
    if balance["total"] < cost:
        raise HTTPException(402, _insufficient_message(display_label))

    from_monthly = min(balance["monthly"], cost)
    from_purchased = cost - from_monthly
    if from_monthly > 0:
        _write_transaction(
            db, user_id=user_id, type_="usage", bucket=_BUCKET_MONTHLY, amount=-from_monthly,
            description=f"Used: {display_label}", feature_key=feature_key, agent_run_id=agent_run_id,
        )
    if from_purchased > 0:
        _write_transaction(
            db, user_id=user_id, type_="usage", bucket=_BUCKET_PURCHASED, amount=-from_purchased,
            description=f"Used: {display_label}", feature_key=feature_key, agent_run_id=agent_run_id,
        )


def grant_monthly_credits(db: Session, *, user_id: uuid.UUID, plan: Plan) -> None:
    """Called at subscription activation and at every real period
    rollover (billing_service.sync_subscription_from_dodo), AND once at
    signup for a brand-new user's starting plan (Free included). First
    sweeps whatever's left of the PREVIOUS `bucket="monthly"` balance to
    0 via a logged `expiration` row — this is what "credits reset each
    period" actually means here: a real transaction, not a silent
    forget — then grants the new allotment. Never touches
    `bucket="purchased"`. Safe to call for the Free plan: nothing ever
    calls this a SECOND time for a user who stays on Free (there's no
    real Dodo subscription behind it, so no rollover event ever fires),
    which is exactly what makes the Free grant a one-time, non-refreshing
    allotment without needing a special case here."""

    _lock_user_credits(db, user_id)
    leftover = _bucket_balance(db, user_id=user_id, bucket=_BUCKET_MONTHLY)
    if leftover > 0:
        _write_transaction(
            db, user_id=user_id, type_="expiration", bucket=_BUCKET_MONTHLY, amount=-leftover,
            description="Unused monthly credits expired at period reset",
        )
    if plan.monthly_credits > 0:
        _write_transaction(
            db, user_id=user_id, type_="monthly_grant", bucket=_BUCKET_MONTHLY, amount=plan.monthly_credits,
            description=f"Monthly credits — {plan.name} plan",
        )


def admin_adjust_credits(db: Session, *, user_id: uuid.UUID, admin_user_id: uuid.UUID, amount: int, reason: str) -> CreditTransaction:
    """The ONLY way credits ever move for an admin-initiated grant or
    deduction — there is no balance column to PATCH, only a new ledger
    row (raised directly by Adrian: it must show up in the user's own
    transaction log as a real, attributed action — "Granted by admin"/
    "Deducted by admin" — not a silent value edit). Always
    `bucket="purchased"`: an admin adjustment should behave like a
    permanent one, never swept at the next ordinary monthly rollover."""

    if amount == 0:
        raise HTTPException(422, "amount must be nonzero")
    _lock_user_credits(db, user_id)
    verb = "Granted" if amount > 0 else "Deducted"
    type_ = "admin_grant" if amount > 0 else "admin_adjustment"
    return _write_transaction(
        db, user_id=user_id, type_=type_, bucket=_BUCKET_PURCHASED, amount=amount,
        description=f"{verb} by admin — {reason}", admin_user_id=admin_user_id,
    )


def record_purchase(db: Session, *, user_id: uuid.UUID, pack: CreditPack, dodo_payment_id: str) -> None:
    """Called once a one-time Dodo payment for `pack` is confirmed
    (webhook or manual sync — see billing_service.py's own one-time-
    payment branch, both of which can plausibly fire for the SAME real
    payment — a webhook retry, or the webhook and the frontend's manual
    confirm both landing). Idempotent on `dodo_payment_id` (a unique
    column) — a second call for a payment already credited is a safe
    no-op, never a double-credit. Always `bucket="purchased"` — never
    expires, per Adrian."""

    already = db.query(CreditTransaction.id).filter_by(dodo_payment_id=dodo_payment_id).first()
    if already is not None:
        return
    _lock_user_credits(db, user_id)
    # Re-check inside the lock — the pre-lock check above is just a
    # cheap fast path, this one is the real guard against a genuine race.
    already = db.query(CreditTransaction.id).filter_by(dodo_payment_id=dodo_payment_id).first()
    if already is not None:
        return
    _write_transaction(
        db, user_id=user_id, type_="purchase", bucket=_BUCKET_PURCHASED, amount=pack.credits,
        description=f"Purchased: {pack.name} credit pack", credit_purchase_id=pack.id,
        dodo_payment_id=dodo_payment_id,
    )
