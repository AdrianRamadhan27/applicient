"""saas_roles_and_billing

Revision ID: f3a8c1d9e6b2
Revises: d8e3b5c1f0a9
Create Date: 2026-08-31 00:00:00.000001

"""
import os
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'f3a8c1d9e6b2'
down_revision: Union[str, Sequence[str], None] = 'd8e3b5c1f0a9'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

# Placeholder starter tiers — editable through the admin Plan CRUD
# screen after this migration runs, not meant to be the final real
# pricing. price_idr is the smallest unit (whole Rupiah, no decimals);
# monthly_usage_cap_usd caps against the existing LlmCall.cost_usd sum
# for a user's current billing period.
_DEFAULT_PLANS = [
    ('Free', 0, '1.00'),
    ('Pro', 149000, '10.00'),
    ('Team', 399000, '30.00'),
]


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column('users', sa.Column('role', sa.String(length=20), nullable=False, server_default='user'))
    op.add_column('users', sa.Column('is_active', sa.Boolean(), nullable=False, server_default=sa.true()))
    op.alter_column('users', 'role', server_default=None)
    op.alter_column('users', 'is_active', server_default=None)

    admin_email = os.environ.get('ADMIN_EMAIL', '').strip().lower()
    if admin_email:
        op.execute(
            sa.text("UPDATE users SET role = 'admin' WHERE lower(email) = :email").bindparams(email=admin_email)
        )

    op.create_table(
        'plans',
        sa.Column('name', sa.String(length=60), nullable=False),
        sa.Column('price_idr', sa.Integer(), nullable=False),
        sa.Column('monthly_usage_cap_usd', sa.Numeric(10, 2), nullable=False),
        sa.Column('is_active', sa.Boolean(), nullable=False),
        sa.Column('id', sa.UUID(), server_default=sa.text('gen_random_uuid()'), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.PrimaryKeyConstraint('id', name=op.f('pk_plans')),
    )
    op.create_table(
        'subscriptions',
        sa.Column('plan_id', sa.UUID(), nullable=False),
        sa.Column('status', sa.String(length=20), nullable=False),
        sa.Column('xendit_customer_id', sa.String(length=120), nullable=True),
        sa.Column('current_period_start', sa.DateTime(timezone=True), nullable=True),
        sa.Column('current_period_end', sa.DateTime(timezone=True), nullable=True),
        sa.Column('id', sa.UUID(), server_default=sa.text('gen_random_uuid()'), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('user_id', sa.UUID(), nullable=False),
        sa.PrimaryKeyConstraint('id', name=op.f('pk_subscriptions')),
        sa.ForeignKeyConstraint(['plan_id'], ['plans.id'], name=op.f('fk_subscriptions_plan_id_plans'), ondelete='RESTRICT'),
    )
    op.create_index(op.f('ix_subscriptions_user_id'), 'subscriptions', ['user_id'], unique=False)

    values_sql = ", ".join(f"('{name}', {price}, '{cap}')" for name, price, cap in _DEFAULT_PLANS)
    op.execute(
        sa.text(
            f"""
            INSERT INTO plans (id, name, price_idr, monthly_usage_cap_usd, is_active, created_at, updated_at)
            SELECT gen_random_uuid(), v.name, v.price_idr, v.cap::numeric, true, now(), now()
            FROM (VALUES {values_sql}) AS v(name, price_idr, cap)
            """
        )
    )

    # Every existing user backfills onto the cheapest active plan (the
    # free tier, by convention price_idr = 0) so nothing breaks for
    # accounts that predate billing.
    op.execute(
        sa.text(
            """
            INSERT INTO subscriptions (id, user_id, plan_id, status, created_at, updated_at)
            SELECT gen_random_uuid(), u.id, (SELECT id FROM plans ORDER BY price_idr ASC LIMIT 1), 'active', now(), now()
            FROM users u
            """
        )
    )

    # Belt-and-suspenders for tier_resolution.py's now-deployment-wide
    # active-ModelProfile lookup: if an admin was identified above,
    # deactivate any is_active ModelProfile NOT owned by that admin, so
    # there's exactly one active profile deployment-wide immediately
    # after this migration rather than depending on
    # tier_resolution.py's own most-recently-updated tiebreak.
    if admin_email:
        op.execute(
            sa.text(
                """
                UPDATE model_profiles SET is_active = false
                WHERE is_active = true
                AND user_id NOT IN (SELECT id FROM users WHERE lower(email) = :email)
                """
            ).bindparams(email=admin_email)
        )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index(op.f('ix_subscriptions_user_id'), table_name='subscriptions')
    op.drop_table('subscriptions')
    op.drop_table('plans')
    op.drop_column('users', 'is_active')
    op.drop_column('users', 'role')
