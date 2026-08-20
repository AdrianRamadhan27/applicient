"""F1.8/F13.1/M1 §4 — embed evidence items (and, via `_raw_embed`,
job descriptions — see job_embedding.py) via the `embedding` tier,
with real metering.

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

`_raw_embed` is the shared raw-call-plus-metering core; job_embedding.py
reuses it rather than duplicating the metering/error-handling logic,
since a Job's description embedding lands on a different attribute
(`description_embedding`, not `embedding`) and is batched differently,
but the actual API call and cost-ledger write are identical.
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
    parts = [item.title, item.text, f"Skills: {skills}" if skills else None]
    return "\n".join(p for p in parts if p)


def _raw_embed(
    embeddings_client,
    texts: list[str],
    *,
    user_id: uuid.UUID,
    session_factory: sessionmaker,
    provider: str,
    tier: str = "embedding",
    stage: str | None = None,
    agent_run_id: uuid.UUID | None = None,
    source_run_id: uuid.UUID | None = None,
) -> list[list[float]]:
    """One real API call plus one real LlmCall row — success or
    failure. Raises on failure after logging the error row; callers
    that want per-batch isolation (job_embedding.py) catch around this,
    not inside it."""

    started = datetime.now(timezone.utc)
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
                    source_run_id=source_run_id,
                    stage=stage,
                    provider=provider,
                    model_id=embeddings_client.model,
                    tier=tier,
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
    if len(vectors) != len(texts):
        raise RuntimeError(f"embedding provider returned {len(vectors)} vectors for {len(texts)} inputs")

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
                source_run_id=source_run_id,
                stage=stage,
                provider=provider,
                model_id=embeddings_client.model,
                tier=tier,
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

    return [v.embedding for v in vectors]


def embed_evidence_items(
    session: Session,
    embeddings_client,
    items: list[EvidenceItem],
    *,
    user_id: uuid.UUID,
    session_factory: sessionmaker,
    provider: str,
    stage: str | None = None,
    agent_run_id: uuid.UUID | None = None,
) -> None:
    if not items:
        return

    texts = [_embedding_input(item) for item in items]
    vectors = _raw_embed(
        embeddings_client,
        texts,
        user_id=user_id,
        session_factory=session_factory,
        provider=provider,
        stage=stage,
        agent_run_id=agent_run_id,
    )
    for item, vector in zip(items, vectors):
        item.embedding = vector
    session.flush()
