"""cv_score_and_cv_fix

Revision ID: a17c5f9be3d1
Revises: f3a91c7de220
Create Date: 2026-09-04 09:20:00.000000

Adrian, direct: "after user upload cv there needs to be cv scoring...
Also in this base cv page there should be feature to fix the cv."
CV scoring stays free (no feature_credit_costs row, same as CV
parsing); "fix my CV" gets a real priced row — first use still free
via credit_ledger.py's existing first-use-free rule.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision: str = 'a17c5f9be3d1'
down_revision: Union[str, Sequence[str], None] = 'f3a91c7de220'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column('profiles', sa.Column('cv_score', postgresql.JSONB(astext_type=sa.Text()), nullable=True))
    op.add_column('profiles', sa.Column('cv_scored_at', sa.DateTime(timezone=True), nullable=True))
    op.execute(
        """
        INSERT INTO feature_credit_costs (id, key, display_name, credit_cost, is_active, created_at, updated_at)
        VALUES (gen_random_uuid(), 'cv-fix', 'Fix my CV (general wording improvement)', 15, true, now(), now())
        -- cv-score deliberately has no row here — free, on the house, same as CV parsing.
        """
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.execute("DELETE FROM feature_credit_costs WHERE key = 'cv-fix'")
    op.drop_column('profiles', 'cv_scored_at')
    op.drop_column('profiles', 'cv_score')
