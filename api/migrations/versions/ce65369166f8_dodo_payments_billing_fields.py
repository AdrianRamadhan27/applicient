"""dodo_payments_billing_fields

Revision ID: ce65369166f8
Revises: 387e87f4f4cf
Create Date: 2026-09-02 00:00:00.000001

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'ce65369166f8'
down_revision: Union[str, Sequence[str], None] = '387e87f4f4cf'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

# Payment gateway migration, Xendit -> Dodo Payments (merchant-of-record,
# approvable without a US entity, individual-friendly). Xendit was never
# live-tested with a real transaction, so this is a straight column swap
# rather than a data migration — nothing to backfill.


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column('plans', sa.Column('dodo_product_id', sa.String(length=120), nullable=True))

    op.add_column('subscriptions', sa.Column('dodo_customer_id', sa.String(length=120), nullable=True))
    op.add_column('subscriptions', sa.Column('dodo_checkout_session_id', sa.String(length=120), nullable=True))
    op.add_column('subscriptions', sa.Column('dodo_subscription_id', sa.String(length=120), nullable=True))
    op.drop_column('subscriptions', 'xendit_customer_id')
    op.drop_column('subscriptions', 'xendit_payment_session_id')
    op.drop_column('subscriptions', 'xendit_payment_token_id')
    op.drop_column('subscriptions', 'xendit_recurring_plan_id')


def downgrade() -> None:
    """Downgrade schema."""
    op.add_column('subscriptions', sa.Column('xendit_recurring_plan_id', sa.String(length=120), nullable=True))
    op.add_column('subscriptions', sa.Column('xendit_payment_token_id', sa.String(length=120), nullable=True))
    op.add_column('subscriptions', sa.Column('xendit_payment_session_id', sa.String(length=120), nullable=True))
    op.add_column('subscriptions', sa.Column('xendit_customer_id', sa.String(length=120), nullable=True))
    op.drop_column('subscriptions', 'dodo_subscription_id')
    op.drop_column('subscriptions', 'dodo_checkout_session_id')
    op.drop_column('subscriptions', 'dodo_customer_id')

    op.drop_column('plans', 'dodo_product_id')
