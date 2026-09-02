"""M1 §6 — the real Job Inbox read API: ranked jobs with the latest fit
score per persona, filterable, with a score-breakdown drawer endpoint
carrying the full audit trail (every dimension, evidence spans, gap
closers, red flags, source lineage). Replaces the `GET
/saved-searches/{id}/jobs` stand-in from §3/§8, which was scoped to one
saved search's sources and carried no score at all — a real Job Inbox
is cross-saved-search (a persona's whole discovered-and-scored backlog)
and is meaningless without the score that's the entire point of §5.

Scores are persona-scoped (FitScore.persona_id) and append-only, so
`persona_id` is a required query param on both routes here rather than
an inferred "active persona" — unlike ModelProfile.is_active, Persona.active
isn't guaranteed unique, so there's no single correct default to guess.

Ranking and filtering are done in Python over an already-scoped query,
not a hand-rolled SQL CASE — same pragmatic style as cost.py's summary:
this is a personal-scale tool, not a high-volume system, and a plain
Python sort is far easier to read and change than SQL that encodes
"strong_apply beats apply beats stretch beats skip beats unscored."
"""

import uuid
from asyncio import to_thread
from collections import defaultdict
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import or_
from sqlalchemy.orm import Session

from applicient_api import schemas
from applicient_api.deps import current_user_id, get_db, get_session_factory
from applicient_api.job_url_parsing import JobUrlParseError, open_snapshot_and_close, parse_job_snapshot
from applicient_api.models.agents import AgentRun
from applicient_api.models.discovery import Job, JobSighting, Source
from applicient_api.models.enums import SourceTier
from applicient_api.models.profile import Persona
from applicient_api.models.scoring import FitScore, PrefilterResult
from applicient_api.normalization import normalize_and_upsert
from applicient_api.scoring_service import score_job
from applicient_api.tier_resolution import TierResolutionError, resolve_tier
from applicient_sources.base import RawPosting

router = APIRouter(prefix="/jobs", tags=["jobs"])

_RECOMMENDATION_RANK = {"strong_apply": 0, "apply": 1, "stretch": 2, "skip": 3}
_UNSCORED_RANK = 4


def _owned_persona(db: Session, persona_id: uuid.UUID, user_id: uuid.UUID) -> Persona:
    persona = db.query(Persona).filter_by(id=persona_id, user_id=user_id).one_or_none()
    if persona is None:
        raise HTTPException(404, "persona not found")
    return persona


def _find_or_create_manual_source(db: Session, user_id: uuid.UUID) -> Source:
    """One shared Source per user for every hand-typed/URL-pasted job —
    same find-or-create-by-name shape as company_candidates.py's own
    `_find_or_create_scan_source`, minus the `get_adapter()` lookup
    (there's no real SourceAdapter registered for "manual"; nothing on
    this create-job path calls get_adapter, only
    `_SOURCE_PREFERENCE.get(adapter_key, 0)` in normalization.py, which
    defaults an unknown key to the lowest rank — correct here, since a
    manually-entered job should never override a sighting from a real
    ATS/aggregator source)."""

    source = db.query(Source).filter_by(user_id=user_id, adapter_key="manual").one_or_none()
    if source is None:
        source = Source(
            user_id=user_id, name="Manually added", tier=SourceTier.TIER2_PORTAL.value,
            adapter_key="manual", config={}, status="ok",
        )
        db.add(source)
        db.flush()
    return source


