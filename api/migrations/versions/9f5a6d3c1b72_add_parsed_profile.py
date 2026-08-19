"""store the structured profile returned by CV ingest

Revision ID: 9f5a6d3c1b72
Revises: 64d60facd265
Create Date: 2026-08-19 20:00:00.000000
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision: str = "9f5a6d3c1b72"
down_revision: Union[str, Sequence[str], None] = "64d60facd265"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "profiles",
        sa.Column(
            "parsed_profile",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
    )


def downgrade() -> None:
    op.drop_column("profiles", "parsed_profile")
