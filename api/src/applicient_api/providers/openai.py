"""OpenAI adapter — M1 §7/F12.3. `GET /v1/models` (Bearer auth, `{"data":
[...]}` shape) validates the key and lists models but returns no
pricing, same limitation Anthropic's adapter already documents — so
pricing here is a bundled table too (F12.8), fetched live from OpenAI's
own public pricing page rather than guessed, stamped with the fetch
date as pricing_version. A model id not in the table still gets
listed, just with pricing_known=False, never a silently wrong price.

Capabilities are a family-based heuristic, same reasoning as
openai_compatible.py: OpenAI's `/v1/models` response carries no
capability flags at all, so every current chat model (gpt-5.x, gpt-4.1,
gpt-4o, o-series) is tagged tools+structured_output — true for the
whole current lineup, checked against the pricing page's own model
list, not assumed — and anything with "embedding" in its id is tagged
embedding-only instead.

Reuses `_build_chat_model`'s existing `ChatOpenAI` branch (already
wired for openrouter/openai_compatible) since OpenAI's own API is the
shape that branch was built against in the first place — no new
LangChain dependency needed, unlike Google AI Studio's adapter.
"""

from __future__ import annotations

import httpx

from applicient_api.providers.base import CatalogEntryData, ConnectionTestResult, ProviderAdapter

BASE_URL = "https://api.openai.com/v1"
PRICING_VERSION = "openai-fetched-2026-08-20"

# $ per million tokens: (input, output, cached_input). Fetched live from
# platform.openai.com/docs/pricing on the date in PRICING_VERSION above
# — the current flagship/mid-tier chat lineup plus embeddings, not
# every specialized (audio/image/moderation) model OpenAI sells, since
# none of those apply to this app's fast/balanced/deep/embedding tiers.
_PRICING: dict[str, tuple[float, float, float | None]] = {
    "gpt-5.6-sol": (5.00, 30.00, 0.50),
    "gpt-5.6-terra": (2.00, 12.00, 0.20),
    "gpt-5.6-luna": (0.20, 1.20, 0.02),
    "gpt-5.5": (5.00, 30.00, 0.50),
    "gpt-5.5-pro": (30.00, 180.00, None),
    "gpt-5.4": (2.50, 15.00, 0.25),
    "gpt-5.4-mini": (0.75, 4.50, 0.075),
    "gpt-5.4-nano": (0.20, 1.25, 0.02),
    "gpt-5.4-pro": (30.00, 180.00, None),
    "gpt-5.2": (1.75, 14.00, 0.175),
    "gpt-5.1": (1.25, 10.00, 0.125),
    "gpt-5": (1.25, 10.00, 0.125),
    "gpt-5-mini": (0.25, 2.00, 0.025),
    "gpt-5-nano": (0.05, 0.40, 0.005),
    "gpt-5-pro": (15.00, 120.00, None),
    "gpt-4.1": (2.00, 8.00, 0.50),
    "gpt-4.1-mini": (0.40, 1.60, 0.10),
    "gpt-4.1-nano": (0.10, 0.40, 0.025),
    "gpt-4o": (2.50, 10.00, 1.25),
    "gpt-4o-mini": (0.15, 0.60, 0.075),
    "o1": (15.00, 60.00, 7.50),
    "o1-pro": (150.00, 600.00, None),
    "o3": (2.00, 8.00, 0.50),
    "o3-pro": (20.00, 80.00, None),
    "o3-mini": (1.10, 4.40, 0.55),
    "o4-mini": (1.10, 4.40, 0.275),
    "text-embedding-3-small": (0.02, 0.0, None),
    "text-embedding-3-large": (0.13, 0.0, None),
    "text-embedding-ada-002": (0.10, 0.0, None),
}
_ALL_CURRENT_CHAT_CAPABILITIES = ["tools", "structured_output", "vision"]


def _entry_to_catalog(entry: dict) -> CatalogEntryData:
    model_id = entry["id"]
    is_embedding = "embedding" in model_id.lower()
    pricing = _PRICING.get(model_id)
    return CatalogEntryData(
        model_id=model_id,
        display_name=model_id,
        capabilities=["embedding"] if is_embedding else _ALL_CURRENT_CHAT_CAPABILITIES,
        input_price_per_mtok=pricing[0] if pricing else None,
        output_price_per_mtok=pricing[1] if pricing else None,
        cache_read_price_per_mtok=pricing[2] if pricing else None,
        pricing_version=PRICING_VERSION if pricing else None,
        pricing_known=pricing is not None,
    )


class OpenAIAdapter(ProviderAdapter):
    provider_key = "openai"

    def _headers(self, api_key: str) -> dict:
        return {"Authorization": f"Bearer {api_key}"}

    async def test_connection(self, api_key: str, base_url: str | None) -> ConnectionTestResult:
        url = f"{(base_url or BASE_URL).rstrip('/')}/models"
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
            resp = await client.get(f"{root}/models", headers=self._headers(api_key))
            resp.raise_for_status()
        return [_entry_to_catalog(e) for e in resp.json()["data"]]
