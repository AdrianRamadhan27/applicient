"""Generic OpenAI-compatible adapter — F12.3's "one adapter, any
provider LangChain already supports via base_url" escape hatch. Lets
the user connect any endpoint that speaks the OpenAI chat-completions
API shape (Gemini's OpenAI-compat endpoint, Groq, Together, Fireworks,
a local vLLM/Ollama server, etc.) with nothing but a base_url and an
API key — no new adapter class per provider.

Unlike OpenRouter, a generic OpenAI-compatible `/models` listing has no
standard pricing fields and no reliable capability flags (no
`supported_parameters` equivalent), so this adapter cannot discover
either honestly:
  - pricing_known is always False (F13.6 — never report a guessed
    price as real).
  - capabilities are a heuristic, not a verified fact: a model id
    containing "embed" is tagged ["embedding"]; everything else is
    tagged ["tools", "structured_output"], since virtually every
    current OpenAI-compatible chat-completions endpoint supports
    both. This is optimistic by design — without it, no model from a
    generic connection could ever be bound to the "deep" tier, which
    requires structured_output (see models/page.tsx's tierOptions).
"""

from __future__ import annotations

import httpx

from applicient_api.providers.base import CatalogEntryData, ConnectionTestResult, ProviderAdapter


def _entry_to_catalog(entry: dict) -> CatalogEntryData:
    model_id = entry["id"]
    is_embedding = "embed" in model_id.lower()
    return CatalogEntryData(
        model_id=model_id,
        display_name=entry.get("id"),
        capabilities=["embedding"] if is_embedding else ["tools", "structured_output"],
        pricing_known=False,
    )


class OpenAICompatibleAdapter(ProviderAdapter):
    provider_key = "openai_compatible"

    async def test_connection(self, api_key: str, base_url: str | None) -> ConnectionTestResult:
        if not base_url:
            return ConnectionTestResult(
                ok=False, status="unreachable", error="base_url is required for an OpenAI-compatible connection"
            )
        url = f"{base_url.rstrip('/')}/models"
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                resp = await client.get(url, headers={"Authorization": f"Bearer {api_key}"})
        except httpx.RequestError as e:
            return ConnectionTestResult(ok=False, status="unreachable", error=str(e))

        if resp.status_code in (401, 403):
            return ConnectionTestResult(ok=False, status="auth_failed", error="Invalid API key")
        if resp.status_code >= 400:
            return ConnectionTestResult(
                ok=False, status="unreachable", error=f"HTTP {resp.status_code}: {resp.text[:200]}"
            )
        return ConnectionTestResult(ok=True, status="ok")

    async def list_models(self, api_key: str, base_url: str | None) -> list[CatalogEntryData]:
        if not base_url:
            raise ValueError("base_url is required for an OpenAI-compatible connection")
        root = base_url.rstrip("/")
        async with httpx.AsyncClient(timeout=20) as client:
            resp = await client.get(f"{root}/models", headers={"Authorization": f"Bearer {api_key}"})
            resp.raise_for_status()
        return [_entry_to_catalog(e) for e in resp.json()["data"]]
