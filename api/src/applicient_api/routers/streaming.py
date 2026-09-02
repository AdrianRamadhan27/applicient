"""§8 — Run Console read API: the generic per-run trace (`AgentStep`)
for any run type, independent of how that run happened to stream its
own live progress. Real radar runs now write real `AgentStep` rows
(source_run/embedding/scoring — see radar.py) and real `AgentRun` rows
for every run type (radar, cv-parse), which the M0-era SSE stub this
replaced predates and never accounted for — that stub's own docstring
said "nothing writes those from the API layer yet," which stopped
being true once radar.py and cv.py existed. Removed rather than kept
around half-accurate.
"""

import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func
from sqlalchemy.orm import Session

from applicient_api import schemas
from applicient_api.deps import current_user_id, get_db
from applicient_api.models.agents import AgentRun, AgentStep, RunEvent
from applicient_api.models.llm import LlmCall
from applicient_api.radar import _CANCEL_EVENTS

router = APIRouter(prefix="/agent-runs", tags=["streaming"])


@router.get("/{run_id}", response_model=schemas.AgentRunDetailOut)
def get_agent_run(
    run_id: uuid.UUID, db: Session = Depends(get_db), user_id: uuid.UUID = Depends(current_user_id)
):
    run = db.query(AgentRun).filter_by(id=run_id, user_id=user_id).one_or_none()
    if run is None:
        raise HTTPException(404, "agent run not found")

    steps = db.query(AgentStep).filter_by(agent_run_id=run_id).order_by(AgentStep.started_at.asc()).all()

    return schemas.AgentRunDetailOut(
        id=run.id,
        run_type=run.run_type,
        status=run.status,
        started_at=run.started_at,
        finished_at=run.finished_at,
        total_cost_usd=float(run.total_cost_usd),
        saved_search_id=run.saved_search_id,
        persona_id=run.persona_id,
        profile_revision=run.profile_revision,
        steps=[schemas.AgentStepOut.model_validate(s) for s in steps],
    )


@router.post("/{run_id}/cancel", response_model=schemas.AgentRunDetailOut)
def cancel_agent_run(run_id: uuid.UUID, db: Session = Depends(get_db), user_id: uuid.UUID = Depends(current_user_id)):
    """Cooperative — see radar.py's `_CANCEL_EVENTS` for why this can't
    just reach in and force-stop the run's task directly. Two cases:

    - The run's generator is still alive (the common case) — set its
      event; it notices at its next checkpoint (between sources or
      between scored jobs, never mid-LLM-call) and exits cleanly via
      radar.py's own `_RunCancelled` handling, which marks it
      "cancelled" itself.
    - No live generator holds this run at all — the exact situation
      hit live before this endpoint existed: the original stream
      already disconnected and nothing is left listening for the flag.
      Mark it directly instead, same real-partial-cost-preserved
      discipline as radar.py's own disconnect handling.

    Bug fix (found live): this second branch used to only update
    `AgentRun.status`, never writing a matching RunEvent — but the
    frontend's reconnect/replay path (radar/page.tsx's watchRun) learns
    a run finished/was cancelled *exclusively* by replaying a
    "run_cancelled"-type event, never by reading `status` directly. A
    run cancelled through this branch stayed shown as "Running…"
    forever (polling stops once run_status != "running", but no event
    ever flipped the frontend's own `cancelled` flag) — the user's only
    escape was deleting the saved search. Writing the same event type
    radar.py's generator itself emits on cancellation closes that gap
    at the source instead of teaching the frontend a second way to
    detect the same thing.
    """
    run = db.query(AgentRun).filter_by(id=run_id, user_id=user_id).one_or_none()
    if run is None:
        raise HTTPException(404, "agent run not found")
    if run.status != "running":
        raise HTTPException(409, f"run is already {run.status}, nothing to cancel")

    event = _CANCEL_EVENTS.get(run_id)
    if event is not None:
        event.set()
    else:
        run.status = "cancelled"
        run.finished_at = datetime.now(timezone.utc)
        run.total_cost_usd = sum(float(c.cost_usd) for c in db.query(LlmCall).filter_by(agent_run_id=run.id).all())
        next_seq = (db.query(func.max(RunEvent.seq)).filter_by(agent_run_id=run.id).scalar() or 0) + 1
        db.add(
            RunEvent(
                user_id=user_id, agent_run_id=run.id, seq=next_seq,
                event_type="run_cancelled", data={"agent_run_id": str(run.id)},
            )
        )
        db.commit()
        db.refresh(run)

    steps = db.query(AgentStep).filter_by(agent_run_id=run_id).order_by(AgentStep.started_at.asc()).all()
    return schemas.AgentRunDetailOut(
        id=run.id,
        run_type=run.run_type,
        status=run.status,
        started_at=run.started_at,
        finished_at=run.finished_at,
        total_cost_usd=float(run.total_cost_usd),
        saved_search_id=run.saved_search_id,
        persona_id=run.persona_id,
        profile_revision=run.profile_revision,
        steps=[schemas.AgentStepOut.model_validate(s) for s in steps],
    )
