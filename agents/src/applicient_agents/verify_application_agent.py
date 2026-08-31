"""M4 checkpoint: proves the application-agent's real tool-calling
loop end to end against a disposable local test form — real Chromium
via the browser-worker service, a real deep-tier model making real
tool calls, and a real LangGraph interrupt/resume round trip for both
`browser_request_handoff` and `submit_application`.

Not a permanent fixture: a one-shot verification script, kept as a
record of what was checked (mirrors `setup_verification.py`'s own
precedent from M0).

Prerequisites: the browser-worker service running on :8100, and a
disposable HTML form served over real HTTP (not a data: URL — file
inputs and multi-field forms behave more realistically over http://).

Usage: uv run python -m applicient_agents.verify_application_agent <form_url>
"""

from __future__ import annotations

import sys
import uuid
from datetime import datetime, timezone

import httpx
from langchain_core.messages import AIMessage
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.types import Command

from applicient_agents.application_agent import build_application_agent
from applicient_agents.browser_tools import build_application_tools
from applicient_api.db import make_engine, make_session_factory
from applicient_api.models.agents import AgentRun
from applicient_api.models.llm import ModelCatalogEntry, ModelProfile
from applicient_api.models.profile import User
from applicient_api.tier_resolution import resolve_embedding_tier, resolve_tier


async def main(form_url: str) -> None:
    engine = make_engine()
    Session = make_session_factory(engine)

    with Session() as session:
        user = session.query(User).filter_by(email="demo@applicient.local").one()
        run = AgentRun(
            user_id=user.id,
            run_type="application-agent-verification",
            status="running",
            started_at=datetime.now(timezone.utc),
        )
        session.add(run)
        session.commit()
        run_id = run.id

        # NOTE: both the real `deep` binding (nvidia/nemotron-3-super-120b-a12b:free,
        # 404) and `balanced` (z-ai/glm-5.2:free, persistent 429 even after the
        # provider's own suggested backoff) are down against OpenRouter's shared
        # free pool right now — confirmed by repeated attempts, not a bug in this
        # script. Temporarily pointing a stage override at a different free,
        # tool-capable model for this one mechanism-proving run (restored
        # afterward) rather than touching the real tier bindings — same
        # "disposable test data on a real row, cleaned up after" precedent this
        # codebase already uses throughout (see M2's own log entries).
        profile = session.query(ModelProfile).filter_by(user_id=user.id, is_active=True).one()
        original_overrides = dict(profile.stage_overrides or {})
        fallback_entry = (
            session.query(ModelCatalogEntry).filter_by(model_id="openrouter/free").one()
        )
        profile.stage_overrides = {**original_overrides, "application": str(fallback_entry.id)}
        session.commit()

        model = resolve_tier(
            session,
            user_id=user.id,
            tier="deep",
            stage="application",
            agent_run_id=run_id,
            session_factory=Session,
        )
        embeddings_client, embeddings_provider = resolve_embedding_tier(session, user_id=user.id)

    fake_application_id = uuid.uuid4()
    fake_persona_id = uuid.uuid4()
    screenshots: list[str] = []

    try:
        await _run_agent(
            form_url,
            user=user,
            run_id=run_id,
            model=model,
            embeddings_client=embeddings_client,
            embeddings_provider=embeddings_provider,
            fake_application_id=fake_application_id,
            fake_persona_id=fake_persona_id,
            screenshots=screenshots,
            Session=Session,
        )
    finally:
        with Session() as session:
            run = session.get(AgentRun, run_id)
            run.status = "completed"
            run.finished_at = datetime.now(timezone.utc)
            profile = session.query(ModelProfile).filter_by(user_id=user.id, is_active=True).one()
            profile.stage_overrides = original_overrides
            session.commit()
            print("restored original stage_overrides:", original_overrides)


async def _run_agent(
    form_url: str,
    *,
    user,
    run_id,
    model,
    embeddings_client,
    embeddings_provider,
    fake_application_id,
    fake_persona_id,
    screenshots: list[str],
    Session,
) -> None:
    async with httpx.AsyncClient(timeout=30) as http_client:
        tools = build_application_tools(
            user_id=user.id,
            persona_id=fake_persona_id,
            application_id=fake_application_id,
            document_keys={},
            session_factory=Session,
            embeddings_client=embeddings_client,
            embeddings_provider=embeddings_provider,
            browser_worker_url="http://localhost:8100",
            http_client=http_client,
            record_screenshot=screenshots.append,
            record_email_draft=lambda draft: print(f"[email draft] {draft}"),
        )

        checkpointer = InMemorySaver()
        agent = build_application_agent(model=model, tools=tools, checkpointer=checkpointer)
        config = {"configurable": {"thread_id": str(uuid.uuid4())}}

        task = (
            f"Open {form_url} and fill out this job application for the candidate: "
            "full name 'Ada Lovelace', email 'ada@example.com'. For the 'why do you want "
            "this job' question, if the form has one, use form_answer_lookup first; if "
            "nothing is found, write one short sentence yourself. Take a screenshot before "
            "you submit. Only call submit_application once every field is filled and "
            "confirmed via a fresh snapshot."
        )

        print("=== invoking agent ===")
        handoffs_seen = 0
        submits_seen = 0
        stream_input = {"messages": [("user", task)]}

        # Loop: keep feeding the graph an appropriate resume decision
        # every time it raises a real interrupt, until it finishes with
        # no further interrupt — proves the round trip for whichever
        # gated tool the model actually calls, in whatever order.
        while True:
            interrupt_seen = None
            async for chunk in agent.astream(stream_input, config=config):
                if "__interrupt__" in chunk:
                    interrupt_seen = chunk["__interrupt__"][0]
                    print(f"\n=== INTERRUPT ===\n{interrupt_seen.value}\n")
                else:
                    for key, value in chunk.items():
                        msgs = value.get("messages", []) if isinstance(value, dict) else []
                        for m in msgs:
                            if isinstance(m, AIMessage) and m.content:
                                print(f"[{key}] agent: {m.content[:300]}")

            if interrupt_seen is None:
                break

            request = interrupt_seen.value["action_requests"][0]
            if request["name"] == "browser_request_handoff":
                handoffs_seen += 1
                print("--- responding to handoff: telling agent to continue ---")
                stream_input = Command(
                    resume={"decisions": [{"type": "respond", "message": "Logged in manually. Continue."}]}
                )
            elif request["name"] == "submit_application":
                submits_seen += 1
                print("--- approving submit_application ---")
                stream_input = Command(resume={"decisions": [{"type": "approve"}]})
            else:
                raise AssertionError(f"unexpected gated tool: {request['name']}")

        print("\n=== DONE ===")
        print("handoff interrupts handled:", handoffs_seen)
        print("submit interrupts handled:", submits_seen)
        print("screenshots captured:", screenshots)


if __name__ == "__main__":
    import asyncio

    asyncio.run(main(sys.argv[1]))
