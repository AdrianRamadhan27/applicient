"""Landing-page CMS (Adrian, direct: "a whole CMS where i can control
what shows up in the landing page... changing like images and whatnot
shouldnt be through commits") — scoped to media only per that same
conversation: the demo video link and the screenshot images, not the
page's copy (headlines/feature text/FAQ stay in code, still the
fastest way to edit prose).

Two tables, not one, since the two things being edited are shaped
differently: `demo_video_url` is a single site-wide string (a
singleton row — always the first/only one, created on first read if
missing), while screenshots are N independent named slots, each either
overridden (a real uploaded file, stored the same way cv.py/interview_
media.py already store user files — object_storage.py, not a DB
blob) or left alone (None `object_key` = "use the bundled default
asset already checked into web/public/screenshots/", so a fresh
deployment with nothing uploaded yet looks identical to today, not
broken)."""

from __future__ import annotations

from sqlalchemy import String
from sqlalchemy.orm import Mapped, mapped_column

from applicient_api.db import Base, TimestampMixin, UUIDPKMixin


class SiteSettings(UUIDPKMixin, TimestampMixin, Base):
    __tablename__ = "site_settings"

    demo_video_url: Mapped[str | None] = mapped_column(String(500))


class SiteMediaAsset(UUIDPKMixin, TimestampMixin, Base):
    __tablename__ = "site_media_assets"

    # A fixed, code-defined vocabulary (SITE_MEDIA_SLOTS in
    # routers/site_content.py) — "hero", "job-search", etc. — not
    # freeform, so the landing page always knows exactly which slots
    # to ask for.
    slot: Mapped[str] = mapped_column(String(60), unique=True, nullable=False)
    object_key: Mapped[str | None] = mapped_column(String(512))
    content_type: Mapped[str | None] = mapped_column(String(100))
