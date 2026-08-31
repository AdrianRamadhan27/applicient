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

import os
import uuid
from datetime import datetime, timedelta, timezone

import bcrypt
import jwt

ACCESS_TOKEN_TTL = timedelta(days=7)
_JWT_ALGORITHM = "HS256"


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
