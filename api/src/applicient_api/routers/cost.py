"""F13.11 — a minimal Cost & Usage view. The full dashboard (per-model
breakdowns, cache-hit rate, budget status) is real future work; this
is deliberately just enough to make step 7's exit bar honest: cost of
a real flow, visible."""

import uuid

from fastapi import APIRouter, Depends
from sqlalchemy import func
from sqlalchemy.orm import Session

from applicient_api import schemas
from applicient_api.deps import current_user_id, get_db
from applicient_api.models.llm import LlmCall

router = APIRouter(prefix="/cost", tags=["cost"])


@router.get("/summary", response_model=schemas.CostSummary)
def cost_summary(db: Session = Depends(get_db), user_id: uuid.UUID = Depends(current_user_id)):
    calls = db.query(LlmCall).filter_by(user_id=user_id).order_by(LlmCall.created_at.desc()).all()

    by_stage: dict[str, float] = {}
    for c in calls:
        key = c.stage or "unstaged"
        by_stage[key] = by_stage.get(key, 0.0) + float(c.cost_usd)

    return schemas.CostSummary(
        total_cost_usd=sum(float(c.cost_usd) for c in calls),
        total_calls=len(calls),
        unknown_cost_calls=sum(1 for c in calls if not c.cost_known),
        by_stage=by_stage,
        recent_calls=calls[:50],
    )
