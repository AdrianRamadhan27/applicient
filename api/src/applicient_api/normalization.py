"""M1 §4 — normalize a RawPosting into the canonical Job/JobSighting/
Company shape and dedup it.

Scope, stated plainly: this implements dedup signals 1 and 2 from the
required order (M1 §4) — (1) exact `(source_id, external_requisition_id)`
match, enforced by JobSighting's real DB unique constraint, not just
application logic, and (2) a normalized company+title+location
`canonical_key` lookup. Signal 3 (embedding cosine similarity over the
job body) is NOT implemented yet — deferred, tracked in
M1_IMPLEMENTATION.md, not silently skipped. In practice this only
under-dedups postings that differ in requisition ID/canonical key but
are semantically the same job; both adapters wired up so far
(Greenhouse, JSearch) always supply a requisition ID, so signal 1
already makes reruns idempotent for the sources that exist today.

Salary is pure pass-through: RawPosting only ever carries a value when
the source adapter itself found one (checked in each adapter's own
docstring — nothing invents a market estimate), so there is nothing
for this layer to compute; it just never overwrites a known Job value
with an absent one, same discipline as every other field below.

Ghost/staleness signals (`_compute_ghost_signals`): a stated v1
heuristic over `repost_count` (incremented when a sighting's
posted_at is bumped later without a new requisition ID — a concrete,
data-backed "posted-date reset") and first-seen age (`Job.created_at`,
accurate since the row is created exactly when first discovered).
Boilerplate-text detection is NOT included — no objective signal
available here without risking false positives on genuinely
well-written listings, so it's left out rather than guessed at.
"""

from __future__ import annotations

import re
import unicodedata
import uuid
from datetime import datetime

from sqlalchemy import func
from sqlalchemy.orm import Session

from applicient_api.models.discovery import Company, Job, JobSighting, Source
from applicient_sources import RawPosting

_WS_RE = re.compile(r"\s+")

# F3.4 — ATS over aggregator when both exist. Only two adapters exist
# right now; a source not listed here (a future one) defaults to 0 and
# never displaces an already-preferred sighting purely by being newer.
_SOURCE_PREFERENCE = {"greenhouse": 1, "jsearch": 0}


def _normalize_for_key(value: str) -> str:
    value = unicodedata.normalize("NFKC", value).casefold().strip()
    return _WS_RE.sub(" ", value)


def canonical_key(company_name: str, title: str, location: str | None) -> str:
    parts = (
        _normalize_for_key(company_name),
        _normalize_for_key(title),
        _normalize_for_key(location or ""),
    )
    return "|".join(parts)


def _get_or_create_company(session: Session, name: str) -> Company:
    normalized = name.strip().lower()
    existing = session.query(Company).filter(func.lower(Company.name) == normalized).first()
    if existing is not None:
        return existing
    company = Company(name=name.strip())
    session.add(company)
    session.flush()
    return company


def _fill_missing_job_fields(job: Job, posting: RawPosting) -> None:
    """A repeat sighting or a cross-source match fills gaps, never
    overwrites a known value with an absent one — preserves whichever
    source said more, and matches F3.1a's "never estimate, leave
    null" discipline in the other direction: null never wins over a
    real value already on file."""

    if not job.location and posting.location:
        job.location = posting.location
    if not job.remote_policy and posting.remote_policy:
        job.remote_policy = posting.remote_policy
    if not job.seniority and posting.seniority:
        job.seniority = posting.seniority
    if not job.employment_type and posting.employment_type:
        job.employment_type = posting.employment_type
    if job.salary_min is None and posting.salary_min is not None:
        job.salary_min = posting.salary_min
    if job.salary_max is None and posting.salary_max is not None:
        job.salary_max = posting.salary_max
    if not job.salary_currency and posting.salary_currency:
        job.salary_currency = posting.salary_currency
    if not job.requirements and posting.requirements:
        job.requirements = posting.requirements
    if not job.responsibilities and posting.responsibilities:
        job.responsibilities = posting.responsibilities
    if not job.benefits and posting.benefits:
        job.benefits = posting.benefits


