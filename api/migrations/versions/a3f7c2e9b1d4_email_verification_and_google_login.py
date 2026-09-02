"""email_verification_and_google_login

Revision ID: a3f7c2e9b1d4
Revises: b6d4e8a1c9f7
Create Date: 2026-09-02 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'a3f7c2e9b1d4'
down_revision: Union[str, Sequence[str], None] = 'b6d4e8a1c9f7'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column('users', sa.Column('email_verified', sa.Boolean(), nullable=False, server_default=sa.false()))
    op.alter_column('users', 'email_verified', server_default=None)
    op.add_column('users', sa.Column('google_id', sa.String(length=255), nullable=True))
    op.create_unique_constraint(op.f('uq_users_google_id'), 'users', ['google_id'])


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_constraint(op.f('uq_users_google_id'), 'users', type_='unique')
    op.drop_column('users', 'google_id')
    op.drop_column('users', 'email_verified')
