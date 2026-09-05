"""add interview_sessions.language

Revision ID: d3e9a1c7f215
Revises: c1d8f3a6b902
Create Date: 2026-09-05 00:00:00.000000

"""

from alembic import op
import sqlalchemy as sa

revision = "d3e9a1c7f215"
down_revision = "c1d8f3a6b902"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("interview_sessions", sa.Column("language", sa.String(length=30), nullable=True))


def downgrade() -> None:
    op.drop_column("interview_sessions", "language")
