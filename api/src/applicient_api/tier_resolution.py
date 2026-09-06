"""§7.5/F12.9 — resolve a capability tier to a concrete, ready-to-call
chat model. This is the one place tier -> model indirection actually
happens; no agent, subagent or tool may do this lookup itself or name
a model directly (PRD §7.5).

Deliberately minimal for now: reads the deployment's one active
ModelProfile, looks up the tier (falling back to a stage override if
one is set), and builds a LangChain chat model against the bound
catalog entry's provider. Capability preflight (F12.11 — verifying a
stage's required capabilities are present before a run starts) and
multi-provider chat model construction (ChatAnthropic, etc.) are real
gaps, left for when the GUI (step 5) and Anthropic actually need them
— flagged here rather than silently assumed complete.

SaaS pivot — ModelProfile is now admin-owned/shared for the whole
deployment, not per-user: the active-profile lookup below is no longer
filtered by `user_id` (see routers/model_profiles.py, now admin-gated).
`user_id` stays a required parameter here regardless — it's still
legitimately needed for LlmCall.user_id cost attribution (per-tenant
usage-cap enforcement and billing both need real per-user spend data,
even though only admins can configure which profile is active).
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


# Only providers with one fixed, well-known API endpoint get a default
# here. "openai_compatible" and "ollama_vllm" connections exist
# specifically to point at a user-supplied endpoint — silently falling
# back to some other provider's URL for those would mean a
# misconfigured connection quietly calls a completely different
# provider than the one the user thinks they added.
_DEFAULT_BASE_URLS = {
    "openrouter": "https://openrouter.ai/api/v1",
    "openai": "https://api.openai.com/v1",
    "mistral": "https://api.mistral.ai/v1",
}


def _resolve_base_url(conn: ProviderConnection) -> str:
    if conn.base_url:
        return conn.base_url
    default = _DEFAULT_BASE_URLS.get(conn.provider)
    if default is None:
        raise TierResolutionError(
            f"provider connection {conn.id} ({conn.provider!r}) has no base_url configured"
        )
    return default


def _build_chat_model(entry: ModelCatalogEntry, conn: ProviderConnection, callbacks: list[BaseCallbackHandler]) -> BaseChatModel:
    api_key = decrypt_api_key(conn.api_key_encrypted)

    # openai/mistral/ollama_vllm all speak the same OpenAI
    # chat-completions shape (confirmed live for openai/openrouter;
    # mistral and ollama_vllm are a stated, documentation-based
    # confidence gap — see their own adapter docstrings), so all five
    # reuse the one already-installed langchain-openai integration.
    # ollama_vllm has no default base_url (see _DEFAULT_BASE_URLS'
    # comment) — an unconfigured one correctly raises below via
    # _resolve_base_url, not a silent wrong-provider fallback.
    if conn.provider in ("openrouter", "openai_compatible", "openai", "mistral", "ollama_vllm"):
        from langchain_openai import ChatOpenAI

        return ChatOpenAI(
            model=entry.model_id,
            api_key=api_key or "unused",
            base_url=_resolve_base_url(conn),
            callbacks=callbacks,
            # Root-caused live (Adrian, direct: CV parsing's profile
            # section stuck empty forever on a real production account)
            # — no timeout was ever set here, so a stalled provider
            # request just hangs indefinitely. cv.py's own CV-scoring
            # step is the clearest victim: it does its own premature
            # db.commit() (cv_review_service.run_cv_score_for_profile)
            # BEFORE the caller's later commit that actually saves
            # `parsed_profile` — so a hang in exactly that LLM call
            # leaves evidence items durably saved while the profile
            # info never gets written, forever, with no error surfaced
            # anywhere (confirmed live: an AgentRun stuck status=
            # "running" for 3+ minutes with zero further provider
            # traffic in the logs). 120s is generous for a real
            # structured-output call (observed real CV parses complete
            # in 30-90s) while still bounding the wait — a timeout here
            # raises `openai.APITimeoutError`, which llm_retry.py's
            # invoke_structured_with_retry already retries once, and
            # cv.py's own scoring step already degrades gracefully
            # ("Analysis skipped: ...") if it fails twice — this one
            # parameter is what lets either of those actually run
            # instead of the call hanging forever first.
            timeout=120,
        )

    # Anthropic and Google AI Studio both have real catalog/pricing
    # adapters (F12.3) but neither has a chat-model builder wired up
    # here yet — each needs its own langchain-* integration added as a
    # dependency when first actually used, not installed speculatively
    # (google_ai_studio.py's docstring explains why in more detail).
    raise TierResolutionError(
        f"no chat model builder wired up yet for provider {conn.provider!r} "
        f"(model {entry.model_id!r}) — add the langchain-* integration when this provider is first used"
    )


def active_model_profile(session: Session) -> ModelProfile | None:
    """The one active ModelProfile for the whole deployment. Ordered by
    `updated_at` rather than a bare `.one_or_none()` so a deployment
    that (pre-migration, or through a data mistake) has more than one
    row with `is_active=True` degrades to "use the most recently
    changed one" instead of raising — the admin-only ModelProfile
    router (routers/model_profiles.py) is what actually enforces
    single-active going forward."""

    return (
        session.query(ModelProfile)
        .filter_by(is_active=True)
        .order_by(ModelProfile.updated_at.desc())
        .first()
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
    source_run_id: uuid.UUID | None = None,
    job_id: uuid.UUID | None = None,
    session_factory: sessionmaker,
) -> BaseChatModel:
    profile = active_model_profile(session)
    if profile is None:
        raise TierResolutionError("no active ModelProfile configured for this deployment — an admin must set one")

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
        source_run_id=source_run_id,
        job_id=job_id,
    )
    return _build_chat_model(entry, conn, [handler])


def resolve_embedding_tier(session: Session, *, user_id: uuid.UUID) -> tuple["OpenAIEmbeddings", str]:
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

    profile = active_model_profile(session)
    if profile is None:
        raise TierResolutionError("no active ModelProfile configured for this deployment — an admin must set one")

    catalog_entry_id = (profile.tier_bindings or {}).get("embedding")
    if catalog_entry_id is None:
        raise TierResolutionError(f"profile {profile.id} has no binding for the embedding tier")

    entry = session.get(ModelCatalogEntry, uuid.UUID(str(catalog_entry_id)))
    if entry is None:
        raise TierResolutionError(f"catalog entry {catalog_entry_id} referenced by profile no longer exists")

    conn = session.get(ProviderConnection, entry.provider_connection_id)
    if conn is None:
        raise TierResolutionError(f"provider connection for catalog entry {entry.id} no longer exists")

    if conn.provider not in ("openrouter", "openai_compatible", "openai", "mistral", "ollama_vllm"):
        raise TierResolutionError(
            f"no embedding client builder wired up yet for provider {conn.provider!r}"
        )

    from langchain_openai import OpenAIEmbeddings

    api_key = decrypt_api_key(conn.api_key_encrypted)
    client = OpenAIEmbeddings(
        model=entry.model_id,
        openai_api_key=api_key or "unused",
        openai_api_base=_resolve_base_url(conn),
        tiktoken_enabled=False,
        check_embedding_ctx_length=False,
        # The openai SDK defaults to requesting base64-encoded vectors
        # (an OpenAI-specific optimization); OpenRouter's proxy to this
        # Nvidia model rejects that with a 400 and asks for "float"
        # explicitly. Found by running a real embed call, not
        # documented anywhere obvious — langchain_openai's own
        # docstring mentions this exact failure mode but its example
        # doesn't show the fix.
        #
        # `truncate: "END"` — confirmed live during a real radar run: a
        # long job description (4615 tokens) exceeded this model's 4096
        # token limit and the endpoint returned a 422 naming the exact
        # fix ("set truncate=END or START"). `check_embedding_ctx_length`
        # is already off (tiktoken doesn't know this model's tokenizer,
        # per the docstring above), so nothing on the client side was
        # ever going to catch an oversized input before it reached the
        # API — this asks the server to safely truncate instead of
        # erroring, which is what job_embedding.py's own char-based
        # `_MAX_CHARS` cap was already trying to approximate but can't
        # guarantee exactly, since token:char ratio isn't fixed.
        #
        # `truncate` isn't a real field of the openai SDK's
        # `Embeddings.create()` (confirmed via its own signature — only
        # `dimensions`/`encoding_format`/`user` are named params) the
        # way `encoding_format` is, so it can't go directly into
        # `model_kwargs` as a bare key the way that one does — a first
        # attempt doing exactly that failed live with
        # `TypeError: Embeddings.create() got an unexpected keyword
        # argument 'truncate'`. `extra_body` is the SDK's own sanctioned
        # passthrough for provider-specific fields outside its typed
        # signature.
        model_kwargs={"encoding_format": "float", "extra_body": {"truncate": "END"}},
        # Same reasoning as _build_chat_model's own `timeout` above — a
        # stalled embeddings request has no bound otherwise. Shorter
        # than the chat model's 120s: embedding calls are much smaller/
        # faster requests by nature, and cv.py's own embedding step now
        # treats a failure here as best-effort (never blocks evidence/
        # profile from being saved), so there's no reason to make a
        # real user wait as long for this to give up.
        timeout=60,
    )
    # Returned alongside the client (rather than re-derived from
    # openai_api_base downstream) because more than one provider can
    # share a base_url shape — inferring provider from the URL string
    # is exactly the kind of guess F13.6 says never to make for cost
    # ledger rows.
    return client, conn.provider
