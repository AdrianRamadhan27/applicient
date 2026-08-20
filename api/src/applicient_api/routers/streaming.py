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

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from applicient_api import schemas
from applicient_api.deps import current_user_id, get_db
from applicient_api.models.agents import AgentRun, AgentStep

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
