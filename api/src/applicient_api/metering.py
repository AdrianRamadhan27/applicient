"""F13.1 — the cost ledger. A LangChain callback handler at the
framework boundary, wired in before any agent exists, so no call site
can forget to log (§13.1). Every LLM call anywhere in the system is
expected to pass an instance of this in `callbacks=[...]`.

Token accounting, verified against langchain_openai's actual source
(not assumed) before writing this:
  - usage_metadata.input_tokens already INCLUDES cache_read tokens as
    a subset (matches OpenAI/OpenRouter's own billing convention:
    prompt_tokens_details.cached_tokens is a breakdown OF
    prompt_tokens, not separate from it). So the "fresh" (full-price)
    input tokens are input_tokens - cache_read.
  - cache_creation (cache write) is treated as additive on top of
    input_tokens, matching Anthropic's native API convention
    (cache_creation_input_tokens is a separate counter). This half is
    a documented assumption, not independently verified against a
    live cache-write response — nothing in this system exercises
    prompt caching yet, so it doesn't affect the M0 verification call.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any

from langchain_core.callbacks import BaseCallbackHandler
from langchain_core.outputs import LLMResult
from sqlalchemy.orm import sessionmaker

from applicient_api.models.llm import LlmCall, ModelCatalogEntry, ProviderConnection


class CostLedgerCallbackHandler(BaseCallbackHandler):
    def __init__(
        self,
        session_factory: sessionmaker,
        *,
        user_id: uuid.UUID,
        provider: str,
        model_id: str,
        tier: str | None = None,
        stage: str | None = None,
        subagent_name: str | None = None,
        agent_run_id: uuid.UUID | None = None,
        agent_step_id: uuid.UUID | None = None,
    ) -> None:
        self.session_factory = session_factory
        self.user_id = user_id
        self.provider = provider
        self.model_id = model_id
        self.tier = tier
        self.stage = stage
        self.subagent_name = subagent_name
        self.agent_run_id = agent_run_id
        self.agent_step_id = agent_step_id
        self._started_at: dict[uuid.UUID, datetime] = {}

    # Both hooks fire depending on model type (chat vs. legacy
    # completion) — track start time under either.
    def on_chat_model_start(self, serialized: dict, messages: list, *, run_id: uuid.UUID, **kwargs: Any) -> None:
        self._started_at[run_id] = datetime.now(timezone.utc)

    def on_llm_start(self, serialized: dict, prompts: list[str], *, run_id: uuid.UUID, **kwargs: Any) -> None:
        self._started_at.setdefault(run_id, datetime.now(timezone.utc))

    def on_llm_end(self, response: LLMResult, *, run_id: uuid.UUID, **kwargs: Any) -> None:
        latency_ms = self._latency_ms(run_id)

        usage = None
        try:
            message = response.generations[0][0].message  # type: ignore[attr-defined]
            usage = getattr(message, "usage_metadata", None)
        except (IndexError, AttributeError):
            pass

        input_tokens = usage.get("input_tokens", 0) if usage else 0
        output_tokens = usage.get("output_tokens", 0) if usage else 0
        input_details = (usage or {}).get("input_token_details") or {}
        output_details = (usage or {}).get("output_token_details") or {}
        cache_read = input_details.get("cache_read") or 0
        cache_write = input_details.get("cache_creation") or 0
        reasoning = output_details.get("reasoning") or 0

        with self.session_factory() as session:
            catalog_entry = self._latest_catalog_entry(session)
            cost_usd, pricing_version, cost_known = self._compute_cost(
                catalog_entry, input_tokens, output_tokens, cache_read, cache_write
            )
            session.add(
                LlmCall(
                    user_id=self.user_id,
                    agent_run_id=self.agent_run_id,
                    agent_step_id=self.agent_step_id,
                    stage=self.stage,
                    subagent_name=self.subagent_name,
                    provider=self.provider,
                    model_id=self.model_id,
                    tier=self.tier,
                    input_tokens=input_tokens,
                    output_tokens=output_tokens,
                    cache_read_tokens=cache_read,
                    cache_write_tokens=cache_write,
                    reasoning_tokens=reasoning,
                    latency_ms=latency_ms,
                    cost_usd=cost_usd,
                    pricing_version=pricing_version,
                    cost_known=cost_known,
                    status="ok",
                    created_at=datetime.now(timezone.utc),
                )
            )
            session.commit()

    def on_llm_error(self, error: BaseException, *, run_id: uuid.UUID, **kwargs: Any) -> None:
        latency_ms = self._latency_ms(run_id)
        with self.session_factory() as session:
            session.add(
                LlmCall(
                    user_id=self.user_id,
                    agent_run_id=self.agent_run_id,
                    agent_step_id=self.agent_step_id,
                    stage=self.stage,
                    subagent_name=self.subagent_name,
                    provider=self.provider,
                    model_id=self.model_id,
                    tier=self.tier,
                    latency_ms=latency_ms,
                    cost_usd=0,
                    cost_known=False,
                    status="error",
                    error_message=str(error)[:2000],
                    created_at=datetime.now(timezone.utc),
                )
            )
            session.commit()

    def _latency_ms(self, run_id: uuid.UUID) -> int | None:
        started = self._started_at.pop(run_id, None)
        if started is None:
            return None
        return int((datetime.now(timezone.utc) - started).total_seconds() * 1000)

    def _latest_catalog_entry(self, session) -> ModelCatalogEntry | None:
        return (
            session.query(ModelCatalogEntry)
            .join(ProviderConnection, ModelCatalogEntry.provider_connection_id == ProviderConnection.id)
            .filter(
                ProviderConnection.user_id == self.user_id,
                ProviderConnection.provider == self.provider,
                ModelCatalogEntry.model_id == self.model_id,
            )
            .order_by(ModelCatalogEntry.fetched_at.desc())
            .first()
        )

    @staticmethod
    def _compute_cost(
        entry: ModelCatalogEntry | None,
        input_tokens: int,
        output_tokens: int,
        cache_read: int,
        cache_write: int,
    ) -> tuple[float, str | None, bool]:
        # F13.6 — an unpriced model logs real tokens/latency, never a
        # silent zero passed off as free.
        if entry is None or not entry.pricing_known:
            return 0.0, None, False

        fresh_input = max(input_tokens - cache_read, 0)  # cache_read is a subset of input_tokens
        cost = (
            (fresh_input / 1_000_000) * float(entry.input_price_per_mtok or 0)
            + (output_tokens / 1_000_000) * float(entry.output_price_per_mtok or 0)
            + (cache_read / 1_000_000) * float(entry.cache_read_price_per_mtok or 0)
            + (cache_write / 1_000_000) * float(entry.cache_write_price_per_mtok or 0)
        )
        return cost, entry.pricing_version, True