def _compute_ghost_signals(job: Job, now: datetime) -> tuple[float, list[str]]:
    """A stated v1 heuristic, not a claimed certainty — every
    contributing reason is listed alongside the score so a red flag
    is always explainable (PRD: "surfaced as red flags with reasons,
    never a silent filter"). Deliberately does NOT include boilerplate
    text detection: unlike age and repost count, "generic-sounding
    requirements" has no objective signal available in the data this
    layer has, and guessing at it risks flagging genuinely
    well-written listings — left out rather than faked."""

    reasons: list[str] = []
    score = 0.0

    age_days = (now - job.created_at).days
    if age_days >= 90:
        reasons.append(f"open {age_days} days without being filled")
        score += 0.3
    elif age_days >= 60:
        reasons.append(f"open {age_days} days without being filled")
        score += 0.15

    if job.repost_count >= 4:
        reasons.append(f"reposted {job.repost_count} times without a new requisition")
        score += 0.35
    elif job.repost_count >= 2:
        reasons.append(f"reposted {job.repost_count} times without a new requisition")
        score += 0.15

    return min(score, 1.0), reasons


def _maybe_prefer_sighting(session: Session, job: Job, sighting: JobSighting, source: Source) -> None:
    if job.preferred_sighting_id is None:
        job.preferred_sighting_id = sighting.id
        job.apply_url = sighting.source_url
        return

    current = session.get(JobSighting, job.preferred_sighting_id)
    if current is None:
        job.preferred_sighting_id = sighting.id
        job.apply_url = sighting.source_url
        return

    current_source = session.get(Source, current.source_id)
    current_rank = _SOURCE_PREFERENCE.get(current_source.adapter_key, 0) if current_source else 0
    new_rank = _SOURCE_PREFERENCE.get(source.adapter_key, 0)
    if new_rank > current_rank:
        job.preferred_sighting_id = sighting.id
        job.apply_url = sighting.source_url


def normalize_and_upsert(
    session: Session,
    *,
    user_id: uuid.UUID,
    source: Source,
    posting: RawPosting,
    now: datetime,
) -> tuple[Job, bool]:
    """Returns (job, is_new_job). is_new_job is False both for a
    repeat sighting (signal 1) and a cross-source canonical-key match
    (signal 2) — either way the posting mapped onto an already-known
    Job rather than creating a new one, which is exactly what the
    SourceRun postings_new/postings_deduped counters need to tell
    apart."""

    key = canonical_key(posting.company_name, posting.title, posting.location)

    existing_sighting = None
    if posting.external_requisition_id:
        existing_sighting = (
            session.query(JobSighting)
            .filter_by(source_id=source.id, external_requisition_id=posting.external_requisition_id)
            .one_or_none()
        )

    if existing_sighting is not None:
        job = session.get(Job, existing_sighting.job_id)
        # A later posted_at on the SAME sighting (same source +
        # requisition ID) means the source re-bumped the listing
        # without opening a new requisition — the concrete,
        # data-backed form of "posted-date reset" M1 §4 asks for.
        if (
            posting.posted_at is not None
            and existing_sighting.posted_at_on_source is not None
            and posting.posted_at > existing_sighting.posted_at_on_source
        ):
            job.repost_count += 1
        existing_sighting.last_seen_at = now
        existing_sighting.source_url = posting.source_url
        existing_sighting.posted_at_on_source = posting.posted_at
        existing_sighting.raw_posting = posting.raw_payload
        _fill_missing_job_fields(job, posting)
        job.ghost_job_score, job.ghost_job_reasons = _compute_ghost_signals(job, now)
        session.flush()
        return job, False

    job = session.query(Job).filter_by(user_id=user_id, canonical_key=key).one_or_none()
    is_new = job is None
    if job is None:
        company = _get_or_create_company(session, posting.company_name)
        job = Job(
            user_id=user_id,
            title=posting.title,
            company_id=company.id,
            company_name_raw=posting.company_name,
            canonical_key=key,
            location=posting.location,
            remote_policy=posting.remote_policy,
            seniority=posting.seniority,
            employment_type=posting.employment_type,
            salary_min=posting.salary_min,
            salary_max=posting.salary_max,
            salary_currency=posting.salary_currency,
            posted_at=posting.posted_at,
            requirements=posting.requirements,
            responsibilities=posting.responsibilities,
            benefits=posting.benefits,
            apply_url=posting.apply_url,
        )
        session.add(job)
        session.flush()
    else:
        _fill_missing_job_fields(job, posting)

    sighting = JobSighting(
        job_id=job.id,
        source_id=source.id,
        source_url=posting.source_url,
        external_requisition_id=posting.external_requisition_id,
        first_seen_at=now,
        last_seen_at=now,
        posted_at_on_source=posting.posted_at,
        raw_posting=posting.raw_payload,
    )
    session.add(sighting)
    session.flush()

    _maybe_prefer_sighting(session, job, sighting, source)
    job.ghost_job_score, job.ghost_job_reasons = _compute_ghost_signals(job, now)
    session.flush()

    return job, is_new
