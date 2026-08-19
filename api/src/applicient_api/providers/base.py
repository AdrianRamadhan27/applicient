"""F12.1/F12.7 — the provider adapter interface.

No agent, subagent or tool ever names a model (PRD §7.5). This
interface is where that indirection actually lives: every provider
implements the same two operations, and everything upstream (tier
resolution, the GUI, the callback handler) only ever talks to this
interface, never to a provider SDK directly.
"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class ConnectionTestResult:
    ok: bool
    status: str  # ConnectionStatus value: "ok" / "auth_failed" / "unreachable"
    error: str | None = None


@dataclass
class CatalogEntryData:
    """One row as it will land in ModelCatalogEntry — provider-neutral,
    so the DB layer never has to know which adapter produced it."""

    model_id: str
    display_name: str | None = None
    context_window: int | None = None
    max_output: int | None = None
    capabilities: list[str] = field(default_factory=list)
    input_price_per_mtok: float | None = None
    output_price_per_mtok: float | None = None
    cache_read_price_per_mtok: float | None = None
    cache_write_price_per_mtok: float | None = None
    pricing_version: str | None = None
    pricing_known: bool = False


class ProviderAdapter:
    """F12.3 — one adapter per provider. Adding a provider LangChain
    already supports (or anything OpenAI-compatible via base_url) is
    implementing this interface and nothing else."""

    provider_key: str

    async def test_connection(self, api_key: str, base_url: str | None) -> ConnectionTestResult:
        raise NotImplementedError

    async def list_models(self, api_key: str, base_url: str | None) -> list[CatalogEntryData]:
        """F12.7 — discovered live from the provider, not hardcoded."""
        raise NotImplementedError
