"""F6.6-adjacent — user-supplied third-party login credentials (e.g. a
LinkedIn account), used only by `browser_fill_credential`
(agents/browser_tools.py) to fill a login form without the secret ever
appearing in the agent's own context/conversation. Distinct from
`BrowserContext` (models/pipeline.py), which persists a post-login
*session* (cookies), not the credential itself — the two are
complementary: a stored credential lets the agent log in once without
asking a human to type a password into chat; a stored session lets it
skip logging in again on a later run.
"""

import uuid

from sqlalchemy import String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from applicient_api.db import Base, TimestampMixin, UUIDPKMixin, UserScopedMixin


class Credential(UUIDPKMixin, TimestampMixin, UserScopedMixin, Base):
    """`secret_encrypted` is Fernet ciphertext — `security.py`'s
    `encrypt_api_key`/`decrypt_api_key` reused as-is (the name is a
    holdover from provider API keys, the functions are generic).
    Never returned to any client after creation (only `secret_hint`,
    same masking as `ProviderConnection.api_key_hint`) and never
    handed to the LLM — only the tool itself decrypts it server-side
    to fill a page field directly."""

    __tablename__ = "credentials"
    __table_args__ = (UniqueConstraint("user_id", "label", name="uq_credentials_user_label"),)

    label: Mapped[str] = mapped_column(String(60), nullable=False)  # e.g. "linkedin" — the agent's lookup key
    identifier: Mapped[str] = mapped_column(String(250), nullable=False)  # username/email, not secret
    secret_encrypted: Mapped[bytes] = mapped_column(nullable=False)
    secret_hint: Mapped[str] = mapped_column(String(20), nullable=False)
