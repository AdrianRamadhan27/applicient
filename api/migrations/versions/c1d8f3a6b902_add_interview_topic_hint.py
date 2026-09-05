"""add interview_sessions.topic_hint

Revision ID: c1d8f3a6b902
Revises: b7c9a2e4f108
Create Date: 2026-09-05 00:00:00.000000

"""

from alembic import op
import sqlalchemy as sa

revision = "c1d8f3a6b902"
down_revision = "b7c9a2e4f108"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("interview_sessions", sa.Column("topic_hint", sa.String(length=500), nullable=True))


def downgrade() -> None:
    op.drop_column("interview_sessions", "topic_hint")
