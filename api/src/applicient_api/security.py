"""F12.6 — provider API keys are encrypted at rest and never returned
to the client after saving; only a masked hint is kept for display.

Uses Fernet (symmetric, authenticated encryption) keyed by SECRET_KEY.
"""

import os

from cryptography.fernet import Fernet


def _fernet() -> Fernet:
    key = os.environ.get("SECRET_KEY")
    if not key:
        raise RuntimeError(
            "SECRET_KEY is not set — generate one with: "
            "python -c \"from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())\""
        )
    return Fernet(key.encode())


def encrypt_api_key(plaintext: str) -> bytes:
    return _fernet().encrypt(plaintext.encode())


def decrypt_api_key(ciphertext: bytes) -> str:
    return _fernet().decrypt(ciphertext).decode()


def make_hint(plaintext: str) -> str:
    """e.g. 'sk-or-v1......4a2f' — enough to recognize the key, never
    enough to reconstruct it."""

    if len(plaintext) <= 12:
        return "•" * len(plaintext)
    return f"{plaintext[:8]}{'•' * 6}{plaintext[-4:]}"
