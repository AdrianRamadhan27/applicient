"""F1.8/F13.1 — embed evidence items via the `embedding` tier, with
real metering.

LangChain's `Embeddings` interface (unlike `BaseChatModel`) has no
callback mechanism at all — `embed_documents()` is a plain method with
no run_id or callback-manager plumbing, confirmed by inspecting
`langchain_core.embeddings.Embeddings` before assuming a
`callbacks=[...]` kwarg would work here the way it does for chat
models. So this bypasses LangChain's high-level wrapper and calls the
underlying OpenAI SDK client directly — which does return real
`usage` data (confirmed against a live OpenRouter call) — to get
genuine token counts for the ledger rather than fabricate or skip
them.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy.orm import Session, sessionmaker

from applicient_api.metering import CostLedgerCallbackHandler
from applicient_api.models.llm import LlmCall, ModelCatalogEntry, ProviderConnection
from applicient_api.models.profile import EvidenceItem


def _catalog_entry(session: Session, provider: str, model_id: str) -> ModelCatalogEntry | None:
    return (
        session.query(ModelCatalogEntry)
        .join(ProviderConnection, ModelCatalogEntry.provider_connection_id == ProviderConnection.id)
        .filter(
            ProviderConnection.user_id == session.info.get("applicient_user_id"),
            ProviderConnection.provider == provider,
            ModelCatalogEntry.model_id == model_id,
        )
        .order_by(ModelCatalogEntry.fetched_at.desc())
        .first()
    )


def _embedding_input(item: EvidenceItem) -> str:
    """Keep the retrieval representation tied to the editable fields."""

    skills = ", ".join(item.skills or [])
    return f"{item.text}\nSkills: {skills}" if skills else item.text


def embed_evidence_items(
    session: Session,
    embeddings_client,
    items: list[EvidenceItem],
    *,
    user_id: uuid.UUID,
    session_factory: sessionmaker,
    stage: str | None = None,
    agent_run_id: uuid.UUID | None = None,
) -> None:
    if not items:
        return

    texts = [_embedding_input(item) for item in items]
    started = datetime.now(timezone.utc)
    provider = "openrouter" if "openrouter.ai" in (embeddings_client.openai_api_base or "") else "openai"
    # Raw client call, not embed_documents() — see module docstring.
    try:
        response = embeddings_client.client.create(
            input=texts, model=embeddings_client.model, encoding_format="float"
        )
    except Exception as exc:
        latency_ms = int((datetime.now(timezone.utc) - started).total_seconds() * 1000)
        with session_factory() as metering_session:
            metering_session.info["applicient_user_id"] = user_id
            metering_session.add(
                LlmCall(
                    user_id=user_id,
                    agent_run_id=agent_run_id,
                    stage=stage,
                    provider=provider,
                    model_id=embeddings_client.model,
                    tier="embedding",
                    latency_ms=latency_ms,
                    cost_usd=0,
                    cost_known=False,
                    status="error",
                    error_message=str(exc)[:2000],
                    created_at=datetime.now(timezone.utc),
                )
            )
            metering_session.commit()
        raise
    latency_ms = int((datetime.now(timezone.utc) - started).total_seconds() * 1000)

    vectors = sorted(response.data, key=lambda value: getattr(value, "index", 0))
    if len(vectors) != len(items):
        raise RuntimeError(
            f"embedding provider returned {len(vectors)} vectors for {len(items)} evidence items"
        )
    for item, row in zip(items, vectors):
        item.embedding = row.embedding
    session.flush()

    # Provider is fixed to openrouter/openai_compatible/openai by
    # resolve_embedding_tier (the only providers it builds a client
    # for) — inferred from the client's configured base_url rather
    # than threaded through as a separate parameter, since the client
    # already carries it.
    with session_factory() as metering_session:
        metering_session.info["applicient_user_id"] = user_id
        entry = _catalog_entry(metering_session, provider, embeddings_client.model)
        usage = getattr(response, "usage", None)
        input_tokens = int(getattr(usage, "prompt_tokens", 0) or 0)
        cost_usd, pricing_version, cost_known = CostLedgerCallbackHandler._compute_cost(
            entry, input_tokens, 0, 0, 0
        )
        metering_session.add(
            LlmCall(
                user_id=user_id,
                agent_run_id=agent_run_id,
                stage=stage,
                provider=provider,
                model_id=embeddings_client.model,
                tier="embedding",
                input_tokens=input_tokens,
                output_tokens=0,
                latency_ms=latency_ms,
                cost_usd=cost_usd,
                pricing_version=pricing_version,
                cost_known=cost_known,
                status="ok",
                created_at=datetime.now(timezone.utc),
            )
        )
        metering_session.commit()
