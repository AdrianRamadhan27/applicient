"""split dodo_customer_id by environment

Revision ID: b8d4f21a6c93
Revises: a3c7e5f18d24
Create Date: 2026-09-03 00:00:00.000000

Same reasoning as the previous migration's Plan.dodo_product_id split:
Subscription.dodo_customer_id was one shared column for a Dodo
customer object, but a customer created in test mode doesn't exist in
live mode either — `_ensure_customer` (billing_service.py) would
otherwise cache-and-reuse a stale test-mode customer id against the
live API the moment DODO_PAYMENTS_ENVIRONMENT flips for any user who
was ever exercised in the other mode (raised directly by Adrian, the
next failure right after the product-id one). Split into
dodo_customer_id_test/dodo_customer_id_live; billing_service reads
whichever matches the server's current environment.

Existing values backfilled into dodo_customer_id_test — every
subscription so far was only ever exercised in test mode, same as the
product-id migration's own reasoning.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'b8d4f21a6c93'
down_revision: Union[str, Sequence[str], None] = 'a3c7e5f18d24'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column('subscriptions', sa.Column('dodo_customer_id_test', sa.String(length=120), nullable=True))
    op.add_column('subscriptions', sa.Column('dodo_customer_id_live', sa.String(length=120), nullable=True))
    op.execute("UPDATE subscriptions SET dodo_customer_id_test = dodo_customer_id WHERE dodo_customer_id IS NOT NULL")
    op.drop_column('subscriptions', 'dodo_customer_id')


def downgrade() -> None:
    """Downgrade schema."""
    op.add_column('subscriptions', sa.Column('dodo_customer_id', sa.String(length=120), nullable=True))
    op.execute("UPDATE subscriptions SET dodo_customer_id = dodo_customer_id_test WHERE dodo_customer_id_test IS NOT NULL")
    op.drop_column('subscriptions', 'dodo_customer_id_live')
    op.drop_column('subscriptions', 'dodo_customer_id_test')
