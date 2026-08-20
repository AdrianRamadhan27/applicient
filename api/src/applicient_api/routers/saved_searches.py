"""F2.7/M1 §3 — SavedSearch CRUD. The run trigger itself lives in
routers/radar.py (SSE, mirrors cv.py's parse-stream shape) since it's
a materially different kind of endpoint, not a plain REST verb."""

import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from applicient_api import schemas
from applicient_api.deps import current_user_id, get_db
from applicient_api.models.agents import AgentRun, RunEvent
from applicient_api.models.discovery import Job, JobSighting, SavedSearch, Source, SourceRun
from applicient_api.models.profile import Persona

router = APIRouter(prefix="/saved-searches", tags=["saved-searches"])


def _validate_refs(db: Session, user_id: uuid.UUID, persona_id: uuid.UUID, source_ids: list[uuid.UUID]) -> None:
    if db.query(Persona).filter_by(id=persona_id, user_id=user_id).one_or_none() is None:
        raise HTTPException(422, f"persona {persona_id} not found")
    found = {
        s.id
        for s in db.query(Source.id).filter(Source.user_id == user_id, Source.id.in_(source_ids)).all()
    }
    missing = set(source_ids) - found
    if missing:
        raise HTTPException(422, f"source(s) not found: {sorted(str(m) for m in missing)}")


@router.get("", response_model=list[schemas.SavedSearchOut])
def list_saved_searches(db: Session = Depends(get_db), user_id: uuid.UUID = Depends(current_user_id)):
    return db.query(SavedSearch).filter_by(user_id=user_id).all()


@router.post("", response_model=schemas.SavedSearchOut, status_code=201)
def create_saved_search(
    body: schemas.SavedSearchCreate, db: Session = Depends(get_db), user_id: uuid.UUID = Depends(current_user_id)
):
    if not body.role_titles:
        raise HTTPException(422, "at least one role title is required")
    if not body.source_ids:
        raise HTTPException(422, "at least one source is required")
    _validate_refs(db, user_id, body.persona_id, body.source_ids)

    saved_search = SavedSearch(
        user_id=user_id,
        persona_id=body.persona_id,
        name=body.name,
        role_titles=body.role_titles,
        source_ids=body.source_ids,
        filters=body.filters,
    )
    db.add(saved_search)
    db.commit()
    db.refresh(saved_search)
    return saved_search


def _owned_saved_search(db: Session, saved_search_id: uuid.UUID, user_id: uuid.UUID) -> SavedSearch:
    saved_search = db.query(SavedSearch).filter_by(id=saved_search_id, user_id=user_id).one_or_none()
    if saved_search is None:
        raise HTTPException(404, "saved search not found")
    return saved_search


@router.patch("/{saved_search_id}", response_model=schemas.SavedSearchOut)
def update_saved_search(
    saved_search_id: uuid.UUID,
    body: schemas.SavedSearchUpdate,
    db: Session = Depends(get_db),
    user_id: uuid.UUID = Depends(current_user_id),
):
    saved_search = _owned_saved_search(db, saved_search_id, user_id)
    updates = body.model_dump(exclude_unset=True)
    if "source_ids" in updates:
        _validate_refs(db, user_id, saved_search.persona_id, updates["source_ids"])
    for field, value in updates.items():
        setattr(saved_search, field, value)
    db.commit()
    db.refresh(saved_search)
    return saved_search


@router.delete("/{saved_search_id}", status_code=204)
def delete_saved_search(
    saved_search_id: uuid.UUID, db: Session = Depends(get_db), user_id: uuid.UUID = Depends(current_user_id)
):
    saved_search = _owned_saved_search(db, saved_search_id, user_id)
    db.delete(saved_search)
    db.commit()


