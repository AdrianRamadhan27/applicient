"""Google AI Studio (Gemini) adapter — M1 §7/F12.3.

**Catalog/pricing/test-connection only — NOT wired into chat-model
construction.** Confirmed live-doc (`ai.google.dev/api/models`):
Gemini's real API is genuinely NOT OpenAI-shaped — the key goes in a
`?key=` query param, not an Authorization header, `GET /v1beta/models`
returns `{"models": [{"name": "models/gemini-...", "supportedGenerationMethods":
[...], ...}]}`, not `{"data": [{"id": ...}]}` — so this adapter has its
own real parsing, not a reuse of the OpenAI-shape helpers every other
adapter here shares. Building a `BaseChatModel` for it needs
`langchain-google-genai`, which is not installed — `tier_resolution.py`'s
own stated philosophy (see its `_build_chat_model` docstring) is that a
provider's LangChain integration is added "when first actually used,
not installed speculatively," same reasoning that's kept Anthropic's
own already-built catalog adapter unwired to this day. A ProviderConnection
can be created and its catalog refreshed today; binding a tier to a
Gemini model and actually running it will raise `TierResolutionError`
until that dependency is added — a real, stated gap, not silently
assumed complete.

Pricing is a bundled table (F12.8), fetched live from
ai.google.dev/gemini-api/docs/pricing, stamped with the fetch date.
Several Gemini models price differently past a 200k-token context
window — this table uses the base/lower-tier price only, same
"one flat number, not a formula" simplicity the Anthropic table
already accepts elsewhere in this codebase.
"""

from __future__ import annotations

import httpx

from applicient_api.providers.base import CatalogEntryData, ConnectionTestResult, ProviderAdapter

BASE_URL = "https://generativelanguage.googleapis.com/v1beta"
PRICING_VERSION = "google-ai-studio-fetched-2026-08-20"

# $ per million tokens: (input, output, cached_input). Base/≤200k-token
# tier only where Gemini prices by context length.
_PRICING: dict[str, tuple[float, float, float | None]] = {
    "gemini-3.7-flash": (0.75, 3.75, 0.075),
    "gemini-3.6-flash": (0.75, 3.75, 0.075),
    "gemini-3.5-flash": (1.50, 9.00, 0.15),
    "gemini-3.5-flash-lite": (0.30, 2.50, None),
    "gemini-3.1-flash-lite": (0.25, 1.50, 0.025),
    "gemini-3.1-pro-preview": (2.00, 12.00, 0.20),
    "gemini-3-flash-preview": (0.50, 3.00, 0.05),
    "gemini-2.5-pro": (1.25, 10.00, None),
    "gemini-2.5-flash": (0.30, 2.50, None),
    "gemini-2.5-flash-lite": (0.10, 0.40, None),
    "gemini-embedding-2": (0.20, 0.0, None),
    "gemini-embedding-001": (0.15, 0.0, None),
}
_ALL_CURRENT_CHAT_CAPABILITIES = ["tools", "structured_output", "vision"]


def _model_id(raw_name: str) -> str:
    # "models/gemini-2.5-pro" -> "gemini-2.5-pro" — the catalog and
    # every other adapter here store the bare id, never the resource
    # path prefix.
    return raw_name.split("/", 1)[-1]


def _entry_to_catalog(entry: dict) -> CatalogEntryData:
    model_id = _model_id(entry["name"])
    methods = entry.get("supportedGenerationMethods", [])
    is_embedding = "embedContent" in methods and "generateContent" not in methods
    pricing = _PRICING.get(model_id)
    return CatalogEntryData(
        model_id=model_id,
        display_name=entry.get("displayName", model_id),
        context_window=entry.get("inputTokenLimit"),
        max_output=entry.get("outputTokenLimit"),
        capabilities=["embedding"] if is_embedding else _ALL_CURRENT_CHAT_CAPABILITIES,
        input_price_per_mtok=pricing[0] if pricing else None,
        output_price_per_mtok=pricing[1] if pricing else None,
        cache_read_price_per_mtok=pricing[2] if pricing else None,
        pricing_version=PRICING_VERSION if pricing else None,
        pricing_known=pricing is not None,
    )


class GoogleAIStudioAdapter(ProviderAdapter):
    provider_key = "google_ai_studio"

    async def test_connection(self, api_key: str, base_url: str | None) -> ConnectionTestResult:
        url = f"{(base_url or BASE_URL).rstrip('/')}/models"
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                resp = await client.get(url, params={"key": api_key})
        except httpx.RequestError as e:
            return ConnectionTestResult(ok=False, status="unreachable", error=str(e))

        if resp.status_code in (400, 401, 403):
            return ConnectionTestResult(ok=False, status="auth_failed", error="Invalid API key")
        if resp.status_code >= 400:
            return ConnectionTestResult(ok=False, status="unreachable", error=f"HTTP {resp.status_code}: {resp.text[:200]}")
        return ConnectionTestResult(ok=True, status="ok")

    async def list_models(self, api_key: str, base_url: str | None) -> list[CatalogEntryData]:
        root = (base_url or BASE_URL).rstrip("/")
        async with httpx.AsyncClient(timeout=20) as client:
            resp = await client.get(f"{root}/models", params={"key": api_key, "pageSize": 1000})
            resp.raise_for_status()
        return [_entry_to_catalog(e) for e in resp.json().get("models", [])]
