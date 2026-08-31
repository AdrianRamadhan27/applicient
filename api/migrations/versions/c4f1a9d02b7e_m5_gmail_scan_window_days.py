"""m5_gmail_scan_window_days

Revision ID: c4f1a9d02b7e
Revises: b7e2f0c8a316
Create Date: 2026-08-31 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'c4f1a9d02b7e'
down_revision: Union[str, Sequence[str], None] = 'b7e2f0c8a316'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column(
        'gmail_connections',
        sa.Column('scan_window_days', sa.Integer(), nullable=False, server_default='7'),
    )
    op.alter_column('gmail_connections', 'scan_window_days', server_default=None)


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column('gmail_connections', 'scan_window_days')
