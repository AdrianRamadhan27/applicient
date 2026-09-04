"""job_group_target_role

Revision ID: d4e7f2a1b6c3
Revises: c92be6d1f4a0
Create Date: 2026-09-04 12:00:00.000000

Adrian, direct: "currently you can only make job group if you add a
job from job inbox into it. I want the that to be optional. So you
can just compose a cv based on like a targeted role name." Two
nullable free-text columns on job_groups — a group can be tailored
toward a real member job listing, a free-text target role/company, or
both; the generation services already fall back to whichever is
present.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'd4e7f2a1b6c3'
down_revision: Union[str, Sequence[str], None] = 'c92be6d1f4a0'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column('job_groups', sa.Column('target_role_title', sa.String(length=200), nullable=True))
    op.add_column('job_groups', sa.Column('target_company', sa.String(length=200), nullable=True))


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column('job_groups', 'target_company')
    op.drop_column('job_groups', 'target_role_title')
