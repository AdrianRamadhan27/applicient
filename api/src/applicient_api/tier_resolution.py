"""§7.5/F12.9 — resolve a capability tier to a concrete, ready-to-call
chat model. This is the one place tier -> model indirection actually
happens; no agent, subagent or tool may do this lookup itself or name
a model directly (PRD §7.5).

Deliberately minimal for now: reads the user's active ModelProfile,
looks up the tier (falling back to a stage override if one is set),
and builds a LangChain chat model against the bound catalog entry's
provider. Capability preflight (F12.11 — verifying a stage's required
capabilities are present before a run starts) and multi-provider chat
model construction (ChatAnthropic, etc.) are real gaps, left for when
the GUI (step 5) and Anthropic actually need them — flagged here
rather than silently assumed complete.
"""

from __future__ import annotations

import uuid

from langchain_core.callbacks import BaseCallbackHandler
from langchain_core.language_models.chat_models import BaseChatModel
from sqlalchemy.orm import Session, sessionmaker

from applicient_api.metering import CostLedgerCallbackHandler
from applicient_api.models.llm import ModelCatalogEntry, ModelProfile, ProviderConnection
from applicient_api.security import decrypt_api_key


class TierResolutionError(Exception):
    pass


def _build_chat_model(entry: ModelCatalogEntry, conn: ProviderConnection, callbacks: list[BaseCallbackHandler]) -> BaseChatModel:
    api_key = decrypt_api_key(conn.api_key_encrypted)

    if conn.provider in ("openrouter", "openai_compatible", "openai"):
        from langchain_openai import ChatOpenAI

        return ChatOpenAI(
            model=entry.model_id,
            api_key=api_key,
            base_url=conn.base_url or "https://openrouter.ai/api/v1",
            callbacks=callbacks,
        )

    # Anthropic (and any other provider) needs its own langchain-*
    # integration added as a dependency when first actually used —
    # not installed speculatively.
    raise TierResolutionError(
        f"no chat model builder wired up yet for provider {conn.provider!r} "
        f"(model {entry.model_id!r}) — add the langchain-* integration when this provider is first used"
    )


def resolve_tier(
    session: Session,
    *,
    user_id: uuid.UUID,
    tier: str,
    stage: str | None = None,
    subagent_name: str | None = None,
    agent_run_id: uuid.UUID | None = None,
    agent_step_id: uuid.UUID | None = None,
    session_factory: sessionmaker,
) -> BaseChatModel:
    profile = (
        session.query(ModelProfile)
        .filter_by(user_id=user_id, is_active=True)
        .one_or_none()
    )
    if profile is None:
        raise TierResolutionError(f"no active ModelProfile for user {user_id}")

    catalog_entry_id = None
    if stage and stage in (profile.stage_overrides or {}):
        catalog_entry_id = profile.stage_overrides[stage]
    elif tier in (profile.tier_bindings or {}):
        catalog_entry_id = profile.tier_bindings[tier]

    if catalog_entry_id is None:
        raise TierResolutionError(f"profile {profile.id} has no binding for tier={tier!r} stage={stage!r}")

    entry = session.get(ModelCatalogEntry, uuid.UUID(str(catalog_entry_id)))
    if entry is None:
        raise TierResolutionError(f"catalog entry {catalog_entry_id} referenced by profile no longer exists")

    conn = session.get(ProviderConnection, entry.provider_connection_id)
    if conn is None:
        raise TierResolutionError(f"provider connection for catalog entry {entry.id} no longer exists")

    handler = CostLedgerCallbackHandler(
        session_factory,
        user_id=user_id,
        provider=conn.provider,
        model_id=entry.model_id,
        tier=tier,
        stage=stage,
        subagent_name=subagent_name,
        agent_run_id=agent_run_id,
        agent_step_id=agent_step_id,
    )
    return _build_chat_model(entry, conn, [handler])


def resolve_embedding_tier(session: Session, *, user_id: uuid.UUID):
    """Same tier-binding chain as resolve_tier, but for the
    `embedding` tier — a different LangChain class (OpenAIEmbeddings,
    not a chat model) since embeddings are a different API shape.

    tiktoken_enabled/check_embedding_ctx_length are turned off
    deliberately: both rely on tiktoken's tokenizer, which doesn't
    recognize non-OpenAI model ids like nvidia/nemotron-3-embed-1b —
    tested this against the live endpoint (see docs/IMPLEMENTATION.md
    step 6 log) and left enabled it silently mis-tokenizes rather than
    erroring, which is worse.
    """

    profile = session.query(ModelProfile).filter_by(user_id=user_id, is_active=True).one_or_none()
    if profile is None:
        raise TierResolutionError(f"no active ModelProfile for user {user_id}")

    catalog_entry_id = (profile.tier_bindings or {}).get("embedding")
    if catalog_entry_id is None:
        raise TierResolutionError(f"profile {profile.id} has no binding for the embedding tier")

    entry = session.get(ModelCatalogEntry, uuid.UUID(str(catalog_entry_id)))
    if entry is None:
        raise TierResolutionError(f"catalog entry {catalog_entry_id} referenced by profile no longer exists")

    conn = session.get(ProviderConnection, entry.provider_connection_id)
    if conn is None:
        raise TierResolutionError(f"provider connection for catalog entry {entry.id} no longer exists")

    if conn.provider not in ("openrouter", "openai_compatible", "openai"):
        raise TierResolutionError(
            f"no embedding client builder wired up yet for provider {conn.provider!r}"
        )

    from langchain_openai import OpenAIEmbeddings

    api_key = decrypt_api_key(conn.api_key_encrypted)
    return OpenAIEmbeddings(
        model=entry.model_id,
        openai_api_key=api_key,
        openai_api_base=conn.base_url or "https://openrouter.ai/api/v1",
        tiktoken_enabled=False,
        check_embedding_ctx_length=False,
        # The openai SDK defaults to requesting base64-encoded vectors
        # (an OpenAI-specific optimization); OpenRouter's proxy to this
        # Nvidia model rejects that with a 400 and asks for "float"
        # explicitly. Found by running a real embed call, not
        # documented anywhere obvious — langchain_openai's own
        # docstring mentions this exact failure mode but its example
        # doesn't show the fix.
        model_kwargs={"encoding_format": "float"},
    )
