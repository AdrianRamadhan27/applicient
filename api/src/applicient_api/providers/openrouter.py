"""OpenRouter adapter.

Ships as the default provider (PRD §3.1/§17: `openrouter-budget` preset
for chat, `nvidia/nemotron-3-embed-1b:free` for embeddings — one key
runs the whole product).

Every shape below was checked against the live API rather than
assumed:
  - GET /api/v1/key validates the key (Bearer auth) and is the only
    endpoint that actually does — /api/v1/models is public and
    returns 200 regardless of the key.
  - GET /api/v1/models lists chat/completion models. Embedding models
    do NOT appear here — they're a separate catalog entirely.
  - GET /api/v1/embeddings/models lists embedding models. Neither
    listing returns a vector dimension; that's not provider-
    discoverable and has to be known out of band per model (see
    EMBED_DIM in models/profile.py).
  - pricing.prompt / pricing.completion are USD-per-token strings
    (e.g. "0.0000014"), including "0" for free models — but a
    handful of OpenRouter's own meta-router models (openrouter/auto
    and friends) report "-1" as a sentinel for "depends on the
    underlying model," not a real price. Those get pricing_known=False
    rather than a nonsense negative cost.
  - Cache pricing keys are input_cache_read / input_cache_write, only
    present on models that support prompt caching.
"""

from __future__ import annotations

import httpx

from applicient_api.providers.base import CatalogEntryData, ConnectionTestResult, ProviderAdapter

BASE_URL = "https://openrouter.ai/api/v1"
PRICING_VERSION = "openrouter-live"  # live per-call pricing, not a dated snapshot


def _price_per_mtok(pricing: dict, key: str) -> float | None:
    raw = pricing.get(key)
    if raw is None:
        return None
    value = float(raw)
    if value < 0:
        # OpenRouter's meta-router models (openrouter/auto, .../fusion,
        # .../pareto-code, .../bodybuilder, .../auto-beta — confirmed
        # against the live catalog, not a one-off) report "-1" as a
        # sentinel for "price depends on which underlying model gets
        # picked," not a literal per-token price. Treating it as
        # unknown rather than storing a nonsense negative value is
        # what F13.6 asks for either way.
        return None
    return value * 1_000_000


def _has_known_pricing(pricing: dict) -> bool:
    prompt = pricing.get("prompt")
    completion = pricing.get("completion")
    if prompt is None or completion is None:
        return False
    return float(prompt) >= 0 and float(completion) >= 0


def _capabilities_from_chat_entry(entry: dict) -> list[str]:
    caps = []
    params = entry.get("supported_parameters") or []
    if "tools" in params:
        caps.append("tools")
    if "response_format" in params:
        caps.append("structured_output")
    if "image" in (entry.get("architecture", {}).get("input_modalities") or []):
        caps.append("vision")
    pricing = entry.get("pricing", {})
    if "input_cache_read" in pricing or "input_cache_write" in pricing:
        caps.append("prompt_caching")
    return caps


def _chat_entry_to_catalog(entry: dict) -> CatalogEntryData:
    pricing = entry.get("pricing", {})
    top_provider = entry.get("top_provider", {})
    return CatalogEntryData(
        model_id=entry["id"],
        display_name=entry.get("name"),
        context_window=entry.get("context_length"),
        max_output=top_provider.get("max_completion_tokens"),
        capabilities=_capabilities_from_chat_entry(entry),
        input_price_per_mtok=_price_per_mtok(pricing, "prompt"),
        output_price_per_mtok=_price_per_mtok(pricing, "completion"),
        cache_read_price_per_mtok=_price_per_mtok(pricing, "input_cache_read"),
        cache_write_price_per_mtok=_price_per_mtok(pricing, "input_cache_write"),
        pricing_version=PRICING_VERSION,
        pricing_known=_has_known_pricing(pricing),
    )


def _embedding_entry_to_catalog(entry: dict) -> CatalogEntryData:
    pricing = entry.get("pricing", {})
    caps = ["embedding"]
    if "image" in (entry.get("architecture", {}).get("input_modalities") or []):
        caps.append("multimodal_embedding")
    return CatalogEntryData(
        model_id=entry["id"],
        display_name=entry.get("name"),
        context_window=entry.get("context_length"),
        capabilities=caps,
        input_price_per_mtok=_price_per_mtok(pricing, "prompt"),
        output_price_per_mtok=_price_per_mtok(pricing, "completion"),
        pricing_version=PRICING_VERSION,
        pricing_known=_has_known_pricing(pricing),
    )


class OpenRouterAdapter(ProviderAdapter):
    provider_key = "openrouter"

    async def test_connection(self, api_key: str, base_url: str | None) -> ConnectionTestResult:
        url = f"{(base_url or BASE_URL).rstrip('/')}/key"
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                resp = await client.get(url, headers={"Authorization": f"Bearer {api_key}"})
        except httpx.RequestError as e:
            return ConnectionTestResult(ok=False, status="unreachable", error=str(e))

        if resp.status_code == 401:
            return ConnectionTestResult(ok=False, status="auth_failed", error="Invalid API key")
        if resp.status_code >= 400:
            return ConnectionTestResult(ok=False, status="unreachable", error=f"HTTP {resp.status_code}: {resp.text[:200]}")
        return ConnectionTestResult(ok=True, status="ok")

    async def list_models(self, api_key: str, base_url: str | None) -> list[CatalogEntryData]:
        root = (base_url or BASE_URL).rstrip("/")
        headers = {"Authorization": f"Bearer {api_key}"}
        async with httpx.AsyncClient(timeout=20) as client:
            chat_resp = await client.get(f"{root}/models", headers=headers)
            chat_resp.raise_for_status()
            embed_resp = await client.get(f"{root}/embeddings/models", headers=headers)
            embed_resp.raise_for_status()

        chat_entries = [_chat_entry_to_catalog(e) for e in chat_resp.json()["data"]]
        embed_entries = [_embedding_entry_to_catalog(e) for e in embed_resp.json()["data"]]
        return chat_entries + embed_entries
