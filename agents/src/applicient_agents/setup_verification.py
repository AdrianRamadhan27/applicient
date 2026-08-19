"""Step 4 checkpoint: the simplest possible deepagents call, running
standalone (no subagents, no tools), proving the whole chain works —
tier name in, real model resolved out, real reply back, real LlmCall
row logged, tied to a real AgentRun.

Not a permanent fixture: this is a one-shot verification script, run
once to prove the mechanism, kept as a record of what was checked
(mirrors how api/src/applicient_api/seed.py works — verification via
a runnable script, not a test double).

Usage: uv run python -m applicient_agents.setup_verification
"""

from __future__ import annotations

from datetime import datetime, timezone

from deepagents import create_deep_agent

from applicient_api.db import make_engine, make_session_factory
from applicient_api.model_profiles import upsert_active_profile
from applicient_api.models.agents import AgentRun
from applicient_api.models.llm import LlmCall, ModelCatalogEntry, ProviderConnection
from applicient_api.models.profile import User
from applicient_api.tier_resolution import resolve_tier


def main() -> None:
    engine = make_engine()
    Session = make_session_factory(engine)

    with Session() as session:
        user = session.query(User).filter_by(email="demo@applicient.local").one()

        # A free chat model from the OpenRouter catalog refreshed in
        # step 3 — bind it to the "fast" tier so there's something
        # real to resolve against.
        conn = session.query(ProviderConnection).filter_by(user_id=user.id, provider="openrouter").one()
        fast_entry = (
            session.query(ModelCatalogEntry)
            .filter(
                ModelCatalogEntry.provider_connection_id == conn.id,
                ModelCatalogEntry.input_price_per_mtok == 0,
                ~ModelCatalogEntry.capabilities.contains(["embedding"]),
            )
            .first()
        )
        assert fast_entry is not None, "no free chat model in catalog — run step 3's catalog refresh first"
        print(f"binding fast tier -> {fast_entry.model_id}")

        upsert_active_profile(
            session,
            user_id=user.id,
            name="openrouter-budget",
            tier_bindings={"fast": str(fast_entry.id)},
        )
        session.commit()

        run = AgentRun(
            user_id=user.id,
            run_type="setup-verification",
            status="running",
            started_at=datetime.now(timezone.utc),
        )
        session.add(run)
        session.commit()
        print(f"created AgentRun {run.id}")

        model = resolve_tier(
            session,
            user_id=user.id,
            tier="fast",
            stage="setup-verification",
            agent_run_id=run.id,
            session_factory=Session,
        )

    # create_deep_agent takes a live BaseChatModel instance directly —
    # this IS the tier-resolution indirection in action: nothing here
    # names a model, only a tier.
    agent = create_deep_agent(model=model)

    result = agent.invoke({"messages": [("user", "Reply with exactly one word: pong")]})
    reply = result["messages"][-1].content
    print(f"agent replied: {reply!r}")

    with Session() as session:
        run = session.get(AgentRun, run.id)
        run.status = "completed"
        run.finished_at = datetime.now(timezone.utc)

        calls = session.query(LlmCall).filter_by(agent_run_id=run.id).all()
        print(f"LlmCall rows tied to this AgentRun: {len(calls)}")
        assert calls, "no LlmCall row was written for this agent run"
        total_cost = sum(float(c.cost_usd) for c in calls)
        run.total_cost_usd = total_cost
        session.commit()

        for c in calls:
            print(
                f"  - stage={c.stage} subagent={c.subagent_name} tier={c.tier} "
                f"tokens in/out={c.input_tokens}/{c.output_tokens} cost=${c.cost_usd} "
                f"cost_known={c.cost_known} latency_ms={c.latency_ms}"
            )
        print(f"AgentRun {run.id} total_cost_usd=${run.total_cost_usd}")


if __name__ == "__main__":
    main()
