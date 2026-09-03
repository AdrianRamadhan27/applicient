"""split dodo_product_id by environment

Revision ID: a3c7e5f18d24
Revises: f6b3a1d9c852
Create Date: 2026-09-15 00:00:00.000000

Plan.dodo_product_id was one shared column for both Dodo test-mode and
live-mode products — but Dodo's test/live catalogs are fully separate
(a product created via the API in one mode simply doesn't exist in the
other), so switching DODO_PAYMENTS_ENVIRONMENT meant blindly reusing
whichever product id happened to be cached, against the wrong mode's
API. This is exactly what broke checkout after Adrian moved the real
products to live mode (raised directly by him). Split into
dodo_product_id_test/dodo_product_id_live — billing_service now reads
whichever matches the server's current environment, and the admin
Plans page can edit either directly instead of only ever getting one
auto-created on first checkout.

Existing values are backfilled into dodo_product_id_test: every plan
so far was only ever exercised in test mode (Adrian's own account of
"the previous setup worked on test mode"), so that's a correct
migration, not a guess — nothing has a live-mode id yet regardless.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'a3c7e5f18d24'
down_revision: Union[str, Sequence[str], None] = 'f6b3a1d9c852'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column('plans', sa.Column('dodo_product_id_test', sa.String(length=120), nullable=True))
    op.add_column('plans', sa.Column('dodo_product_id_live', sa.String(length=120), nullable=True))
    op.execute("UPDATE plans SET dodo_product_id_test = dodo_product_id WHERE dodo_product_id IS NOT NULL")
    op.drop_column('plans', 'dodo_product_id')


def downgrade() -> None:
    """Downgrade schema."""
    op.add_column('plans', sa.Column('dodo_product_id', sa.String(length=120), nullable=True))
    op.execute("UPDATE plans SET dodo_product_id = dodo_product_id_test WHERE dodo_product_id_test IS NOT NULL")
    op.drop_column('plans', 'dodo_product_id_live')
    op.drop_column('plans', 'dodo_product_id_test')
