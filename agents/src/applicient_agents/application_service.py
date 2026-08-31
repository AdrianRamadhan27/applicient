"""F6/§7.3 — orchestrates one application-agent attempt end to end:
resolves the model/embeddings/documents, builds the tools and the
deepagents graph (`agents/src/applicient_agents/`), drives it, and
streams progress via the same SSE stage-event shape as
radar.py/job_groups.py. A raised interrupt pauses the stream with an
`interrupt` event instead of `done`/`error`; `resume_application_attempt`
continues the same in-memory graph from a later, separate request.

In-memory attempt registry, not a new durable broker — mirrors
radar.py's own `_CANCEL_EVENTS` precedent for coordinating a long-lived
run across separate HTTP requests. A real, disclosed limitation that
comes with it: an attempt awaiting a human decision does not survive
an API process restart. Swapping `InMemorySaver` for a Postgres-backed
checkpointer later needs no agent/tool code changes — that indirection
is exactly what LangGraph's checkpointer abstraction is for.
"""

from __future__ import annotations

import json
import os
import uuid
from asyncio import to_thread
from collections.abc import AsyncGenerator
from datetime import datetime, timezone

import httpx
from langchain_core.messages import AIMessage, ToolMessage
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.types import Command
from sqlalchemy.orm import sessionmaker

from applicient_agents.application_agent import build_application_agent
from applicient_agents.browser_tools import build_application_tools
from applicient_api.browser_context_service import load_storage_state, resolve_source_id, save_storage_state
from applicient_api.document_resolution import resolve_application_documents
from applicient_api.models.agents import AgentRun, AgentStep, RunEvent
from applicient_api.models.discovery import Job
from applicient_api.models.pipeline import Application, ApplicationAttempt
from applicient_api.pipeline_service import STATE_APPLIED
from applicient_api.models.profile import Persona, Preference, Profile
from applicient_api.tier_resolution import TierResolutionError, resolve_embedding_tier, resolve_tier

BROWSER_WORKER_URL = os.environ.get("BROWSER_WORKER_URL", "http://localhost:8100")

# F11.3 — global daily application cap, default 15. L3 (fill-and-submit)
# is only meaningful with a real cap behind it; L2 never consults this.
_DAILY_APPLICATION_CAP = int(os.environ.get("DAILY_APPLICATION_CAP", "15"))

_ACTIVE_ATTEMPTS: dict[uuid.UUID, dict] = {}


def _exc_message(exc: Exception) -> str:
    # Some exceptions (a bare TimeoutError, a LangGraph internal
    # assertion) stringify to "" — surfacing that verbatim as the
    # persisted/streamed error left a real failed run completely
    # unexplained (`"message": ""`, hit live). The exception's own
    # class name is still better than nothing.
    return str(exc)[:500] or type(exc).__name__


def _error_event(message: str) -> dict:
    # Only used before an AgentRun/ApplicationAttempt row exists yet
    # (application not found, no apply_url, L0 autonomy) — nothing to
    # persist a RunEvent against, so this stays ephemeral by design,
    # same as radar.py's own pre-run validation errors.
    return {"event": "error", "data": json.dumps({"message": message})}


def _emit(
    session_factory: sessionmaker,
    *,
    attempt_id: uuid.UUID,
    run_id: uuid.UUID,
    user_id: uuid.UUID,
    event_type: str,
    data: dict,
) -> dict:
    """Every event this module yields is also written down as a durable
    `RunEvent` row before it's returned — mirrors radar.py's own `_emit`
    precedent exactly (same table, same seq-per-run replay contract),
    fixing the identical problem Adrian raised there: navigating away
    from an in-progress run and back showed nothing, because the log
    only ever existed on the one open SSE connection. `seq` is tracked
    on `_ACTIVE_ATTEMPTS[attempt_id]` (not re-read from the DB) since
    it has to survive across `start_application_attempt` and every
    later separate `resume_application_attempt` call for the same
    attempt, exactly like `checkpointer`/`thread_id` already do."""

    state = _ACTIVE_ATTEMPTS.get(attempt_id)
    seq = (state.get("event_seq", 0) if state else 0) + 1
    if state is not None:
        state["event_seq"] = seq
    with session_factory() as db:
        db.add(RunEvent(user_id=user_id, agent_run_id=run_id, seq=seq, event_type=event_type, data=data))
        db.commit()
    return {"event": event_type, "data": json.dumps(data)}


