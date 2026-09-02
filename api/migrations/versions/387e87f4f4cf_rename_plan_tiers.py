"""rename_plan_tiers

Revision ID: 387e87f4f4cf
Revises: f1a4d8e2c6b3
Create Date: 2026-09-02 00:00:00.000001

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '387e87f4f4cf'
down_revision: Union[str, Sequence[str], None] = 'f1a4d8e2c6b3'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

# Renames the three placeholder tier names f3a8c1d9e6b2 seeded
# (Free/Pro/Team — "not meant to be the final real pricing", per that
# migration's own comment) to the real names Adrian picked, in
# ascending price order: Open to Work (free) -> Unemployed (mid) ->
# Super Unemployed (top, previously "Team" — dropped since this is a
# single-user-per-account SaaS with no team/seat concept at all).
#
# Also lowers Unemployed/Super Unemployed's usage cap and price
# together (Adrian's follow-up ask, folded into this same migration
# since neither had been applied/deployed yet) — repriced around
# Dodo Payments' real fee schedule (4% + $0.40/transaction, +0.5% for
# subscriptions specifically — confirmed against Dodo's own pricing
# page, not assumed) for a ~5-10% profit margin over the worst case
# (a subscriber using their entire cap every month) at an assumed
# ~Rp 16,000/USD — a snapshot, not pinned; revisit if the real rate
# drifts far from that or Dodo's fee schedule changes:
#   Unemployed:       cap $5.00/mo,  price Rp 96,000  (~$6.00 equiv,
#                      net after fees ~$5.33 -> ~6.2% margin)
#   Super Unemployed:  cap $15.00/mo, price Rp 280,000 (~$17.50 equiv,
#                      net after fees ~$16.31 -> ~8.0% margin)
# Matched by the exact old/new name rather than by price/position, so
# this is a no-op for a deployment where an admin already renamed
# these through the Plan CRUD screen instead of leaving the seed
# defaults.
_RENAMES = [
    ('Free', 'Open to Work'),
    ('Pro', 'Unemployed'),
    ('Team', 'Super Unemployed'),
]

_REPRICES = [
    # (name, price_idr, monthly_usage_cap_usd)
    ('Unemployed', 96_000, '5.00'),
    ('Super Unemployed', 280_000, '15.00'),
]


def upgrade() -> None:
    for old_name, new_name in _RENAMES:
        op.execute(
            sa.text("UPDATE plans SET name = :new_name WHERE name = :old_name")
            .bindparams(old_name=old_name, new_name=new_name)
        )
    for name, price_idr, cap in _REPRICES:
        op.execute(
            sa.text("UPDATE plans SET price_idr = :price_idr, monthly_usage_cap_usd = CAST(:cap AS numeric) WHERE name = :name")
            .bindparams(name=name, price_idr=price_idr, cap=cap)
        )


def downgrade() -> None:
    # Original f3a8c1d9e6b2 seed values, keyed by the NEW names since
    # the rename below hasn't been reverted yet at this point.
    original = {'Unemployed': (149_000, '10.00'), 'Super Unemployed': (399_000, '30.00')}
    for name, (price_idr, cap) in original.items():
        op.execute(
            sa.text("UPDATE plans SET price_idr = :price_idr, monthly_usage_cap_usd = CAST(:cap AS numeric) WHERE name = :name")
            .bindparams(name=name, price_idr=price_idr, cap=cap)
        )
    for old_name, new_name in _RENAMES:
        op.execute(
            sa.text("UPDATE plans SET name = :old_name WHERE name = :new_name")
            .bindparams(old_name=old_name, new_name=new_name)
        )
