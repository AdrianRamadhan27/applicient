"""drop_plan_monthly_usage_cap_usd

Revision ID: f3a91c7de220
Revises: 28e12898188f
Create Date: 2026-09-04 08:10:00.000000

Adrian, direct: "why do users per tier still have internal cap, remove
that entirely" — `Plan.monthly_usage_cap_usd` had been fully vestigial
since Phase 16 (credit_ledger.py's require_credits/charge_credits
replaced the only code that ever read it, billing_service.py's own
enforce_usage_cap, which is deleted alongside this column) but kept
showing up in the admin Plans page as "internal cap $X" with nothing
behind it any more.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'f3a91c7de220'
down_revision: Union[str, Sequence[str], None] = '28e12898188f'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.drop_column('plans', 'monthly_usage_cap_usd')


def downgrade() -> None:
    """Downgrade schema."""
    # Restored non-nullable with a real default (100.00) so a downgrade
    # against live rows doesn't fail on NOT NULL with no value to fill
    # in — this column's own real values are gone for good either way,
    # this only exists so `alembic downgrade` doesn't hard-fail.
    op.add_column('plans', sa.Column('monthly_usage_cap_usd', sa.Numeric(10, 2), nullable=False, server_default='100.00'))
    op.alter_column('plans', 'monthly_usage_cap_usd', server_default=None)
