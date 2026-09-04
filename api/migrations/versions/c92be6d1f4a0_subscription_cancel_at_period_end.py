"""subscription_cancel_at_period_end

Revision ID: c92be6d1f4a0
Revises: a17c5f9be3d1
Create Date: 2026-09-04 10:05:00.000000

Adrian, direct: "another feature i need to add is upgrade, downgrade,
and cancel subscription. All should only apply in the next billing
cycle (except if going from free/open to work to paid subscription,
it applies immediately)."
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'c92be6d1f4a0'
down_revision: Union[str, Sequence[str], None] = 'a17c5f9be3d1'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column(
        'subscriptions',
        sa.Column('cancel_at_period_end', sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    op.alter_column('subscriptions', 'cancel_at_period_end', server_default=None)


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column('subscriptions', 'cancel_at_period_end')
