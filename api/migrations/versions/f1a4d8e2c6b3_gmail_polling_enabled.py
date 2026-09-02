"""gmail_polling_enabled

Revision ID: f1a4d8e2c6b3
Revises: a3f7c2e9b1d4
Create Date: 2026-09-02 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'f1a4d8e2c6b3'
down_revision: Union[str, Sequence[str], None] = 'a3f7c2e9b1d4'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column('gmail_connections', sa.Column('polling_enabled', sa.Boolean(), nullable=False, server_default=sa.true()))
    op.alter_column('gmail_connections', 'polling_enabled', server_default=None)


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column('gmail_connections', 'polling_enabled')