def _inbox_job_out(
    db: Session, user_id: uuid.UUID, job: Job, persona_id: uuid.UUID | None = None
) -> schemas.InboxJobOut:
    """`persona_id=None` for a job with no meaningful score context yet
    (right after manual creation, before it's ever been scored for
    anyone) — fit_score/prefilter both come back None rather than
    querying with a persona that doesn't apply."""

    fit_score = prefilter = None
    if persona_id is not None:
        fit_score = (
            db.query(FitScore)
            .filter_by(job_id=job.id, persona_id=persona_id)
            .order_by(FitScore.created_at.desc())
            .first()
        )
        prefilter = (
            db.query(PrefilterResult)
            .filter_by(job_id=job.id, persona_id=persona_id)
            .order_by(PrefilterResult.created_at.desc())
            .first()
        )
    source_names = _source_names_by_job_id(db, user_id, [job.id]).get(job.id, [])
    return schemas.InboxJobOut(
        id=job.id,
        title=job.title,
        company_name_raw=job.company_name_raw,
        location=job.location,
        remote_policy=job.remote_policy,
        employment_type=job.employment_type,
        seniority=job.seniority,
        salary_min=job.salary_min,
        salary_max=job.salary_max,
        salary_currency=job.salary_currency,
        apply_url=job.apply_url,
        posted_at=job.posted_at,
        discovered_at=job.created_at,
        ghost_job_score=job.ghost_job_score,
        ghost_job_reasons=job.ghost_job_reasons,
        repost_count=job.repost_count,
        fit_score=schemas.FitScoreOut.model_validate(fit_score) if fit_score else None,
        prefilter=schemas.PrefilterResultOut.model_validate(prefilter) if prefilter else None,
        source_names=source_names,
    )


def _latest_by_job_id(rows: list) -> dict[uuid.UUID, object]:
    """Rows must already be ordered newest-first (created_at desc) —
    keeps the first row seen per job_id, i.e. the latest one, without
    a second query or a SQL window function. Shared by FitScore and
    PrefilterResult since both are append-only history tables with the
    exact same "read the latest per job" access pattern."""

    latest: dict[uuid.UUID, object] = {}
    for row in rows:
        latest.setdefault(row.job_id, row)
    return latest


def _source_names_by_job_id(db: Session, user_id: uuid.UUID, job_ids: list[uuid.UUID]) -> dict[uuid.UUID, list[str]]:
    if not job_ids:
        return {}
    rows = (
        db.query(JobSighting.job_id, Source.name)
        .join(Source, Source.id == JobSighting.source_id)
        .filter(JobSighting.job_id.in_(job_ids), Source.user_id == user_id)
        .all()
    )
    by_job: dict[uuid.UUID, list[str]] = defaultdict(list)
    for job_id, source_name in rows:
        if source_name not in by_job[job_id]:
            by_job[job_id].append(source_name)
    return dict(by_job)


