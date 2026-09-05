"""backfill_email_verified

Revision ID: b7c9a2e4f108
Revises: d4e7f2a1b6c3
Create Date: 2026-09-05 09:00:00.000000

Adrian, direct: "make existing registered accounts state to be
verified automatically because i dont want to have to verify for
demo@applicient.local". A one-time data backfill, not a schema
change — every account that existed BEFORE login() started gating on
email_verified (this same deploy) is grandfathered in as verified,
since none of them ever went through a flow that required it in the
first place. Anyone signing up AFTER this migration runs still gets a
real unverified row (default False) and has to click the real link —
this only ever touches rows that already existed at migration time.
"""
from typing import Sequence, Union

from alembic import op


# revision identifiers, used by Alembic.
revision: str = 'b7c9a2e4f108'
down_revision: Union[str, Sequence[str], None] = 'd4e7f2a1b6c3'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.execute("UPDATE users SET email_verified = true WHERE email_verified = false")


def downgrade() -> None:
    """Downgrade schema."""
    # Deliberately a no-op — there's no way to know which rows were
    # false-before-this-migration versus genuinely verified afterward
    # through the real flow, so reversing this blindly would lock
    # people back out who verified for real in between. A one-way
    # grandfather clause, not a reversible schema change.
    pass
