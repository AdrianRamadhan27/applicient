"""Mistral adapter — M1 §7/F12.3. La Plateforme's API is documented as
OpenAI SDK-compatible (Bearer auth, `/v1/models`) but — unlike
Greenhouse/RemoteOK/Lever earlier in this project — no live key was
available to confirm the exact `/v1/models` response shape, only the
docs' own explicit statement that it exists and uses Bearer auth. This
is the same confidence gap JSearch's adapter stated honestly rather
than presenting with Greenhouse-level certainty: built from
documentation and a real, current pricing fetch, not a verified live
call. `list_models`/`test_connection` reuse the OpenAI-shape parsing;
if Mistral's actual response differs, this is the first place to look.

Pricing is a bundled table (F12.8), fetched live from mistral.ai's own
pricing page, stamped with the fetch date as pricing_version — same
discipline as the Anthropic/OpenAI adapters.
"""

from __future__ import annotations

import httpx

from applicient_api.providers.base import CatalogEntryData, ConnectionTestResult, ProviderAdapter

BASE_URL = "https://api.mistral.ai/v1"
PRICING_VERSION = "mistral-fetched-2026-08-20"

# $ per million tokens: (input, output). Fetched live from
# mistral.ai/pricing/api on the date in PRICING_VERSION above.
_PRICING: dict[str, tuple[float, float]] = {
    "mistral-medium-latest": (1.50, 7.50),
    "mistral-small-latest": (0.15, 0.60),
    "mistral-large-latest": (0.50, 1.50),
    "ministral-3b-latest": (0.10, 0.10),
    "ministral-8b-latest": (0.15, 0.15),
    "ministral-14b-latest": (0.20, 0.20),
    "codestral-latest": (0.30, 0.90),
    "mistral-embed": (0.10, 0.0),
    "codestral-embed": (0.15, 0.0),
}
_ALL_CURRENT_CHAT_CAPABILITIES = ["tools", "structured_output"]


def _entry_to_catalog(entry: dict) -> CatalogEntryData:
    model_id = entry["id"]
    is_embedding = "embed" in model_id.lower()
    pricing = _PRICING.get(model_id)
    return CatalogEntryData(
        model_id=model_id,
        display_name=model_id,
        capabilities=["embedding"] if is_embedding else _ALL_CURRENT_CHAT_CAPABILITIES,
        input_price_per_mtok=pricing[0] if pricing else None,
        output_price_per_mtok=pricing[1] if pricing else None,
        pricing_version=PRICING_VERSION if pricing else None,
        pricing_known=pricing is not None,
    )


class MistralAdapter(ProviderAdapter):
    provider_key = "mistral"

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
