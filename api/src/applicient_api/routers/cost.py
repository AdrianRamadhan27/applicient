"""M1 §7 — Cost & Usage v1. Extends the F13.11 minimal view (total
spend, by_stage, recent calls) with time-range/run/source/stage/tier/
provider/model filtering, by_tier/by_provider/by_model/by_source
breakdowns, a cross-run-type run-history list, and a cost-per-scored-job
figure. `pricing_version`/`fallback_from_model` were already being
stamped on every `LlmCall` row at write time (F12.7/F13.3) — this is
the first place they're actually surfaced through the API.

Aggregation happens in Python over an already-filtered query, not a
hand-rolled SQL GROUP BY per breakdown — same pragmatic style as the
original minimal endpoint: this is a personal-scale ledger, and a plain
Python loop is far easier to read and extend than five separate SQL
aggregate queries would be.
"""

import uuid
from datetime import datetime

from fastapi import APIRouter, Depends
from sqlalchemy import func
from sqlalchemy.orm import Session

from applicient_api import schemas
from applicient_api.deps import current_user_id, get_db
from applicient_api.models.agents import AgentRun
from applicient_api.models.discovery import Source, SourceRun
from applicient_api.models.llm import LlmCall

router = APIRouter(prefix="/cost", tags=["cost"])


@router.get("/summary", response_model=schemas.CostSummary)
def cost_summary(
    since: datetime | None = None,
    until: datetime | None = None,
    run_id: uuid.UUID | None = None,
    source_id: uuid.UUID | None = None,
    stage: str | None = None,
    tier: str | None = None,
    provider: str | None = None,
    model_id: str | None = None,
    db: Session = Depends(get_db),
    user_id: uuid.UUID = Depends(current_user_id),
):
    q = db.query(LlmCall).filter(LlmCall.user_id == user_id)
    if since is not None:
        q = q.filter(LlmCall.created_at >= since)
    if until is not None:
        q = q.filter(LlmCall.created_at <= until)
    if run_id is not None:
        q = q.filter(LlmCall.agent_run_id == run_id)
    if stage is not None:
        q = q.filter(LlmCall.stage == stage)
    if tier is not None:
        q = q.filter(LlmCall.tier == tier)
    if provider is not None:
        q = q.filter(LlmCall.provider == provider)
    if model_id is not None:
        q = q.filter(LlmCall.model_id == model_id)
    if source_id is not None:
        matching_source_runs = db.query(SourceRun.id).filter(SourceRun.source_id == source_id).subquery()
        q = q.filter(LlmCall.source_run_id.in_(db.query(matching_source_runs)))
    calls = q.order_by(LlmCall.created_at.desc()).all()

    # Source names are resolved once for every source_run_id actually
    # present in this result set, not per-call — a call only ever
    # carries source_run_id, never the source's name directly.
    source_run_ids = {c.source_run_id for c in calls if c.source_run_id is not None}
    source_name_by_run_id: dict[uuid.UUID, str] = {}
    if source_run_ids:
        source_runs = db.query(SourceRun).filter(SourceRun.id.in_(source_run_ids)).all()
        source_ids = {sr.source_id for sr in source_runs}
        sources = db.query(Source).filter(Source.id.in_(source_ids)).all()
        name_by_source_id = {s.id: s.name for s in sources}
        source_name_by_run_id = {sr.id: name_by_source_id.get(sr.source_id, "unknown source") for sr in source_runs}

    by_stage: dict[str, float] = {}
    by_tier: dict[str, float] = {}
    by_provider: dict[str, float] = {}
    by_model: dict[str, float] = {}
    by_source: dict[str, float] = {}
    job_costs: dict[uuid.UUID, float] = {}
    total_input_tokens = 0
    total_output_tokens = 0

    for c in calls:
        cost = float(c.cost_usd)
        by_stage[c.stage or "unstaged"] = by_stage.get(c.stage or "unstaged", 0.0) + cost
        by_tier[c.tier or "untiered"] = by_tier.get(c.tier or "untiered", 0.0) + cost
        by_provider[c.provider] = by_provider.get(c.provider, 0.0) + cost
        by_model[c.model_id] = by_model.get(c.model_id, 0.0) + cost
        total_input_tokens += c.input_tokens
        total_output_tokens += c.output_tokens
        if c.source_run_id is not None:
            name = source_name_by_run_id.get(c.source_run_id, "unknown source")
            by_source[name] = by_source.get(name, 0.0) + cost
        if c.job_id is not None:
            job_costs[c.job_id] = job_costs.get(c.job_id, 0.0) + cost

    return schemas.CostSummary(
        total_cost_usd=sum(float(c.cost_usd) for c in calls),
        total_calls=len(calls),
        unknown_cost_calls=sum(1 for c in calls if not c.cost_known),
        total_input_tokens=total_input_tokens,
        total_output_tokens=total_output_tokens,
        by_stage=by_stage,
        by_tier=by_tier,
        by_provider=by_provider,
        by_model=by_model,
        by_source=by_source,
        cost_per_scored_job=(sum(job_costs.values()) / len(job_costs)) if job_costs else None,
        recent_calls=calls[:50],
    )


@router.get("/runs", response_model=list[schemas.CostRunOut])
def list_cost_runs(
    limit: int = 50,
    run_type: str | None = None,
    db: Session = Depends(get_db),
    user_id: uuid.UUID = Depends(current_user_id),
):
    q = db.query(AgentRun).filter(AgentRun.user_id == user_id)
    if run_type is not None:
        q = q.filter(AgentRun.run_type == run_type)
    runs = q.order_by(AgentRun.started_at.desc()).limit(limit).all()

    run_ids = [r.id for r in runs]
    call_counts: dict[uuid.UUID, int] = {}
    if run_ids:
        for agent_run_id, count in (
            db.query(LlmCall.agent_run_id, func.count(LlmCall.id))
            .filter(LlmCall.agent_run_id.in_(run_ids))
            .group_by(LlmCall.agent_run_id)
            .all()
        ):
            call_counts[agent_run_id] = count

    return [
        schemas.CostRunOut(
            id=r.id,
            run_type=r.run_type,
            status=r.status,
            started_at=r.started_at,
            finished_at=r.finished_at,
            total_cost_usd=float(r.total_cost_usd),
            call_count=call_counts.get(r.id, 0),
            saved_search_id=r.saved_search_id,
        )
        for r in runs
    ]
