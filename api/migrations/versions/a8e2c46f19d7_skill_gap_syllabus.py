"""skill_gap_syllabus

Revision ID: a8e2c46f19d7
Revises: d1f4a7c92e63
Create Date: 2026-09-02 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision: str = 'a8e2c46f19d7'
down_revision: Union[str, Sequence[str], None] = 'd1f4a7c92e63'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column('skill_gap_items', sa.Column('syllabus', postgresql.JSONB(astext_type=sa.Text()), nullable=True))


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column('skill_gap_items', 'syllabus')