@router.get("", response_model=list[schemas.InboxJobOut])
def list_inbox_jobs(
    persona_id: uuid.UUID,
    recommendation: list[str] | None = Query(default=None, description="strong_apply/apply/stretch/skip/unscored, repeatable"),
    source_id: uuid.UUID | None = None,
    search: str | None = Query(default=None, description="case-insensitive match against job title or company name"),
    location: str | None = None,
    min_score: float | None = None,
    max_score: float | None = None,
    sort: str = Query(
        default="recommended",
        description="recommended (default) / newest_posted / newest_scanned / oldest_scanned",
    ),
    limit: int = Query(default=100, le=500),
    offset: int = 0,
    db: Session = Depends(get_db),
    user_id: uuid.UUID = Depends(current_user_id),
):
    _owned_persona(db, persona_id, user_id)

    jobs_query = db.query(Job).filter(Job.user_id == user_id)
    search_term = search.strip() if search else ""
    if search_term:
        pattern = f"%{search_term}%"
        jobs_query = jobs_query.filter(or_(Job.title.ilike(pattern), Job.company_name_raw.ilike(pattern)))
    if location:
        jobs_query = jobs_query.filter(Job.location.ilike(f"%{location}%"))
    if source_id is not None:
        matching_job_ids = db.query(JobSighting.job_id).filter(JobSighting.source_id == source_id).subquery()
        jobs_query = jobs_query.filter(Job.id.in_(db.query(matching_job_ids)))
    jobs = jobs_query.all()
    job_ids = [j.id for j in jobs]

    fit_scores = _latest_by_job_id(
        db.query(FitScore)
        .filter(FitScore.persona_id == persona_id, FitScore.job_id.in_(job_ids))
        .order_by(FitScore.created_at.desc())
        .all()
    )
    prefilters = _latest_by_job_id(
        db.query(PrefilterResult)
        .filter(PrefilterResult.persona_id == persona_id, PrefilterResult.job_id.in_(job_ids))
        .order_by(PrefilterResult.created_at.desc())
        .all()
    )
    source_names = _source_names_by_job_id(db, user_id, job_ids)

    recommendation_filter = set(recommendation) if recommendation else None

    def matches_filters(job: Job) -> bool:
        fs = fit_scores.get(job.id)
        if recommendation_filter is not None:
            rec = fs.recommendation if fs else "unscored"
            if rec not in recommendation_filter:
                return False
        # A score-band filter only makes sense against an actual
        # score — an unscored job has nothing to compare, so it's
        # excluded rather than treated as a false 0.
        if min_score is not None and (fs is None or float(fs.overall_score) < min_score):
            return False
        if max_score is not None and (fs is None or float(fs.overall_score) > max_score):
            return False
        return True

    def rank_key(job: Job):
        fs = fit_scores.get(job.id)
        if fs is None:
            return (_UNSCORED_RANK, 0.0, job.posted_at or job.created_at)
        rec_rank = _RECOMMENDATION_RANK.get(fs.recommendation, _UNSCORED_RANK)
        return (rec_rank, -float(fs.overall_score), -(job.posted_at or job.created_at).timestamp())

    filtered = [j for j in jobs if matches_filters(j)]
    if sort == "newest_posted":
        # Falls back to created_at per job for the common F3.1a case of
        # a null posted_at (never estimated) — same fallback rank_key
        # below already relies on for its own tie-break.
        filtered.sort(key=lambda j: j.posted_at or j.created_at, reverse=True)
    elif sort == "newest_scanned":
        filtered.sort(key=lambda j: j.created_at, reverse=True)
    elif sort == "oldest_scanned":
        filtered.sort(key=lambda j: j.created_at)
    else:
        filtered.sort(key=rank_key)
    page = filtered[offset : offset + limit]

    return [
        schemas.InboxJobOut(
            id=job.id,
            title=job.title,
            company_name_raw=job.company_name_raw,
            location=job.location,
            remote_policy=job.remote_policy,
            employment_type=job.employment_type,
            seniority=job.seniority,
            salary_min=job.salary_min,
            salary_max=job.salary_max,
            salary_currency=job.salary_currency,
            apply_url=job.apply_url,
            posted_at=job.posted_at,
            discovered_at=job.created_at,
            ghost_job_score=job.ghost_job_score,
            ghost_job_reasons=job.ghost_job_reasons,
            repost_count=job.repost_count,
            fit_score=schemas.FitScoreOut.model_validate(fit_scores[job.id]) if job.id in fit_scores else None,
            prefilter=schemas.PrefilterResultOut.model_validate(prefilters[job.id]) if job.id in prefilters else None,
            source_names=source_names.get(job.id, []),
        )
        for job in page
    ]