def _stage_data(stage: str, status: str, message: str, **detail) -> dict:
    return {"stage": stage, "status": status, "message": message, **detail}


def _interrupt_data(attempt_id: uuid.UUID, action_requests: list[dict]) -> dict:
    # A single LLM turn can call an interrupt-gated tool more than
    # once (the agent calling `ask_user` several times in a row
    # instead of one at a time was hit live) — LangGraph pauses on
    # the whole batch at once and requires exactly one decision per
    # hanging call on resume, in the same order. Surfacing only
    # `action_requests[0]` and resuming with one decision silently
    # desynced from however many were actually pending, crashing with
    # "Number of human decisions (N) does not match number of hanging
    # tool calls (M)" deep inside LangGraph. Every request is carried
    # through here so the resume payload can always match in length.
    return {
        "attempt_id": str(attempt_id),
        "requests": [
            {"tool": r["name"], "args": r["args"], "description": r.get("description", "")}
            for r in action_requests
        ],
    }


def _today_applied_count(session_factory: sessionmaker, *, user_id: uuid.UUID) -> int:
    start_of_day = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    with session_factory() as db:
        return (
            db.query(Application)
            .filter(
                Application.user_id == user_id,
                Application.applied_at.isnot(None),
                Application.applied_at >= start_of_day,
            )
            .count()
        )


def _candidate_info_block(session_factory: sessionmaker, *, persona_id: uuid.UUID, user_id: uuid.UUID) -> str:
    """The task prompt's only source of ground truth for who the
    candidate is and what they actually want — without this, the agent
    has nothing to fill contact fields with except a fabrication
    (F6.3), and nothing to answer a salary/relocation/visa/notice-
    period question with except `ask_user`, even when the exact answer
    was already captured once, elsewhere in the app. A real run asked
    a human for their CV/salary/visa status live, which turned out to
    be a synchronization gap, not a missing feature — Preferences
    (F1.9) and Profile's own visa/notice-period fields (F1.4) already
    hold real, previously-entered answers to exactly that class of
    question; this just never read them. Reuses `Profile.parsed_profile`
    (F1.1's CV extraction) plus those two sources — three real,
    already-captured places, not a second, separate contact-info
    system."""

    with session_factory() as db:
        persona = db.query(Persona).filter_by(id=persona_id, user_id=user_id).one_or_none()
        if persona is None:
            return "No profile is available for this persona."
        profile = db.get(Profile, persona.profile_id)
        if profile is None:
            return "No profile is available for this persona."

        lines: list[str] = []
        if profile.parsed_profile:
            lines.extend(f"{k}: {v}" for k, v in profile.parsed_profile.items() if v not in (None, "", []))
        if profile.visa_status:
            lines.append(f"visa_status: {profile.visa_status}")
        if profile.notice_period_days is not None:
            lines.append(f"notice_period_days: {profile.notice_period_days}")

        preference = db.query(Preference).filter_by(persona_id=persona_id, user_id=user_id).one_or_none()
        if preference is not None:
            if preference.salary_floor is not None or preference.salary_target is not None:
                lines.append(
                    f"salary_expectation: floor={preference.salary_floor}, "
                    f"target={preference.salary_target}, currency={preference.salary_currency}"
                )
            lines.append(f"willing_to_relocate: {preference.willing_to_relocate}")
            if preference.locations:
                lines.append(f"preferred_locations: {', '.join(preference.locations)}")
            if preference.remote_policy:
                lines.append(f"remote_policy_preference: {', '.join(preference.remote_policy)}")
            if preference.seniority:
                lines.append(f"seniority_preference: {', '.join(preference.seniority)}")
            if preference.deal_breakers:
                lines.append(f"deal_breakers: {', '.join(preference.deal_breakers)}")

        return "\n".join(lines) if lines else "No profile or preference fields are available for this persona."


