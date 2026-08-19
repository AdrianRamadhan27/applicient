"""SSE stub for run streaming (§8, Run Console). Proves the streaming
mechanism against a real AgentRun row; does not yet stream live
AgentStep events as they happen, since nothing writes those from the
API layer yet — agents/ runs standalone (step 4's verification
script). Wiring a live agent run to an API-triggered SSE stream is
M1+ work, once discovery/scoring agents actually exist to trigger.
"""

import asyncio
import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from sse_starlette.sse import EventSourceResponse

from applicient_api.deps import current_user_id, get_db
from applicient_api.models.agents import AgentRun

router = APIRouter(prefix="/agent-runs", tags=["streaming"])


@router.get("/{run_id}/stream")
async def stream_run(
    run_id: uuid.UUID, db: Session = Depends(get_db), user_id: uuid.UUID = Depends(current_user_id)
):
    run = db.query(AgentRun).filter_by(id=run_id, user_id=user_id).one_or_none()
    if run is None:
        raise HTTPException(404, "agent run not found")

    async def event_generator():
        yield {"event": "connected", "data": str(run.id)}
        yield {
            "event": "status",
            "data": f'{{"status": "{run.status}", "total_cost_usd": {float(run.total_cost_usd)}}}',
        }
        # Real step-by-step streaming lands once an agent run can be
        # triggered through the API (M1+) — for now, one status event
        # and a close is the whole stub.
        await asyncio.sleep(0)
        yield {"event": "done", "data": ""}

    return EventSourceResponse(event_generator())