@router.get("/{job_id}", response_model=schemas.InboxJobDetailOut)
def get_inbox_job(
    job_id: uuid.UUID,
    persona_id: uuid.UUID,
    db: Session = Depends(get_db),
    user_id: uuid.UUID = Depends(current_user_id),
):
    _owned_persona(db, persona_id, user_id)
    job = db.query(Job).filter_by(id=job_id, user_id=user_id).one_or_none()
    if job is None:
        raise HTTPException(404, "job not found")

    fit_score = (
        db.query(FitScore)
        .filter_by(job_id=job_id, persona_id=persona_id)
        .order_by(FitScore.created_at.desc())
        .first()
    )
    prefilter = (
        db.query(PrefilterResult)
        .filter_by(job_id=job_id, persona_id=persona_id)
        .order_by(PrefilterResult.created_at.desc())
        .first()
    )
    sighting_rows = (
        db.query(JobSighting, Source)
        .join(Source, Source.id == JobSighting.source_id)
        .filter(JobSighting.job_id == job_id, Source.user_id == user_id)
        .order_by(JobSighting.first_seen_at.asc())
        .all()
    )
    sightings = [
        schemas.JobSightingOut(
            id=sighting.id,
            source_id=source.id,
            source_name=source.name,
            adapter_key=source.adapter_key,
            source_url=sighting.source_url,
            external_requisition_id=sighting.external_requisition_id,
            first_seen_at=sighting.first_seen_at,
            last_seen_at=sighting.last_seen_at,
            posted_at_on_source=sighting.posted_at_on_source,
        )
        for sighting, source in sighting_rows
    ]
    source_names: list[str] = []
    for s in sightings:
        if s.source_name not in source_names:
            source_names.append(s.source_name)

    return schemas.InboxJobDetailOut(
        id=job.id,
        title=job.title,
        company_name_raw=job.company_name_raw,
        location=job.location,
        remote_policy=job.remote_policy,
        employment_type=job.employment_type,
        seniority=job.seniority,
        salary_min=job.salary_min,
        salary_max=job.salary_max,
        salary_currency=job.salary_currency,
        apply_url=job.apply_url,
        posted_at=job.posted_at,
        discovered_at=job.created_at,
        ghost_job_score=job.ghost_job_score,
        ghost_job_reasons=job.ghost_job_reasons,
        repost_count=job.repost_count,
        fit_score=schemas.FitScoreOut.model_validate(fit_score) if fit_score else None,
        prefilter=schemas.PrefilterResultOut.model_validate(prefilter) if prefilter else None,
        source_names=source_names,
        requirements=job.requirements,
        responsibilities=job.responsibilities,
        benefits=job.benefits,
        sightings=sightings,
    )


@router.post("/bulk-delete", response_model=schemas.BulkDeleteJobsOut)
def bulk_delete_jobs(
    body: schemas.BulkDeleteJobsIn,
    db: Session = Depends(get_db),
    user_id: uuid.UUID = Depends(current_user_id),
):
    """Inbox multi-select delete, raised directly by Adrian with bulk
    apply already in mind for later — the frontend's selection
    mechanism is generic (a plain set of job ids), this is just the
    first bulk action built on top of it. `JobSighting`/`FitScore`/
    `PrefilterResult` all cascade-delete with the job (real FKs, not
    orphaned rows); `LlmCall.job_id` sets to NULL instead, so a job's
    real cost history in Cost & Usage survives deleting the job
    itself — deleting a job from your Inbox isn't the same claim as
    "this cost never happened."
    """

    if not body.job_ids:
        return schemas.BulkDeleteJobsOut(deleted=0)
    deleted = (
        db.query(Job)
        .filter(Job.user_id == user_id, Job.id.in_(body.job_ids))
        .delete(synchronize_session=False)
    )
    db.commit()
    return schemas.BulkDeleteJobsOut(deleted=deleted)


@router.post("/parse-url", response_model=schemas.ParsedJobOut)
async def parse_job_url(
    body: schemas.ParseJobUrlIn,
    db: Session = Depends(get_db),
    user_id: uuid.UUID = Depends(current_user_id),
):
    """Preview only — never saves anything. The frontend prefills the
    manual "Add job" form with whatever this returns so the human
    reviews/edits before POST /jobs actually creates a Job. Opens the
    real page in a browser (job boards are JS-heavy/anti-bot-gated —
    same reasoning as sources/generic_scraper.py, see job_url_parsing.py's
    own docstring) and asks an LLM to extract it; a real AgentRun is
    created either way so the LLM cost shows up in Cost & Usage, same
    convention as every other tier-resolved call in this codebase."""

    run = AgentRun(user_id=user_id, run_type="job-url-parse", status="running", started_at=datetime.now(timezone.utc))
    db.add(run)
    db.commit()

    def _fail() -> None:
        run.status = "failed"
        run.finished_at = datetime.now(timezone.utc)
        db.commit()

    snapshot = await open_snapshot_and_close(body.url)
    if snapshot is None:
        _fail()
        raise HTTPException(502, "couldn't open that URL — it may be unreachable or blocking automated access")

    try:
        model = await to_thread(
            resolve_tier, db, user_id=user_id, tier="fast", stage="job-url-parse",
            agent_run_id=run.id, session_factory=get_session_factory(),
        )
        extracted = await to_thread(parse_job_snapshot, model, body.url, snapshot)
    except TierResolutionError as exc:
        _fail()
        raise HTTPException(409, f"model routing not configured: {exc}") from exc
    except JobUrlParseError as exc:
        _fail()
        raise HTTPException(502, f"couldn't parse that page: {exc}") from exc

    run.status = "completed"
    run.finished_at = datetime.now(timezone.utc)
    db.commit()

    return schemas.ParsedJobOut(**extracted.model_dump())


