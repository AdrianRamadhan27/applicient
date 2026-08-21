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
from collections import defaultdict

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from applicient_api import schemas
from applicient_api.deps import current_user_id, get_db
from applicient_api.models.discovery import Job, JobSighting, Source
from applicient_api.models.profile import Persona
from applicient_api.models.scoring import FitScore, PrefilterResult

router = APIRouter(prefix="/jobs", tags=["jobs"])

_RECOMMENDATION_RANK = {"strong_apply": 0, "apply": 1, "stretch": 2, "skip": 3}
_UNSCORED_RANK = 4


def _owned_persona(db: Session, persona_id: uuid.UUID, user_id: uuid.UUID) -> Persona:
    persona = db.query(Persona).filter_by(id=persona_id, user_id=user_id).one_or_none()
    if persona is None:
        raise HTTPException(404, "persona not found")
    return persona


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
    location: str | None = None,
    min_score: float | None = None,
    max_score: float | None = None,
    limit: int = Query(default=100, le=500),
    offset: int = 0,
    db: Session = Depends(get_db),
    user_id: uuid.UUID = Depends(current_user_id),
):
    _owned_persona(db, persona_id, user_id)

    jobs_query = db.query(Job).filter(Job.user_id == user_id)
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
