"""pipeline_stages_table

Revision ID: d8e3b5c1f0a9
Revises: c4f1a9d02b7e
Create Date: 2026-08-31 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'd8e3b5c1f0a9'
down_revision: Union[str, Sequence[str], None] = 'c4f1a9d02b7e'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

# Frozen, literal copy of the fixed 13-state list this table replaces —
# deliberately not imported from pipeline_stage_service.py. Every other
# migration in this history is self-contained raw DDL/SQL; a historical
# migration shouldn't depend on app code that could change later.
_DEFAULT_STAGES = [
    ('discovered', 'Discovered', 0),
    ('shortlisted', 'Shortlisted', 1),
    ('preparing', 'Preparing', 2),
    ('ready', 'Ready', 3),
    ('applied', 'Applied', 4),
    ('acknowledged', 'Acknowledged', 5),
    ('screening', 'Screening', 6),
    ('assessment', 'Assessment', 7),
    ('interview', 'Interview', 8),
    ('offer', 'Offer', 9),
    ('rejected', 'Rejected', 10),
    ('withdrawn', 'Withdrawn', 11),
    ('ghosted', 'Ghosted', 12),
]


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        'pipeline_stages',
        sa.Column('key', sa.String(length=20), nullable=False),
        sa.Column('display_name', sa.String(length=60), nullable=False),
        sa.Column('position', sa.Integer(), nullable=False),
        sa.Column('id', sa.UUID(), server_default=sa.text('gen_random_uuid()'), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('user_id', sa.UUID(), nullable=False),
        sa.PrimaryKeyConstraint('id', name=op.f('pk_pipeline_stages')),
        sa.UniqueConstraint('user_id', 'key', name='uq_pipeline_stages_user_key'),
    )
    op.create_index(op.f('ix_pipeline_stages_user_id'), 'pipeline_stages', ['user_id'], unique=False)

    # Backfill: every existing user gets the current fixed 13 states as
    # their starting list, so nothing changes for anyone until they
    # actually customize.
    values_sql = ", ".join(
        f"('{key}', '{name}', {pos})" for key, name, pos in _DEFAULT_STAGES
    )
    op.execute(
        sa.text(
            f"""
            INSERT INTO pipeline_stages (id, user_id, key, display_name, position, created_at, updated_at)
            SELECT gen_random_uuid(), u.id, v.key, v.display_name, v.position, now(), now()
            FROM users u
            CROSS JOIN (VALUES {values_sql}) AS v(key, display_name, position)
            """
        )
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index(op.f('ix_pipeline_stages_user_id'), table_name='pipeline_stages')
    op.drop_table('pipeline_stages')