def reconcile_stale_attempts(session_factory: sessionmaker) -> None:
    """Run once at API startup (see `main.py`'s lifespan). `_ACTIVE_ATTEMPTS`
    is in-memory only — any `ApplicationAttempt` still claiming
    in_progress/awaiting_* after a process restart can never actually be
    resumed, since its checkpointer/thread_id/browser session died with
    the old process (this module's own disclosed InMemorySaver
    limitation). Left alone, the Pipeline UI's reconnect path would
    poll such an attempt's events forever (`AgentRun.status` stuck at
    "running" with nothing left to ever close it out) and its interrupt
    controls would never reappear (no RunEvent history exists for an
    attempt whose run died before this pass added persistence, or one
    that never got the chance to write one). Marking these failed here
    — visibly, with a clear reason — is strictly more honest than
    leaving them looking perpetually active."""

    stale_statuses = ("in_progress", "awaiting_review", "awaiting_handoff")
    with session_factory() as db:
        attempts = db.query(ApplicationAttempt).filter(ApplicationAttempt.status.in_(stale_statuses)).all()
        for attempt in attempts:
            attempt.status = "failed"
            attempt.error = "interrupted by a server restart — start a new attempt to continue"
            attempt.finished_at = datetime.now(timezone.utc)
            if attempt.agent_run_id is not None:
                run = db.get(AgentRun, attempt.agent_run_id)
                if run is not None and run.status == "running":
                    run.status = "failed"
                    run.finished_at = datetime.now(timezone.utc)
        db.commit()


