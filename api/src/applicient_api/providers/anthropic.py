"""Anthropic adapter — the quality-reference preset (PRD §11.1/§17),
not the shipped default.

GET /v1/models validates the key (x-api-key header; a missing/invalid
key returns {"type":"error","error":{"type":"authentication_error",...}}
— checked against the live endpoint before writing this) and lists
available models, but does NOT return pricing. Anthropic pricing is a
bundled table here (F12.8: "otherwise use a bundled, user-editable
table") — cached from the same source Claude Code's own claude-api
skill uses, stamped with its cache date as pricing_version. A model id
not in the table still gets listed, just with pricing_known=False,
never a silently wrong price.
"""

from __future__ import annotations

import httpx

from applicient_api.providers.base import CatalogEntryData, ConnectionTestResult, ProviderAdapter

BASE_URL = "https://api.anthropic.com/v1"
ANTHROPIC_VERSION = "2023-06-01"
PRICING_VERSION = "anthropic-cached-2026-06-24"

# $ per million tokens. Every current-generation Claude model supports
# tools, vision, structured output and prompt caching — there is no
# per-model capability flag on this API to check against, unlike
# OpenRouter's supported_parameters.
_PRICING: dict[str, tuple[float, float, float, float]] = {
    # model_id: (input, output, cache_read, cache_write) per Mtok
    "claude-opus-5": (5.00, 25.00, 0.50, 6.25),
    "claude-sonnet-5": (3.00, 15.00, 0.30, 3.75),
    "claude-haiku-4-5": (1.00, 5.00, 0.10, 1.25),
    "claude-opus-4-8": (5.00, 25.00, 0.50, 6.25),
    "claude-opus-4-7": (5.00, 25.00, 0.50, 6.25),
    "claude-opus-4-6": (5.00, 25.00, 0.50, 6.25),
    "claude-sonnet-4-6": (3.00, 15.00, 0.30, 3.75),
}
_ALL_CURRENT_CAPABILITIES = ["tools", "vision", "structured_output", "prompt_caching", "long_context"]


def _entry_to_catalog(entry: dict) -> CatalogEntryData:
    model_id = entry["id"]
    pricing = _PRICING.get(model_id)
    return CatalogEntryData(
        model_id=model_id,
        display_name=entry.get("display_name"),
        context_window=entry.get("max_input_tokens"),
        max_output=entry.get("max_tokens"),
        capabilities=_ALL_CURRENT_CAPABILITIES,
        input_price_per_mtok=pricing[0] if pricing else None,
        output_price_per_mtok=pricing[1] if pricing else None,
        cache_read_price_per_mtok=pricing[2] if pricing else None,
        cache_write_price_per_mtok=pricing[3] if pricing else None,
        pricing_version=PRICING_VERSION if pricing else None,
        pricing_known=pricing is not None,
    )


class AnthropicAdapter(ProviderAdapter):
    provider_key = "anthropic"

    def _headers(self, api_key: str) -> dict:
        return {"x-api-key": api_key, "anthropic-version": ANTHROPIC_VERSION}

    async def test_connection(self, api_key: str, base_url: str | None) -> ConnectionTestResult:
        url = f"{(base_url or BASE_URL).rstrip('/')}/models?limit=1"
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                resp = await client.get(url, headers=self._headers(api_key))
        except httpx.RequestError as e:
            return ConnectionTestResult(ok=False, status="unreachable", error=str(e))

        if resp.status_code == 401:
            return ConnectionTestResult(ok=False, status="auth_failed", error="Invalid API key")
        if resp.status_code >= 400:
            return ConnectionTestResult(ok=False, status="unreachable", error=f"HTTP {resp.status_code}: {resp.text[:200]}")
        return ConnectionTestResult(ok=True, status="ok")

    async def list_models(self, api_key: str, base_url: str | None) -> list[CatalogEntryData]:
        root = (base_url or BASE_URL).rstrip("/")
        async with httpx.AsyncClient(timeout=20) as client:
            resp = await client.get(f"{root}/models?limit=1000", headers=self._headers(api_key))
            resp.raise_for_status()
        return [_entry_to_catalog(e) for e in resp.json()["data"]]
