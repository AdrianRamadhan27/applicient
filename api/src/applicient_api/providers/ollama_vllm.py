"""Ollama/vLLM adapter — M1 §7/F12.3, one adapter for both (grouped
together in the checklist itself) since both are self-hosted, free,
and expose the same OpenAI-compatible `/v1` surface — they differ only
in default port, which is exactly why this adapter takes `base_url` as
a real required input rather than assuming one: confirmed live-doc for
Ollama (`http://localhost:11434/v1`, API key "required but unused" —
any non-empty placeholder is accepted), vLLM commonly serves on
`:8000` by convention but that's configurable per deployment, not a
protocol guarantee, so it isn't hardcoded here either.

Unlike every other adapter here, pricing is not "unknown" for a local
server — it's genuinely, structurally zero. `pricing_known=True` with
$0/Mtok on every model, not the openai_compatible adapter's
`pricing_known=False`, since "we don't know the price" and "the price
is zero" are different facts and F13.6 says never blur them.

No API key is required to call `test_connection`/`list_models` — an
empty string is sent as a placeholder Bearer token if the caller
doesn't supply one, matching Ollama's own documented behavior.
"""

from __future__ import annotations

import httpx

from applicient_api.providers.base import CatalogEntryData, ConnectionTestResult, ProviderAdapter

_ALL_CURRENT_CHAT_CAPABILITIES = ["tools", "structured_output"]


def _entry_to_catalog(entry: dict) -> CatalogEntryData:
    model_id = entry["id"]
    is_embedding = "embed" in model_id.lower()
    return CatalogEntryData(
        model_id=model_id,
        display_name=model_id,
        capabilities=["embedding"] if is_embedding else _ALL_CURRENT_CHAT_CAPABILITIES,
        input_price_per_mtok=0.0,
        output_price_per_mtok=0.0,
        pricing_version="local-zero-cost",
        pricing_known=True,
    )


class OllamaVllmAdapter(ProviderAdapter):
    provider_key = "ollama_vllm"

    def _headers(self, api_key: str) -> dict:
        return {"Authorization": f"Bearer {api_key or 'local'}"}

    async def test_connection(self, api_key: str, base_url: str | None) -> ConnectionTestResult:
        if not base_url:
            return ConnectionTestResult(
                ok=False, status="unreachable", error="base_url is required — e.g. http://localhost:11434/v1"
            )
        url = f"{base_url.rstrip('/')}/models"
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                resp = await client.get(url, headers=self._headers(api_key))
        except httpx.RequestError as e:
            return ConnectionTestResult(ok=False, status="unreachable", error=str(e))

        if resp.status_code >= 400:
            return ConnectionTestResult(ok=False, status="unreachable", error=f"HTTP {resp.status_code}: {resp.text[:200]}")
        return ConnectionTestResult(ok=True, status="ok")

    async def list_models(self, api_key: str, base_url: str | None) -> list[CatalogEntryData]:
        if not base_url:
            raise ValueError("base_url is required for an Ollama/vLLM connection")
        root = base_url.rstrip("/")
        async with httpx.AsyncClient(timeout=20) as client:
            resp = await client.get(f"{root}/models", headers=self._headers(api_key))
            resp.raise_for_status()
        return [_entry_to_catalog(e) for e in resp.json()["data"]]
