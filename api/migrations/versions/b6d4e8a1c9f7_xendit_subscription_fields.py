"""xendit_subscription_fields

Revision ID: b6d4e8a1c9f7
Revises: f3a8c1d9e6b2
Create Date: 2026-08-31 00:00:00.000002

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'b6d4e8a1c9f7'
down_revision: Union[str, Sequence[str], None] = 'f3a8c1d9e6b2'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column('subscriptions', sa.Column('xendit_payment_session_id', sa.String(length=120), nullable=True))
    op.add_column('subscriptions', sa.Column('xendit_payment_token_id', sa.String(length=120), nullable=True))
    op.add_column('subscriptions', sa.Column('xendit_recurring_plan_id', sa.String(length=120), nullable=True))
    op.add_column('subscriptions', sa.Column('pending_plan_id', sa.UUID(), nullable=True))
    op.create_foreign_key(
        op.f('fk_subscriptions_pending_plan_id_plans'), 'subscriptions', 'plans', ['pending_plan_id'], ['id'], ondelete='SET NULL'
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_constraint(op.f('fk_subscriptions_pending_plan_id_plans'), 'subscriptions', type_='foreignkey')
    op.drop_column('subscriptions', 'pending_plan_id')
    op.drop_column('subscriptions', 'xendit_recurring_plan_id')
    op.drop_column('subscriptions', 'xendit_payment_token_id')
    op.drop_column('subscriptions', 'xendit_payment_session_id')
