"""M1 §3 — Source config persistence.

Source.config is a free-form JSONB bag (board_token, api_key,
num_pages, ...) rather than dedicated columns, since every adapter
wants a different shape. "api_key" specifically is a real secret
(JSearch's RapidAPI key) that must never sit in plaintext at rest or
be echoed back to a client, even though it lives inside a JSONB
column instead of ProviderConnection's dedicated
api_key_encrypted/api_key_hint columns — same F12.6 discipline,
applied at the key level within the dict instead of the column level.
"""

from __future__ import annotations

import asyncio

from applicient_api.models.discovery import Source
from applicient_api.security import decrypt_api_key, encrypt_api_key, make_hint
from applicient_sources import ConnectionTestResult, get_adapter

_SECRET_KEYS = ("api_key",)


def encrypted_config(config: dict) -> dict:
    """What actually gets persisted: secret keys replaced by their
    ciphertext + a display hint, never the plaintext."""

    stored = dict(config)
    for key in _SECRET_KEYS:
        value = stored.pop(key, None)
        if value:
            stored[f"{key}_encrypted"] = encrypt_api_key(value).decode()
            stored[f"{key}_hint"] = make_hint(value)
        else:
            stored.pop(f"{key}_encrypted", None)
            stored.pop(f"{key}_hint", None)
    return stored


def resolved_config(config: dict) -> dict:
    """Decrypted config ready to hand to a SourceAdapter. Built fresh
    right before a live call, never persisted or returned to a client."""

    resolved = dict(config)
    for key in _SECRET_KEYS:
        enc_key = f"{key}_encrypted"
        ciphertext = resolved.pop(enc_key, None)
        resolved.pop(f"{key}_hint", None)
        if ciphertext:
            resolved[key] = decrypt_api_key(ciphertext.encode())
    return resolved


def sanitized_config(config: dict) -> dict:
    """What's safe to send back to a client — hints only, never
    ciphertext. Defense in depth: ciphertext isn't plaintext, but a
    browser has no legitimate use for it either."""

    sanitized = dict(config)
    for key in _SECRET_KEYS:
        sanitized.pop(f"{key}_encrypted", None)
    return sanitized


def test_source(source: Source) -> ConnectionTestResult:
    adapter = get_adapter(source.adapter_key)
    return asyncio.run(adapter.test_connection(resolved_config(source.config)))