async def start_application_attempt(
    session_factory: sessionmaker, *, application_id: uuid.UUID, user_id: uuid.UUID
) -> AsyncGenerator[dict, None]:
    with session_factory() as db:
        application = db.query(Application).filter_by(id=application_id, user_id=user_id).one_or_none()
        if application is None:
            yield _error_event("application not found")
            return
        job = db.get(Job, application.job_id)
        if job is None or not job.apply_url:
            yield _error_event("this job has no known apply URL — nothing for the agent to open")
            return

        autonomy_level = application.autonomy_level or "l2_fill_review"
        if autonomy_level == "l0_manual":
            yield _error_event("autonomy is set to L0 (manual) — the agent does not run for this application")
            return

        if autonomy_level == "l3_fill_submit":
            applied_today = _today_applied_count(session_factory, user_id=user_id)
            if applied_today >= _DAILY_APPLICATION_CAP:
                yield _error_event(
                    f"L3 daily application cap reached ({applied_today}/{_DAILY_APPLICATION_CAP}) — "
                    "falling back to L2 review for this application"
                )
                autonomy_level = "l2_fill_review"

        run = AgentRun(
            user_id=user_id, run_type="application", status="running", started_at=datetime.now(timezone.utc)
        )
        db.add(run)
        db.commit()
        run_id = run.id

        attempt_number = db.query(ApplicationAttempt).filter_by(application_id=application_id).count() + 1
        attempt = ApplicationAttempt(
            application_id=application_id,
            agent_run_id=run_id,
            attempt_number=attempt_number,
            autonomy_level=autonomy_level,
            status="in_progress",
            field_map={},
            screenshot_keys=[],
            started_at=datetime.now(timezone.utc),
        )
        db.add(attempt)
        db.commit()
        attempt_id = attempt.id
        persona_id = application.persona_id
        apply_url = job.apply_url

        # F6.6 — a saved, decrypted session from a previous successful
        # login on this exact (persona, source) pair, if one exists.
        # Resolved here (not inside browser_tools.py) since only this
        # side has the DB/object-storage access to do it; handed to
        # build_application_tools below as a plain dict so browser_open
        # can start already authenticated instead of hitting a login
        # wall on every single attempt.
        source_id = resolve_source_id(db, job)
        storage_state = (
            load_storage_state(db, user_id=user_id, persona_id=persona_id, source_id=source_id)
            if source_id
            else None
        )

        # Seeded here, before anything is resolved, so `_emit` below has
        # a seq counter to increment from its very first call — the
        # rest of this dict is filled in once resolution succeeds,
        # explicitly carrying `event_seq` forward rather than
        # overwriting it back to a fresh dict.
        _ACTIVE_ATTEMPTS[attempt_id] = {"event_seq": 0}

        def emit(event_type: str, data: dict) -> dict:
            return _emit(
                session_factory, attempt_id=attempt_id, run_id=run_id, user_id=user_id,
                event_type=event_type, data=data,
            )

        try:
            yield emit("stage", _stage_data("preparing", "started", "Resolving documents and model routing"))
            document_keys = await to_thread(
                resolve_application_documents, session_factory, application_id=application_id, user_id=user_id
            )
            candidate_info = await to_thread(
                _candidate_info_block, session_factory, persona_id=persona_id, user_id=user_id
            )
            model = resolve_tier(
                db, user_id=user_id, tier="deep", stage="application", agent_run_id=run_id,
                session_factory=session_factory,
            )
            embeddings_client, embeddings_provider = resolve_embedding_tier(db, user_id=user_id)
        except TierResolutionError as exc:
            attempt.status = "failed"
            attempt.error = str(exc)
            attempt.finished_at = datetime.now(timezone.utc)
            run.status = "failed"
            run.finished_at = datetime.now(timezone.utc)
            db.commit()
            yield emit("error", {"message": f"model routing not configured: {exc}"})
            _ACTIVE_ATTEMPTS.pop(attempt_id, None)
            return
        yield emit("stage", _stage_data("preparing", "done", f"Resolved {len(document_keys)} document(s) for upload"))

    _ACTIVE_ATTEMPTS[attempt_id] = {
        "event_seq": _ACTIVE_ATTEMPTS[attempt_id]["event_seq"],
        "user_id": user_id,
        "persona_id": persona_id,
        "application_id": application_id,
        "source_id": source_id,
        "storage_state": storage_state,
        "document_keys": document_keys,
        "model": model,
        "embeddings_client": embeddings_client,
        "embeddings_provider": embeddings_provider,
        "checkpointer": InMemorySaver(),
        "thread_id": str(uuid.uuid4()),
        "require_submit_approval": autonomy_level != "l3_fill_submit",
        "run_id": run_id,
    }

    task = (
        f"Open {apply_url} and fill out this job application for this candidate:\n\n"
        f"{candidate_info}\n\n"
        f"Rendered attachments available to upload via browser_upload's document_type argument: "
        f"{sorted(document_keys.keys()) or 'none'}. For any question not answered by the block above, "
        "call form_answer_lookup first. If it finds nothing, treat the field as unresolvable and state "
        "clearly in your final response what you need — never fabricate a value for it. Take a "
        "screenshot before requesting review or handoff, and again right after a successful submit."
    )
    async for evt in _drive_graph(attempt_id, {"messages": [("user", task)]}, session_factory):
        yield evt


async def resume_application_attempt(
    session_factory: sessionmaker, *, attempt_id: uuid.UUID, user_id: uuid.UUID, decisions: list[dict]
) -> AsyncGenerator[dict, None]:
    state = _ACTIVE_ATTEMPTS.get(attempt_id)
    if state is None or state["user_id"] != user_id:
        yield _error_event("no attempt is currently awaiting a decision with this id")
        return
    async for evt in _drive_graph(attempt_id, Command(resume={"decisions": decisions}), session_factory):
        yield evt


