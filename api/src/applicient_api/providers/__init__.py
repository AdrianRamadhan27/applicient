"""F12.3 — adapter registry. Adding a provider is one file implementing
ProviderAdapter and one line here."""

from applicient_api.providers.anthropic import AnthropicAdapter
from applicient_api.providers.base import CatalogEntryData, ConnectionTestResult, ProviderAdapter
from applicient_api.providers.google_ai_studio import GoogleAIStudioAdapter
from applicient_api.providers.mistral import MistralAdapter
from applicient_api.providers.ollama_vllm import OllamaVllmAdapter
from applicient_api.providers.openai import OpenAIAdapter
from applicient_api.providers.openai_compatible import OpenAICompatibleAdapter
from applicient_api.providers.openrouter import OpenRouterAdapter

ADAPTERS: dict[str, ProviderAdapter] = {
    "openrouter": OpenRouterAdapter(),
    "anthropic": AnthropicAdapter(),
    "openai": OpenAIAdapter(),
    "mistral": MistralAdapter(),
    "google_ai_studio": GoogleAIStudioAdapter(),
    "ollama_vllm": OllamaVllmAdapter(),
    "openai_compatible": OpenAICompatibleAdapter(),
}


def get_adapter(provider_key: str) -> ProviderAdapter:
    try:
        return ADAPTERS[provider_key]
    except KeyError:
        raise ValueError(
            f"no adapter registered for provider {provider_key!r} — "
            f"known: {sorted(ADAPTERS)}"
        ) from None


__all__ = ["ADAPTERS", "get_adapter", "CatalogEntryData", "ConnectionTestResult", "ProviderAdapter"]
