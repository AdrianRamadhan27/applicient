"""fix_dead_ats_plain_template_default

Revision ID: f6b3a1d9c852
Revises: a8e2c46f19d7
Create Date: 2026-09-02 00:00:00.000000

Data-only backfill — no schema change. "ats-plain" was the Python-level
default for Persona.base_cv_template/Document.template, but was never
actually implemented in latex_rendering.TEMPLATES (only
"jakes-resume-adrian" ever existed there), so any row still carrying
it is unrenderable until a user explicitly picks a real template.
Fixed at the model level (see models/profile.py and models/documents.py);
this just corrects rows already written with the dead value.
"""
from typing import Sequence, Union

from alembic import op


# revision identifiers, used by Alembic.
revision: str = 'f6b3a1d9c852'
down_revision: Union[str, Sequence[str], None] = 'a8e2c46f19d7'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.execute("UPDATE personas SET base_cv_template = 'jakes-resume-adrian' WHERE base_cv_template = 'ats-plain'")
    op.execute("UPDATE documents SET template = 'jakes-resume-adrian' WHERE template = 'ats-plain'")


def downgrade() -> None:
    """Downgrade schema."""
    # Deliberately a no-op — reverting to a known-dead template id
    # would just reintroduce the bug, not meaningfully "undo" anything.
    pass
