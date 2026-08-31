"""m5_gmail_connections

Revision ID: b7e2f0c8a316
Revises: a1c3d7e9f204
Create Date: 2026-08-28 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision: str = 'b7e2f0c8a316'
down_revision: Union[str, Sequence[str], None] = 'a1c3d7e9f204'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        'gmail_connections',
        sa.Column('google_email', sa.String(length=320), nullable=False),
        sa.Column('label_name', sa.String(length=120), nullable=False),
        sa.Column('refresh_token_encrypted', sa.LargeBinary(), nullable=False),
        sa.Column('scopes', postgresql.ARRAY(sa.String()), nullable=False),
        sa.Column('history_id', sa.String(length=60), nullable=True),
        sa.Column('watch_expiration', sa.DateTime(timezone=True), nullable=True),
        sa.Column('status', sa.String(length=20), nullable=False),
        sa.Column('last_synced_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('last_error', sa.Text(), nullable=True),
        sa.Column('id', sa.UUID(), server_default=sa.text('gen_random_uuid()'), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('user_id', sa.UUID(), nullable=False),
        sa.PrimaryKeyConstraint('id', name=op.f('pk_gmail_connections')),
        sa.UniqueConstraint('user_id', name='uq_gmail_connections_user_id'),
    )
    op.create_index(op.f('ix_gmail_connections_user_id'), 'gmail_connections', ['user_id'], unique=False)


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index(op.f('ix_gmail_connections_user_id'), table_name='gmail_connections')
    op.drop_table('gmail_connections')