async def _drive_graph(
    attempt_id: uuid.UUID, stream_input, session_factory: sessionmaker
) -> AsyncGenerator[dict, None]:
    state = _ACTIVE_ATTEMPTS.get(attempt_id)
    if state is None:
        yield _error_event("attempt not found or already finished")
        return

    def emit(event_type: str, data: dict) -> dict:
        # Every event this generator yields now reliably carries its
        # own attempt_id — "interrupt"/"done" always built it in
        # explicitly, but a plain "stage" event (e.g. "browser session
        # opened", the one the Live Browser link depends on) never
        # did. The frontend's fallback for that case (guessing from
        # detail.attempts[0]) is stale/empty for a first-ever attempt
        # that's still running — detail isn't refetched until the run
        # reaches an interrupt or finishes — which is exactly what
        # sent a live "Watch live browser" click to /pipeline/live
        # with an empty attempt_id and the "missing params" page.
        return _emit(
            session_factory, attempt_id=attempt_id, run_id=state["run_id"], user_id=state["user_id"],
            event_type=event_type, data={**data, "attempt_id": str(attempt_id)},
        )

    def record_screenshot(key: str) -> None:
        with session_factory() as db:
            attempt = db.get(ApplicationAttempt, attempt_id)
            if attempt is not None:
                attempt.screenshot_keys = [*(attempt.screenshot_keys or []), key]
                db.commit()

    def record_email_draft(draft: dict) -> None:
        with session_factory() as db:
            attempt = db.get(ApplicationAttempt, attempt_id)
            if attempt is not None:
                attempt.email_draft = draft
                attempt.status = "awaiting_email"
                db.commit()

    async def persist_browser_session(http_client: httpx.AsyncClient, *, close: bool) -> None:
        """F6.6 — saves the live browser-worker session's current
        `storage_state()` back to this (persona, source)'s
        BrowserContext, so a later attempt can start already logged in.
        `close=True` also tears the browser-worker session down (a
        `DELETE`, which itself returns the final storage_state) —
        called once a run truly has no more use for its browser, fixing
        a real pre-existing leak: no code anywhere ever closed a
        browser-worker session before this, so every attempt's Chromium
        context stayed open (and its memory held) for the life of the
        browser-worker process. `close=False` (an interrupt) must NOT
        close it — the same session has to still be there for the
        human's handoff or the next resume."""

        session_id = state.get("browser_session_id")
        if session_id is None:
            return
        url = f"{BROWSER_WORKER_URL}/sessions/{session_id}" + ("" if close else "/storage-state")
        try:
            r = await (http_client.delete(url) if close else http_client.get(url))
        except httpx.HTTPError:
            return
        if r.is_error:
            return
        source_id = state.get("source_id")
        if source_id is None:
            return
        with session_factory() as db:
            save_storage_state(
                db, user_id=state["user_id"], persona_id=state["persona_id"],
                source_id=source_id, storage_state=r.json()["storage_state"],
            )
            db.commit()

    async with httpx.AsyncClient(timeout=60) as http_client:
        tools = build_application_tools(
            user_id=state["user_id"],
            persona_id=state["persona_id"],
            application_id=state["application_id"],
            document_keys=state["document_keys"],
            session_factory=session_factory,
            embeddings_client=state["embeddings_client"],
            embeddings_provider=state["embeddings_provider"],
            browser_worker_url=BROWSER_WORKER_URL,
            http_client=http_client,
            record_screenshot=record_screenshot,
            record_email_draft=record_email_draft,
            storage_state=state.get("storage_state"),
        )
        agent = build_application_agent(
            model=state["model"],
            tools=tools,
            checkpointer=state["checkpointer"],
            require_submit_approval=state["require_submit_approval"],
        )
        config = {"configurable": {"thread_id": state["thread_id"]}}

        # A closed tab, backgrounded browser, or dropped network tears
        # this generator down via GeneratorExit/CancelledError partway
        # through — neither is an `Exception`, so the `except Exception`
        # below never catches it, and without this `finally` the attempt
        # (and run) would stay stuck at "in_progress"/"running" forever
        # with no further events, exactly the failure mode radar.py's own
        # `finally` block was built to close out. The agent keeps running
        # in-process regardless (this generator not being read doesn't
        # cancel the underlying browser session or LangGraph state by
        # itself) — but nothing would ever mark it interrupted here, so a
        # later reconnect via GET .../events would see a status that
        # never resolves. Only fires if neither the interrupt path nor
        # the completion path already returned normally below.
        # Two different things this flag would otherwise conflate: an
        # interrupt reaches a real, definitive status (awaiting_* is not
        # "stuck") but must NOT clear `_ACTIVE_ATTEMPTS` — the whole
        # point of that entry is to keep the checkpointer/thread_id/
        # browser session alive for a *later, separate*
        # `resume_application_attempt` call. Only "done"/error/disconnect
        # are truly finished with this attempt.
        reached_terminal_state = False
        keep_active_state = False
        # F4/§7's Run Console trace, extended here for real (previously
        # disclosed as not populated for application-agent runs): one
        # AgentStep per completed tool call, paired by LangChain's own
        # tool_call_id rather than name (several calls to the same tool
        # can be in flight in one turn). A call that's still pending
        # when the graph pauses on an interrupt or finishes is simply
        # never written — nothing left to pair it with in this stream.
        pending_tool_steps: dict[str, dict] = {}
        try:
            async for chunk in agent.astream(stream_input, config=config):
                if "__interrupt__" in chunk:
                    interrupt_obj = chunk["__interrupt__"][0]
                    action_requests = interrupt_obj.value["action_requests"]
                    with session_factory() as db:
                        attempt = db.get(ApplicationAttempt, attempt_id)
                        attempt.status = (
                            "awaiting_handoff"
                            if any(r["name"] == "browser_request_handoff" for r in action_requests)
                            else "awaiting_review"
                        )
                        db.commit()
                    reached_terminal_state = True
                    keep_active_state = True
                    # Not a close — the human's handoff/review needs the
                    # same live session; just checkpoints its current
                    # storage_state in case the process dies before the
                    # eventual resume gets a chance to.
                    await persist_browser_session(http_client, close=False)
                    yield emit("interrupt", _interrupt_data(attempt_id, action_requests))
                    return
                for _key, value in chunk.items():
                    msgs = value.get("messages", []) if isinstance(value, dict) else []
                    for m in msgs:
                        if isinstance(m, AIMessage):
                            if m.content:
                                yield emit("stage", _stage_data("agent", "message", str(m.content)[:2000]))
                            # Ground truth for exactly what was called and
                            # with what args — never a secret, no tool
                            # here ever takes a raw credential value as an
                            # argument (browser_fill_credential resolves
                            # it server-side from just a label). Without
                            # this, a turn that was purely a tool call
                            # (very common) left no persisted trace at
                            # all, which is exactly what made a real
                            # failed run hard to diagnose after the fact.
                            for tc in m.tool_calls or []:
                                call_desc = f"→ {tc.get('name', 'tool')}({tc.get('args', {})})"[:1000]
                                yield emit("stage", _stage_data("tool_call", "message", call_desc))
                                tc_id = tc.get("id")
                                if tc_id:
                                    pending_tool_steps[tc_id] = {
                                        "name": tc.get("name", "tool"),
                                        "args": tc.get("args", {}),
                                        "started_at": datetime.now(timezone.utc),
                                    }
                        elif isinstance(m, ToolMessage):
                            # A successful result is often the page's own
                            # accessibility-tree snapshot — never persisted
                            # verbatim here, since it can contain whatever
                            # the form itself does (this is a stricter
                            # rule than strictly necessary for most tools,
                            # applied uniformly rather than special-cased
                            # per tool). An error result is always the
                            # worker's own Playwright-level message, never
                            # page content, so it's safe and useful to
                            # keep in full.
                            content = str(m.content)
                            name = m.name or "tool"
                            summary = content[:300] if content.startswith("error:") else "ok"
                            # F6.6/§2's live-browser link: browser_open's
                            # own result is the one place the browser-worker
                            # session_id is ever produced — never captured
                            # anywhere before this, so nothing could later
                            # save its storage_state or close it, or let
                            # the frontend link to a live view of it.
                            if name == "browser_open" and not content.startswith("error:"):
                                session_id = content.split("\n", 1)[0].removeprefix("session_id=")
                                state["browser_session_id"] = session_id
                                yield emit(
                                    "stage",
                                    _stage_data(
                                        "browser", "session_opened", "browser session opened",
                                        session_id=session_id,
                                    ),
                                )
                            yield emit("stage", _stage_data("tool_result", "message", f"← {name}: {summary}"))
                            step = pending_tool_steps.pop(getattr(m, "tool_call_id", None), None)
                            if step is not None:
                                with session_factory() as db:
                                    db.add(
                                        AgentStep(
                                            agent_run_id=state["run_id"],
                                            step_type="tool_call",
                                            input_summary={"tool": step["name"], "args": step["args"]},
                                            output_summary={"result": summary},
                                            started_at=step["started_at"],
                                            finished_at=datetime.now(timezone.utc),
                                        )
                                    )
                                    db.commit()
            # Graph finished with no further interrupt — read back the
            # real outcome (Application.state) rather than guessing it
            # from which decision was last given; `application_transition`
            # is the tool that actually moves it to "applied".
            with session_factory() as db:
                attempt = db.get(ApplicationAttempt, attempt_id)
                application = db.get(Application, state["application_id"])
                # Don't clobber a status a tool already set deliberately
                # this run (propose_email_application's "awaiting_email"
                # — there is no browser submit to have happened, so
                # "abandoned" would be actively wrong, not just imprecise).
                if attempt.status != "awaiting_email":
                    attempt.status = "submitted" if application.state == STATE_APPLIED else "abandoned"
                attempt.finished_at = datetime.now(timezone.utc)
                run = db.get(AgentRun, state["run_id"])
                if run is not None:
                    run.status = "completed"
                    run.finished_at = datetime.now(timezone.utc)
                db.commit()
            reached_terminal_state = True
            # Nothing left to do with this run's browser — closes the
            # browser-worker session (a real, previously-leaked
            # resource: no code path ever did this before) and saves
            # its final storage_state, applied_email included (no
            # browser action there either, so this is a no-op close).
            await persist_browser_session(http_client, close=True)
            yield emit("done", {"attempt_id": str(attempt_id)})
        except Exception as exc:
            error_message = _exc_message(exc)
            await persist_browser_session(http_client, close=True)
            with session_factory() as db:
                attempt = db.get(ApplicationAttempt, attempt_id)
                attempt.status = "failed"
                attempt.error = error_message
                attempt.finished_at = datetime.now(timezone.utc)
                run = db.get(AgentRun, state["run_id"])
                if run is not None:
                    run.status = "failed"
                    run.finished_at = datetime.now(timezone.utc)
                db.commit()
            reached_terminal_state = True
            yield emit("error", {"message": error_message})
        finally:
            if not reached_terminal_state:
                try:
                    with session_factory() as db:
                        attempt = db.get(ApplicationAttempt, attempt_id)
                        if attempt is not None and attempt.status == "in_progress":
                            attempt.status = "failed"
                            attempt.error = "connection lost mid-run"
                            attempt.finished_at = datetime.now(timezone.utc)
                        run = db.get(AgentRun, state["run_id"])
                        if run is not None and run.status == "running":
                            run.status = "failed"
                            run.finished_at = datetime.now(timezone.utc)
                        db.commit()
                except Exception:
                    pass
            if not keep_active_state:
                _ACTIVE_ATTEMPTS.pop(attempt_id, None)
