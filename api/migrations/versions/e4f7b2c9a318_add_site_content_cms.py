"""add site_settings and site_media_assets (landing page CMS)

Revision ID: e4f7b2c9a318
Revises: d3e9a1c7f215
Create Date: 2026-09-06 00:00:00.000000

"""

from alembic import op
import sqlalchemy as sa

revision = "e4f7b2c9a318"
down_revision = "d3e9a1c7f215"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "site_settings",
        sa.Column("demo_video_url", sa.String(length=500), nullable=True),
        sa.Column("id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_site_settings")),
    )
    op.create_table(
        "site_media_assets",
        sa.Column("slot", sa.String(length=60), nullable=False),
        sa.Column("object_key", sa.String(length=512), nullable=True),
        sa.Column("content_type", sa.String(length=100), nullable=True),
        sa.Column("id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_site_media_assets")),
        sa.UniqueConstraint("slot", name=op.f("uq_site_media_assets_slot")),
    )


def downgrade() -> None:
    op.drop_table("site_media_assets")
    op.drop_table("site_settings")
