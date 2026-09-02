"""M7 — drives one turn of a conversation with the orchestrator agent
end to end: resolves its three models (top-level, discovery-agent,
tailoring-agent), builds fresh tools/agent (cheap, rebuilt per turn —
same choice `application_service.py` already makes per attempt), drives
the LangGraph stream, and persists every event as a durable `RunEvent`
— same SSE stage-event shape and "write it down before yielding it"
discipline `radar.py`/`application_service.py` already established.

Two invocation modes over the SAME persisted `thread_id`, both funneling
through `_drive_turn`:
- `send_message` — an ordinary new chat turn
  (`astream({"messages": [...]})`). LangGraph's own checkpointer
  replays prior history under that thread_id; this needs no
  interrupt/resume machinery at all, unlike application_service.py's
  attempt-driving (which only ever has one "start" and N "resumes").
- `resume_message` — resolves a currently-pending `ask_user` interrupt
  (`astream(Command(resume={"decisions": [...]}))`) — only valid when
  `OrchestratorConversation.pending_interrupt` is set.

Checkpointer: a real, persistent `AsyncPostgresSaver`, not
application_service.py's per-attempt `InMemorySaver` — a conversation
is meant to span days, so losing it on every API restart would defeat
the point of this milestone. One shared instance for the whole
process, opened once at API startup (`init_checkpointer`, called from
main.py's lifespan) and closed at shutdown; keyed per-conversation by
its own durable `thread_id`, so — unlike application_service.py's
`_ACTIVE_ATTEMPTS` — no in-memory registry is needed to carry
checkpointer/thread_id state across separate HTTP requests. The one
thing still kept in memory is a thin per-conversation lock, purely to
reject a second concurrent turn against the same conversation (e.g. a
flaky client double-submitting) — not to carry any state a restart
would lose.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import uuid
from collections.abc import AsyncGenerator
from datetime import datetime, timezone

from langchain_core.messages import AIMessage, ToolMessage
from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver
from langgraph.types import Command
from sqlalchemy.orm import sessionmaker

from applicient_agents.orchestrator_agent import build_orchestrator_agent
from applicient_agents.orchestrator_tools import build_orchestrator_tools

from applicient_api.db import get_database_url
from applicient_api.models.agents import AgentRun, OrchestratorConversation, RunEvent
from applicient_api.tier_resolution import TierResolutionError, resolve_tier

_checkpointer: AsyncPostgresSaver | None = None
_checkpointer_cm = None
_CONVERSATION_LOCKS: dict[uuid.UUID, asyncio.Lock] = {}
# Stop/cancel button — cooperative, same discipline as radar.py's own
# `_CANCEL_EVENTS` (real `Task.cancel()` on the in-flight LangGraph
# step, not a "stop after this checkpoint" flag some future await
# happens to poll). Keyed by conversation_id, not agent_run_id — the
# frontend only ever knows the former, and `_lock_for` already
# guarantees at most one turn/run is live per conversation at a time,
# so it's an unambiguous key.
_CANCEL_EVENTS: dict[uuid.UUID, asyncio.Event] = {}


def request_cancel(conversation_id: uuid.UUID) -> bool:
    """True if a live turn was actually signaled to stop; False if none
    was found (already finished, or the request raced past it) — the
    caller falls back to marking the run cancelled directly in that
    case, same two-branch discipline as routers/streaming.py's generic
    /agent-runs/{id}/cancel."""

    event = _CANCEL_EVENTS.get(conversation_id)
    if event is None:
        return False
    event.set()
    return True


def _psycopg_url() -> str:
    # AsyncPostgresSaver wants a plain psycopg connection string, not
    # SQLAlchemy's dialect-qualified DATABASE_URL.
    return get_database_url().replace("+psycopg", "")


async def init_checkpointer() -> None:
    """Called once from main.py's startup lifespan, alongside the
    existing reconcile_stale_attempts() call."""

    global _checkpointer, _checkpointer_cm
    if _checkpointer is not None:
        return
    cm = AsyncPostgresSaver.from_conn_string(_psycopg_url())
    _checkpointer = await cm.__aenter__()
    _checkpointer_cm = cm
    await _checkpointer.setup()


async def close_checkpointer() -> None:
    global _checkpointer, _checkpointer_cm
    if _checkpointer_cm is not None:
        await _checkpointer_cm.__aexit__(None, None, None)
    _checkpointer = None
    _checkpointer_cm = None


def _lock_for(conversation_id: uuid.UUID) -> asyncio.Lock:
    lock = _CONVERSATION_LOCKS.get(conversation_id)
    if lock is None:
        lock = _CONVERSATION_LOCKS[conversation_id] = asyncio.Lock()
    return lock


def _error_event(message: str) -> dict:
    return {"event": "error", "data": json.dumps({"message": message})}


def create_conversation(
    session_factory: sessionmaker, *, persona_id: uuid.UUID, user_id: uuid.UUID, title: str | None = None
) -> OrchestratorConversation:
    """Always creates a genuinely new conversation — no idempotency.
    A conversation that's stuck (waiting on a decision the human isn't
    ready to make right now, or just one they want to walk away from)
    should never be the only option; "start a new chat" has to mean a
    real fresh thread, not the same one handed back again."""

    with session_factory() as db:
        convo = OrchestratorConversation(
            user_id=user_id, persona_id=persona_id, thread_id=str(uuid.uuid4()),
            status="active", title=title, last_active_at=datetime.now(timezone.utc),
        )
        db.add(convo)
        db.commit()
        db.refresh(convo)
        return convo


def get_latest_active_conversation(
    session_factory: sessionmaker, *, persona_id: uuid.UUID, user_id: uuid.UUID
) -> OrchestratorConversation | None:
    """For the Assistant page's initial load only — resume wherever you
    left off by default, same as opening ChatGPT, without forcing a
    fresh conversation every time the page loads. Returns None (not an
    error) when this persona has never had one — the caller creates
    the first one via `create_conversation` in that case."""

    with session_factory() as db:
        return (
            db.query(OrchestratorConversation)
            .filter_by(persona_id=persona_id, user_id=user_id, status="active")
            .order_by(OrchestratorConversation.last_active_at.desc())
            .first()
        )


def archive_conversation(
    session_factory: sessionmaker, *, conversation_id: uuid.UUID, user_id: uuid.UUID
) -> OrchestratorConversation | None:
    """Hides a conversation from the active list without deleting its
    history — the real escape hatch for one that's stuck on a decision
    the human doesn't want to make right now. Returns None if not found
    (already-archived or someone else's row are both treated as
    not-found by the caller, same ownership-check shape as everywhere
    else in this codebase)."""

    with session_factory() as db:
        convo = db.query(OrchestratorConversation).filter_by(id=conversation_id, user_id=user_id).one_or_none()
        if convo is None:
            return None
        convo.status = "archived"
        db.commit()
        db.refresh(convo)
        return convo


async def send_message(
    session_factory: sessionmaker, *, conversation_id: uuid.UUID, user_id: uuid.UUID, text: str
) -> AsyncGenerator[dict, None]:
    with session_factory() as db:
        convo = db.query(OrchestratorConversation).filter_by(id=conversation_id, user_id=user_id).one_or_none()
        if convo is None:
            yield _error_event("conversation not found")
            return
        if convo.pending_interrupt is not None:
            yield _error_event("this conversation is waiting on a pending decision — resume it, not a new message")
            return
        persona_id, thread_id = convo.persona_id, convo.thread_id

    async with _lock_for(conversation_id):
        async for evt in _drive_turn(
            session_factory, conversation_id=conversation_id, persona_id=persona_id, user_id=user_id,
            thread_id=thread_id, stream_input={"messages": [("user", text)]},
        ):
            yield evt


async def resume_message(
    session_factory: sessionmaker, *, conversation_id: uuid.UUID, user_id: uuid.UUID, decisions: list[dict]
) -> AsyncGenerator[dict, None]:
    with session_factory() as db:
        convo = db.query(OrchestratorConversation).filter_by(id=conversation_id, user_id=user_id).one_or_none()
        if convo is None:
            yield _error_event("conversation not found")
            return
        if convo.pending_interrupt is None:
            yield _error_event("this conversation has nothing pending to resume")
            return
        persona_id, thread_id = convo.persona_id, convo.thread_id

    async with _lock_for(conversation_id):
        async for evt in _drive_turn(
            session_factory, conversation_id=conversation_id, persona_id=persona_id, user_id=user_id,
            thread_id=thread_id, stream_input=Command(resume={"decisions": decisions}),
        ):
            yield evt


async def _drive_turn(
    session_factory: sessionmaker, *, conversation_id: uuid.UUID, persona_id: uuid.UUID,
    user_id: uuid.UUID, thread_id: str, stream_input,
) -> AsyncGenerator[dict, None]:
    if _checkpointer is None:
        yield _error_event("orchestrator checkpointer not initialized — the API did not start up correctly")
        return

    with session_factory() as db:
        run = AgentRun(
            user_id=user_id, run_type="orchestrator", status="running",
            conversation_id=conversation_id, persona_id=persona_id,
            started_at=datetime.now(timezone.utc),
        )
        db.add(run)
        db.commit()
        run_id = run.id

    cancel_event = asyncio.Event()
    _CANCEL_EVENTS[conversation_id] = cancel_event

    event_seq = 0

    def emit(event_type: str, data: dict) -> dict:
        nonlocal event_seq
        event_seq += 1
        with session_factory() as db:
            db.add(RunEvent(user_id=user_id, agent_run_id=run_id, seq=event_seq, event_type=event_type, data=data))
            db.commit()
        return {"event": event_type, "data": json.dumps(data)}

    # A tool whose underlying work takes multiple minutes
    # (run_discovery, tailor_cv) calls this to surface progress WHILE
    # it runs, not just once its return value comes back — without it
    # a human watching the chat would see nothing for the whole
    # duration of a real radar/tailoring run. Every call is dotted
    # ("discovery.progress", "tailoring.started", ...), split here into
    # the same stage/status/message shape every other SSE stream in
    # this app already uses (radar.py/job_groups.py's own `_event`).
    progress_queue: asyncio.Queue = asyncio.Queue()

    def emit_progress(event_type: str, data: dict) -> None:
        stage, _, status = event_type.partition(".")
        message = data.pop("message", "") if isinstance(data, dict) else ""
        evt = emit("stage", {"stage": stage, "status": status or "message", "message": message, **data})
        progress_queue.put_nowait(evt)

    def emit_card(card_type: str, data: dict) -> None:
        # A tool result the agent gets back is always a plain string —
        # this is the side channel that lets a tool ALSO hand the
        # frontend something genuinely structured (a scored job list, a
        # tailored document, a running application) to render as a real
        # embed instead of collapsing everything into prose. Same
        # durable-RunEvent + live-queue mechanism as emit_progress,
        # just its own top-level event_type so the frontend can tell a
        # card apart from an ordinary progress line.
        evt = emit("card", {"card_type": card_type, **data})
        progress_queue.put_nowait(evt)

    try:
        with session_factory() as db:
            model = resolve_tier(
                db, user_id=user_id, tier="deep", stage="orchestrator",
                agent_run_id=run_id, session_factory=session_factory,
            )
            discovery_model = resolve_tier(
                db, user_id=user_id, tier="balanced", stage="orchestrator.discovery-agent",
                agent_run_id=run_id, session_factory=session_factory,
            )
            tailoring_model = resolve_tier(
                db, user_id=user_id, tier="balanced", stage="orchestrator.tailoring-agent",
                agent_run_id=run_id, session_factory=session_factory,
            )
    except TierResolutionError as exc:
        with session_factory() as db:
            failed_run = db.get(AgentRun, run_id)
            failed_run.status = "failed"
            failed_run.finished_at = datetime.now(timezone.utc)
            db.commit()
        yield emit("error", {"message": f"model routing not configured: {exc}"})
        return

    tools = build_orchestrator_tools(
        user_id=user_id, persona_id=persona_id, agent_run_id=run_id,
        session_factory=session_factory, emit_progress=emit_progress, emit_card=emit_card,
    )
    agent = build_orchestrator_agent(
        model=model, discovery_model=discovery_model, tailoring_model=tailoring_model,
        tools=tools, checkpointer=_checkpointer,
    )
    config = {"configurable": {"thread_id": thread_id}}

    # Same disconnect/cancellation discipline as application_service.py's
    # own _drive_graph — a closed tab or dropped network tears this
    # generator down via GeneratorExit/CancelledError, neither of which
    # `except Exception` below ever catches, so without this `finally`
    # the run (and the conversation's own pending_interrupt state)
    # would stay stuck at "running" forever with no further events.
    reached_terminal_state = False
    try:
        agent_stream = agent.astream(stream_input, config=config)
        agent_task = asyncio.ensure_future(agent_stream.__anext__())
        queue_task = asyncio.ensure_future(progress_queue.get())
        cancel_task = asyncio.ensure_future(cancel_event.wait())
        try:
            while True:
                done, _pending = await asyncio.wait(
                    {agent_task, queue_task, cancel_task}, return_when=asyncio.FIRST_COMPLETED
                )
                if cancel_task in done:
                    # agent_task's own cancellation (a real Task.cancel(),
                    # not "stop at the next safe checkpoint") happens in
                    # the `finally` below, same as any other exit from
                    # this loop — nothing extra needed here beyond
                    # recording the outcome and stopping.
                    with session_factory() as db:
                        cancelled_run = db.get(AgentRun, run_id)
                        if cancelled_run is not None:
                            cancelled_run.status = "cancelled"
                            cancelled_run.finished_at = datetime.now(timezone.utc)
                            db.commit()
                        convo = db.get(OrchestratorConversation, conversation_id)
                        if convo is not None:
                            convo.pending_interrupt = None
                            convo.last_active_at = datetime.now(timezone.utc)
                            db.commit()
                    reached_terminal_state = True
                    yield emit("cancelled", {})
                    return
                if queue_task in done:
                    yield queue_task.result()
                    queue_task = asyncio.ensure_future(progress_queue.get())
                if agent_task in done:
                    try:
                        chunk = agent_task.result()
                    except StopAsyncIteration:
                        break

                    if "__interrupt__" in chunk:
                        interrupt_obj = chunk["__interrupt__"][0]
                        action_requests = interrupt_obj.value["action_requests"]
                        requests_out = [
                            {"tool": r["name"], "args": r["args"], "description": r.get("description", "")}
                            for r in action_requests
                        ]
                        with session_factory() as db:
                            convo = db.get(OrchestratorConversation, conversation_id)
                            convo.pending_interrupt = {"requests": requests_out}
                            convo.last_active_at = datetime.now(timezone.utc)
                            waiting_run = db.get(AgentRun, run_id)
                            waiting_run.status = "waiting_on_human"
                            waiting_run.finished_at = datetime.now(timezone.utc)
                            db.commit()
                        reached_terminal_state = True
                        yield emit("interrupt", {"requests": requests_out})
                        return

                    for _key, value in chunk.items():
                        msgs = value.get("messages", []) if isinstance(value, dict) else []
                        for m in msgs:
                            if isinstance(m, AIMessage):
                                if m.content:
                                    yield emit("stage", {"stage": "agent", "status": "message", "message": str(m.content)[:2000]})
                                for tc in m.tool_calls or []:
                                    call_desc = f"→ {tc.get('name', 'tool')}({tc.get('args', {})})"[:1000]
                                    yield emit("stage", {"stage": "tool_call", "status": "message", "message": call_desc})
                            elif isinstance(m, ToolMessage):
                                # Unlike browser_tools.py's page-snapshot
                                # results (deliberately never persisted
                                # in full), every orchestrator tool
                                # returns a short, human-meaningful
                                # summary on purpose — showing it in full
                                # is the point, not a risk.
                                content = str(m.content)
                                name = m.name or "tool"
                                yield emit("stage", {"stage": "tool_result", "status": "message", "message": f"← {name}: {content[:500]}"})

                    agent_task = asyncio.ensure_future(agent_stream.__anext__())
        finally:
            queue_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await queue_task
            cancel_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await cancel_task
            if not agent_task.done():
                agent_task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await agent_task

        with session_factory() as db:
            convo = db.get(OrchestratorConversation, conversation_id)
            convo.pending_interrupt = None
            convo.last_active_at = datetime.now(timezone.utc)
            finished_run = db.get(AgentRun, run_id)
            finished_run.status = "completed"
            finished_run.finished_at = datetime.now(timezone.utc)
            db.commit()
        reached_terminal_state = True
        yield emit("done", {})
    except Exception as exc:
        error_message = str(exc)[:500] or type(exc).__name__
        with session_factory() as db:
            errored_run = db.get(AgentRun, run_id)
            errored_run.status = "failed"
            errored_run.finished_at = datetime.now(timezone.utc)
            db.commit()
        reached_terminal_state = True
        yield emit("error", {"message": error_message})
    finally:
        if not reached_terminal_state:
            try:
                with session_factory() as db:
                    stuck_run = db.get(AgentRun, run_id)
                    if stuck_run is not None and stuck_run.status == "running":
                        stuck_run.status = "failed"
                        stuck_run.finished_at = datetime.now(timezone.utc)
                        db.commit()
            except Exception:
                pass
        # This turn's own event, not a stale one from whatever turn
        # runs next on this same conversation — `_lock_for` guarantees
        # no other `_drive_turn` is using this key concurrently, but a
        # leftover entry would still wrongly cancel a future turn the
        # instant it starts.
        _CANCEL_EVENTS.pop(conversation_id, None)