@router.post("", response_model=schemas.InboxJobOut)
def create_job_manual(
    body: schemas.JobCreateIn,
    db: Session = Depends(get_db),
    user_id: uuid.UUID = Depends(current_user_id),
):
    """Whether the human typed every field by hand or reviewed/edited a
    parse_job_url preview first, both end up here — one path in, so
    dedup/lineage stays identical either way. Deliberately does NOT
    score the job (score_job needs a persona to score against, and
    this endpoint has none) — call POST /jobs/{id}/score once it's
    visible in the Inbox, same as the "Score this job" button does."""

    source = _find_or_create_manual_source(db, user_id)
    posting = RawPosting(
        source_url=body.source_url or f"manual://{uuid.uuid4()}",
        title=body.title,
        company_name=body.company_name,
        location=body.location,
        remote_policy=body.remote_policy,
        seniority=body.seniority,
        employment_type=body.employment_type,
        salary_min=body.salary_min,
        salary_max=body.salary_max,
        salary_currency=body.salary_currency,
        requirements=body.requirements,
        responsibilities=body.responsibilities,
        benefits=body.benefits,
        apply_url=body.apply_url or body.source_url,
    )
    job, _is_new = normalize_and_upsert(
        db, user_id=user_id, source=source, posting=posting, now=datetime.now(timezone.utc)
    )
    db.commit()
    return _inbox_job_out(db, user_id, job)


@router.post("/{job_id}/score", response_model=schemas.InboxJobOut)
async def score_job_on_demand(
    job_id: uuid.UUID,
    body: schemas.ScoreJobIn,
    db: Session = Depends(get_db),
    user_id: uuid.UUID = Depends(current_user_id),
):
    """On-demand scoring for a job that hasn't gone through Radar's own
    automated scoring pass — a manually-added job, most often. Same
    score_job() call radar.py's own scoring step makes, wrapped in
    to_thread for the same reason every other blocking LangChain call
    in this codebase is (score_job opens its own session and makes
    real, synchronous LLM calls)."""

    job = db.query(Job).filter_by(id=job_id, user_id=user_id).one_or_none()
    if job is None:
        raise HTTPException(404, "job not found")
    persona = _owned_persona(db, body.persona_id, user_id)

    run = AgentRun(user_id=user_id, run_type="manual-score", status="running", started_at=datetime.now(timezone.utc))
    db.add(run)
    db.commit()

    try:
        await to_thread(
            score_job, get_session_factory(), job_id=job.id, persona_id=persona.id,
            profile_id=persona.profile_id, user_id=user_id, agent_run_id=run.id,
        )
    except TierResolutionError as exc:
        run.status = "failed"
        run.finished_at = datetime.now(timezone.utc)
        db.commit()
        raise HTTPException(409, f"model routing not configured: {exc}") from exc

    run.status = "completed"
    run.finished_at = datetime.now(timezone.utc)
    db.commit()

    db.refresh(job)
    return _inbox_job_out(db, user_id, job, persona_id=persona.id)