@router.get("/{saved_search_id}/runs", response_model=list[schemas.AgentRunOut])
def list_saved_search_runs(
    saved_search_id: uuid.UUID,
    limit: int = 5,
    db: Session = Depends(get_db),
    user_id: uuid.UUID = Depends(current_user_id),
):
    """M1 §3 follow-up — the run's real state (AgentRun/SourceRun) was
    already being persisted; this is just the first way to read it
    back, so the Radar screen can show a saved search's last run
    after a page reload instead of only ever showing live SSE state
    that vanishes on navigation."""

    _owned_saved_search(db, saved_search_id, user_id)
    runs = (
        db.query(AgentRun)
        .filter_by(user_id=user_id, saved_search_id=saved_search_id, run_type="radar")
        .order_by(AgentRun.started_at.desc())
        .limit(limit)
        .all()
    )
    run_ids = [r.id for r in runs]
    source_runs_by_run: dict[uuid.UUID, list] = {rid: [] for rid in run_ids}
    if run_ids:
        for sr in db.query(SourceRun).filter(SourceRun.agent_run_id.in_(run_ids)).all():
            source_runs_by_run[sr.agent_run_id].append(sr)

    return [
        schemas.AgentRunOut(
            id=run.id,
            status=run.status,
            started_at=run.started_at,
            finished_at=run.finished_at,
            total_cost_usd=float(run.total_cost_usd),
            source_runs=[schemas.SourceRunOut.model_validate(sr) for sr in source_runs_by_run[run.id]],
        )
        for run in runs
    ]


@router.get("/{saved_search_id}/runs/{agent_run_id}/events", response_model=schemas.RunEventsOut)
def list_run_events(
    saved_search_id: uuid.UUID,
    agent_run_id: uuid.UUID,
    since_seq: int = 0,
    db: Session = Depends(get_db),
    user_id: uuid.UUID = Depends(current_user_id),
):
    """Replay/reconnect endpoint, raised directly by Adrian after
    finding that navigating away from an in-progress run and back
    showed only `status: "running"` — the live log lines and per-job
    score events were real, but only ever existed on the one SSE
    connection open at the time, never written anywhere. Every event
    `radar.py`'s `_emit` yields is now also a durable `RunEvent` row,
    so a client that (re)connects can ask for everything after the
    last `seq` it saw and get a gap-free replay; polling this on an
    interval while `run_status == "running"` is what approximates a
    live reconnect, since there's no separate live-push channel wired
    into this codebase (Postgres is already the source of truth for
    the run itself)."""

    _owned_saved_search(db, saved_search_id, user_id)
    run = db.get(AgentRun, agent_run_id)
    if run is None or run.user_id != user_id or run.saved_search_id != saved_search_id:
        raise HTTPException(status_code=404, detail="run not found")

    events = (
        db.query(RunEvent)
        .filter(RunEvent.agent_run_id == agent_run_id, RunEvent.seq > since_seq)
        .order_by(RunEvent.seq)
        .all()
    )
    return schemas.RunEventsOut(
        run_status=run.status,
        events=[schemas.RunEventOut.model_validate(e) for e in events],
    )


@router.get("/{saved_search_id}/jobs", response_model=list[schemas.JobSummaryOut])
def list_saved_search_jobs(
    saved_search_id: uuid.UUID,
    limit: int = 50,
    db: Session = Depends(get_db),
    user_id: uuid.UUID = Depends(current_user_id),
):
    """M1 §3 follow-up, standing in for the real Job Inbox (§6, not
    built yet) — jobs discovered through this saved search's sources,
    most recently seen first. Not scoped to one specific run (Job has
    no run-level lineage, only source lineage via JobSighting), so
    this reflects the source configuration's cumulative results, not
    literally "what the last run found" — stated plainly rather than
    implied to be more precise than it is."""

    saved_search = _owned_saved_search(db, saved_search_id, user_id)
    job_ids = (
        db.query(JobSighting.job_id)
        .filter(JobSighting.source_id.in_(saved_search.source_ids))
        .distinct()
        .subquery()
    )
    jobs = (
        db.query(Job)
        .filter(Job.user_id == user_id, Job.id.in_(db.query(job_ids)))
        .order_by(Job.updated_at.desc())
        .limit(limit)
        .all()
    )
    return jobs
