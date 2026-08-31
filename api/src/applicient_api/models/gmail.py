"""M5 F8.1 — one Gmail OAuth grant per user, feeding email ingestion
(email_ingestion.py) via either Pub/Sub push or polling.

`label_name` is vestigial as of the post-F8.2 keyword-scan redesign
(raised directly: manual per-email labeling was a real adoption
blocker) — ingestion no longer filters by it; see
`email_ingestion.py`'s `_KEYWORD_QUERY` for the real scope boundary
now (a keyword-OR Gmail search run server-side, not a label). Kept in
the schema rather than migrated away since it's harmless and free to
leave.
"""

from datetime import datetime

from sqlalchemy import DateTime, Integer, String, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import ARRAY

from sqlalchemy.orm import Mapped, mapped_column

from applicient_api.db import Base, TimestampMixin, UUIDPKMixin, UserScopedMixin


class GmailConnection(UUIDPKMixin, TimestampMixin, UserScopedMixin, Base):
    """One Gmail account per user for this pass (UniqueConstraint on
    user_id) — same "connection health" shape as ProviderConnection
    (status/last_verified_at-equivalent/last_error), since a Gmail
    grant needs structured fields (refresh token, scopes, watch/
    history state) a single opaque secret like Credential can't hold.
    """

    __tablename__ = "gmail_connections"
    __table_args__ = (UniqueConstraint("user_id", name="uq_gmail_connections_user_id"),)

    google_email: Mapped[str] = mapped_column(String(320), nullable=False)
    label_name: Mapped[str] = mapped_column(String(120), nullable=False, default="Applicient")
    # Real scope boundary now, alongside the keyword query — Gmail's
    # `newer_than:{days}d` search operator, not an arbitrary result-count
    # cap (raised directly: a flat maxResults cap could silently miss
    # older matches instead of bounding by something meaningful).
    scan_window_days: Mapped[int] = mapped_column(Integer, nullable=False, default=7)
    # Fernet, via security.py's encrypt_api_key/decrypt_api_key — same
    # mechanism ProviderConnection.api_key_encrypted already uses, fed
    # the raw refresh-token string.
    refresh_token_encrypted: Mapped[bytes] = mapped_column(nullable=False)
    scopes: Mapped[list[str]] = mapped_column(ARRAY(String), nullable=False, default=list)
    # Gmail's own history-delta cursor (users.history.list) — reset
    # whenever a full users.messages.list resync happens (a stale/
    # expired history_id 404s after long gaps).
    history_id: Mapped[str | None] = mapped_column(String(60))
    # Google Pub/Sub watches expire after 7 days — the scheduler's
    # watch-renewal job (Part 3) renews any row within 24h of this.
    watch_expiration: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="untested")  # ConnectionStatus
    last_synced_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_error: Mapped[str | None] = mapped_column(Text)
