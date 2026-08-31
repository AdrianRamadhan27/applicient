"""m7_orchestrator_conversations

Revision ID: 87b74c8441eb
Revises: 2754bc80895f
Create Date: 2026-08-26 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = '87b74c8441eb'
down_revision: Union[str, Sequence[str], None] = '2754bc80895f'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table('orchestrator_conversations',
    sa.Column('persona_id', sa.UUID(), nullable=False),
    sa.Column('thread_id', sa.String(length=64), nullable=False),
    sa.Column('status', sa.String(length=20), nullable=False),
    sa.Column('title', sa.String(length=200), nullable=True),
    sa.Column('pending_interrupt', postgresql.JSONB(astext_type=sa.Text()), nullable=True),
    sa.Column('last_active_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('id', sa.UUID(), server_default=sa.text('gen_random_uuid()'), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('user_id', sa.UUID(), nullable=False),
    sa.ForeignKeyConstraint(['persona_id'], ['personas.id'], name=op.f('fk_orchestrator_conversations_persona_id_personas'), ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_orchestrator_conversations')),
    sa.UniqueConstraint('thread_id', name=op.f('uq_orchestrator_conversations_thread_id'))
    )
    op.create_index(op.f('ix_orchestrator_conversations_user_id'), 'orchestrator_conversations', ['user_id'], unique=False)
    op.add_column('agent_runs', sa.Column('conversation_id', sa.UUID(), nullable=True))
    op.create_foreign_key(
        op.f('fk_agent_runs_conversation_id_orchestrator_conversations'),
        'agent_runs', 'orchestrator_conversations',
        ['conversation_id'], ['id'], ondelete='SET NULL',
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_constraint(op.f('fk_agent_runs_conversation_id_orchestrator_conversations'), 'agent_runs', type_='foreignkey')
    op.drop_column('agent_runs', 'conversation_id')
    op.drop_index(op.f('ix_orchestrator_conversations_user_id'), table_name='orchestrator_conversations')
    op.drop_table('orchestrator_conversations')
