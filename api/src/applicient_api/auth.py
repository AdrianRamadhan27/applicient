"""M5 — password hashing and JWT bearer tokens for real signup/login.

Bearer token, not an httpOnly cookie: `main.py`'s CORS config has no
`allow_credentials=True`, and adding it would mean touching every raw
`fetch()` in `web/src/lib/api.ts` individually to add
`credentials: "include"`. A bearer token only needs the header attached
at each call site, same as any other request header.

JWT is signed with the same SECRET_KEY env var security.py's Fernet
encryption already requires — a different use of the same secret
(HS256 signing vs. Fernet encryption), not an accidental key reuse.
"""

import hashlib
import hmac
import os
import uuid
from datetime import datetime, timedelta, timezone

import bcrypt
import jwt

ACCESS_TOKEN_TTL = timedelta(days=7)
# Shorter than email verification's 24h — a password-reset link is
# more sensitive (it directly changes account access), and 1h is
# plenty of time to click a just-received email.
RESET_TOKEN_TTL = timedelta(hours=1)
_JWT_ALGORITHM = "HS256"
_RESET_TOKEN_PURPOSE = "password_reset"


class AuthError(Exception):
    """Raised for any invalid/expired/malformed token or credential."""


def _secret_key() -> str:
    key = os.environ.get("SECRET_KEY")
    if not key:
        raise RuntimeError(
            "SECRET_KEY is not set — generate one with: "
            "python -c \"from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())\""
        )
    return key


def hash_password(plaintext: str) -> str:
    return bcrypt.hashpw(plaintext.encode(), bcrypt.gensalt()).decode()


def verify_password(plaintext: str, hashed: str) -> bool:
    return bcrypt.checkpw(plaintext.encode(), hashed.encode())


def create_access_token(user_id: uuid.UUID, *, expires_delta: timedelta = ACCESS_TOKEN_TTL) -> str:
    now = datetime.now(timezone.utc)
    payload = {"sub": str(user_id), "iat": now, "exp": now + expires_delta}
    return jwt.encode(payload, _secret_key(), algorithm=_JWT_ALGORITHM)


def decode_access_token(token: str) -> uuid.UUID:
    try:
        payload = jwt.decode(token, _secret_key(), algorithms=[_JWT_ALGORITHM])
        return uuid.UUID(payload["sub"])
    except (jwt.PyJWTError, KeyError, ValueError) as exc:
        raise AuthError("invalid or expired token") from exc


def password_fingerprint(password_hash: str) -> str:
    """A one-way, keyed fingerprint of the CURRENT password hash —
    embedded in a password-reset token so that once the password
    actually changes, every outstanding reset link (including ones
    never clicked) stops working automatically, with no separate
    revocation table needed. HMAC'd with the app's own SECRET_KEY so it
    can't be forged or reversed to learn the real bcrypt hash, even
    though the token itself — like any JWT — is only signed, not
    encrypted, and travels in a plain URL/email."""
    return hmac.new(_secret_key().encode(), password_hash.encode(), hashlib.sha256).hexdigest()[:32]


def create_password_reset_token(user_id: uuid.UUID, *, password_hash: str) -> str:
    now = datetime.now(timezone.utc)
    payload = {
        "sub": str(user_id),
        "purpose": _RESET_TOKEN_PURPOSE,
        "pwf": password_fingerprint(password_hash),
        "iat": now,
        "exp": now + RESET_TOKEN_TTL,
    }
    return jwt.encode(payload, _secret_key(), algorithm=_JWT_ALGORITHM)


def decode_password_reset_token(token: str) -> tuple[uuid.UUID, str]:
    """Verifies signature/expiry/purpose only, and returns (user_id,
    the fingerprint recorded IN the token) — deliberately NOT comparing
    that fingerprint here. The caller has to look up the real user row
    from the returned user_id first (there's no way to know whose
    CURRENT password_hash to fingerprint-check against before that),
    then compare `password_fingerprint(user.password_hash)` against the
    second value this returns."""
    try:
        payload = jwt.decode(token, _secret_key(), algorithms=[_JWT_ALGORITHM])
    except jwt.PyJWTError as exc:
        raise AuthError("invalid or expired link") from exc
    if payload.get("purpose") != _RESET_TOKEN_PURPOSE:
        raise AuthError("invalid link")
    try:
        return uuid.UUID(payload["sub"]), str(payload["pwf"])
    except (KeyError, ValueError) as exc:
        raise AuthError("invalid link") from exc
