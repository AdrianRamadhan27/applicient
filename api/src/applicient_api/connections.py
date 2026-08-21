"""F12.2/F12.5/F12.7 — the actual "paste a key, test, catalog
populates" flow. This is the service layer the GUI's Models &
Providers screen calls; the FastAPI routes are intentionally thin wrappers
around this independently callable service layer.
"""

from __future__ import annotations

import asyncio
import uuid
from datetime import datetime, timezone

from sqlalchemy.orm import Session

from applicient_api.models.llm import ModelCatalogEntry, ProviderConnection
from applicient_api.providers import get_adapter
from applicient_api.security import decrypt_api_key, encrypt_api_key, make_hint


def create_connection(
    session: Session,
    *,
    user_id: uuid.UUID,
    provider: str,
    api_key: str,
    base_url: str | None = None,
    label: str | None = None,
) -> ProviderConnection:
    conn = ProviderConnection(
        user_id=user_id,
        provider=provider,
        label=label,
        api_key_encrypted=encrypt_api_key(api_key),
        api_key_hint=make_hint(api_key),
        base_url=base_url,
        status="untested",
    )
    session.add(conn)
    session.flush()
    return conn


def delete_connection(session: Session, conn: ProviderConnection) -> None:
    """Delete a provider connection and its catalog rows.

    ``ModelCatalogEntry.provider_connection_id`` has an ``ON DELETE
    CASCADE`` foreign key, so the database removes the cached catalog in
    the same transaction as the connection. Callers must validate that no
    model profile or embedding index still references those rows first.
    """

    session.delete(conn)
    session.flush()


def test_connection(session: Session, conn: ProviderConnection) -> ProviderConnection:
    """F12.5 — a real minimal call, not a format check. Untested or
    failing connections cannot be bound to a tier (enforced at the
    tier-binding layer once it exists, not here)."""

    adapter = get_adapter(conn.provider)
    api_key = decrypt_api_key(conn.api_key_encrypted)
    result = asyncio.run(adapter.test_connection(api_key, conn.base_url))

    conn.status = result.status
    conn.last_verified_at = datetime.now(timezone.utc)
    conn.last_error = result.error
    session.flush()
    return conn


def refresh_catalog(session: Session, conn: ProviderConnection) -> list[ModelCatalogEntry]:
    """F12.7 — discovered live, cached with a TTL via fetched_at.
    Upserts by (provider_connection_id, model_id) so a refresh updates
    prices/capabilities in place rather than duplicating rows."""

    adapter = get_adapter(conn.provider)
    api_key = decrypt_api_key(conn.api_key_encrypted)
    entries = asyncio.run(adapter.list_models(api_key, conn.base_url))

    existing = {
        row.model_id: row
        for row in session.query(ModelCatalogEntry).filter_by(provider_connection_id=conn.id)
    }
    now = datetime.now(timezone.utc)
    result: list[ModelCatalogEntry] = []
    for entry in entries:
        row = existing.get(entry.model_id)
        if row is None:
            row = ModelCatalogEntry(provider_connection_id=conn.id, model_id=entry.model_id)
            session.add(row)
        row.display_name = entry.display_name
        row.context_window = entry.context_window
        row.max_output = entry.max_output
        row.capabilities = entry.capabilities
        row.input_price_per_mtok = entry.input_price_per_mtok
        row.output_price_per_mtok = entry.output_price_per_mtok
        row.cache_read_price_per_mtok = entry.cache_read_price_per_mtok
        row.cache_write_price_per_mtok = entry.cache_write_price_per_mtok
        row.pricing_version = entry.pricing_version
        row.pricing_known = entry.pricing_known
        row.fetched_at = now
        result.append(row)

    session.flush()
    return result
