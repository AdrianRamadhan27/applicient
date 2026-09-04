"""M1 §5 — wires scoring_engine.py's pure LLM logic to persistence.
Reads the just-written `LlmCall` row back (by job_id+stage, most
recent) to get the real cost/model_id for a `PrefilterResult`/
`FitScore` row rather than re-deriving them — `CostLedgerCallbackHandler`
already computed and stored that once, correctly, through its own
independent session; asking it twice would just risk drift.

`score_job` opens and owns its own DB session (via `session_factory`,
never a session passed in) and takes IDs, not live ORM objects — this
is what makes it safe to run several of these concurrently via
`asyncio.to_thread`, which radar.py does with a bounded semaphore
(raised directly by Adrian after watching 8 jobs score strictly
sequentially, several minutes each waited out one at a time for no
reason two independent jobs' LLM calls needed to be serialized).
SQLAlchemy sessions are not thread-safe to share across concurrent
callers, and ORM objects are bound to the session that loaded them —
passing `Job`/`Persona`/`Profile` instances across a thread boundary
into a different session is exactly the kind of thing that produces
"instance is not bound to a Session" errors under concurrency, so
each call re-fetches its own copies instead of receiving them from
the caller.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass

from datetime import datetime, timezone

from sqlalchemy.orm import Session, sessionmaker

from applicient_api.models.discovery import Job
from applicient_api.models.enums import EventActor
from applicient_api.models.llm import LlmCall
from applicient_api.models.pipeline import Application, ApplicationEvent
from applicient_api.models.profile import Persona, Preference, Profile
from applicient_api.models.scoring import FitScore, PrefilterResult
from applicient_api.pipeline_stage_service import first_stage_key
from applicient_api.scoring_engine import (
    normalize_hard_blocker,
    retrieve_relevant_evidence,
    run_fit_rubric,
    run_prefilter,
    validate_evidence_spans,
)
from applicient_api.tier_resolution import resolve_tier

PREFILTER_VERSION = "v1"
SCORING_VERSION = "v1"

# Adrian, direct: "I want jobs to be automatically be added to
# pipeline instead of user having to always manually drag them there.
# Upon being scored and recommended by ai score is apply with green
# color... it automatically gets added to pipeline." Green in the
# Inbox UI (`recommendationColor`, web/src/lib/recommendation.ts) is
# both strong_apply and apply — skip/stretch never auto-add.
_AUTO_PIPELINE_RECOMMENDATIONS = {"strong_apply", "apply"}


def _auto_add_to_pipeline(
    session: Session, *, job: Job, persona: Persona, user_id: uuid.UUID
) -> bool:
    """Mirrors `POST /applications`'s own create_application — same
    idempotency (a pre-existing Application for this job wins, never
    duplicated) and the same "created" ApplicationEvent for the
    timeline — just triggered by a strong/apply score landing instead
    of a manual drag or button click. Best-effort: any failure here
    must never take down the scoring call that already succeeded and
    committed its own FitScore row, so the caller wraps this in its
    own try/except and only logs, never re-raises."""

    existing = session.query(Application).filter_by(job_id=job.id, user_id=user_id).one_or_none()
    if existing is not None:
        return False

    stage = first_stage_key(session, user_id=user_id) or "discovered"
    application = Application(
        user_id=user_id,
        job_id=job.id,
        persona_id=persona.id,
        state=stage,
    )
    session.add(application)
    session.flush()
    session.add(
        ApplicationEvent(
            application_id=application.id,
            actor=EventActor.AGENT.value,
            event_type="created",
            payload={"reason": "auto-added — AI recommendation"},
            occurred_at=datetime.now(timezone.utc),
        )
    )
    session.commit()
    return True


@dataclass
class ScoreJobResult:
    job_id: uuid.UUID
    job_title: str
    decision: str
    reason: str
    recommendation: str | None
    overall_score: float | None
    auto_added_to_pipeline: bool = False


def _latest_llm_call(session: Session, *, job_id: uuid.UUID, stage: str) -> LlmCall | None:
    return (
        session.query(LlmCall)
        .filter_by(job_id=job_id, stage=stage)
        .order_by(LlmCall.created_at.desc())
        .first()
    )


def score_job(
    session_factory: sessionmaker,
    *,
    job_id: uuid.UUID,
    persona_id: uuid.UUID,
    profile_id: uuid.UUID,
    user_id: uuid.UUID,
    agent_run_id: uuid.UUID | None = None,
    source_run_id: uuid.UUID | None = None,
) -> ScoreJobResult:
    """Runs the prefilter, and the full rubric if it survives. Fully
    synchronous and self-contained (own session, own LLM calls) —
    callers on an event loop must wrap this in `asyncio.to_thread`,
    same discipline as every other blocking LangChain call in this
    codebase; the self-contained session is what makes several
    concurrent `to_thread` calls to this function actually safe."""

    with session_factory() as db:
        job = db.get(Job, job_id)
        persona = db.get(Persona, persona_id)
        profile = db.get(Profile, profile_id)
        # M2 §3/F4.3a — one row per persona (Preference.persona_id is
        # unique), and genuinely optional: a persona that's never used
        # Profile Studio's Preferences panel scores exactly as before.
        preference = db.query(Preference).filter_by(persona_id=persona.id).one_or_none()

        fast_model = resolve_tier(
            db,
            user_id=user_id,
            tier="fast",
            stage="fit-prefilter",
            agent_run_id=agent_run_id,
            source_run_id=source_run_id,
            job_id=job.id,
            session_factory=session_factory,
        )
        prefilter_output = run_prefilter(
            fast_model, job=job, profile=profile, persona_name=persona.name, preference=preference
        )
        prefilter_call = _latest_llm_call(db, job_id=job.id, stage="fit-prefilter")

        prefilter_result = PrefilterResult(
            user_id=user_id,
            job_id=job.id,
            persona_id=persona.id,
            profile_revision=profile.revision,
            persona_revision=persona.revision,
            decision=prefilter_output.decision,
            reason=prefilter_output.reason,
            prefilter_version=PREFILTER_VERSION,
            model_used=prefilter_call.model_id if prefilter_call else None,
            cost_usd=float(prefilter_call.cost_usd) if prefilter_call else 0.0,
        )
        db.add(prefilter_result)
        db.commit()

        if prefilter_output.decision == "drop":
            return ScoreJobResult(
                job_id=job.id,
                job_title=job.title,
                decision=prefilter_result.decision,
                reason=prefilter_result.reason,
                recommendation=None,
                overall_score=None,
            )

        balanced_model = resolve_tier(
            db,
            user_id=user_id,
            tier="balanced",
            stage="fit-rubric",
            agent_run_id=agent_run_id,
            source_run_id=source_run_id,
            job_id=job.id,
            session_factory=session_factory,
        )
        evidence_items = retrieve_relevant_evidence(db, profile_id=profile.id, job=job)
        rubric = run_fit_rubric(
            balanced_model,
            job=job,
            profile=profile,
            persona_name=persona.name,
            evidence_items=evidence_items,
            preference=preference,
        )
        valid_spans = validate_evidence_spans(rubric.evidence_spans, job)

        # The raw field often isn't actually null when there's no
        # blocker — the model "answers" the yes/no-shaped field name
        # with "no"/"none"/"false" instead, which `normalize_hard_blocker`
        # treats as null (see its own docstring: confirmed live on 20
        # of 23 real rows, including one that silently forced skip over
        # an 80/100-fit job). Every use of hard_blocker below reads
        # this normalized value, never `rubric.hard_blocker` directly.
        hard_blocker_raw = normalize_hard_blocker(rubric.hard_blocker)

        # A hard blocker always forces skip, regardless of what the
        # model put in `recommendation` — a stated invariant
        # (scoring_engine.py's prompt already asks for this), enforced
        # here too rather than only hoped for from the prompt.
        recommendation = "skip" if hard_blocker_raw else rubric.recommendation

        # hard_blocker is free text (`FitScore.hard_blocker` is
        # `String(200)`) and the prompt asking for "name the specific
        # blocker" doesn't reliably keep the model under any length —
        # found live: a real run failed with StringDataRightTruncation
        # because the model wrote a full explanatory sentence instead
        # of a short label. Truncated defensively rather than trusting
        # prompt wording alone, same lesson as query_expansion.py's
        # query count and cv_parsing.py's field splits.
        hard_blocker = hard_blocker_raw[:200] if hard_blocker_raw else None

        rubric_call = _latest_llm_call(db, job_id=job.id, stage="fit-rubric")
        fit_score = FitScore(
            user_id=user_id,
            job_id=job.id,
            persona_id=persona.id,
            profile_revision=profile.revision,
            persona_revision=persona.revision,
            recommendation=recommendation,
            overall_score=rubric.overall_score,
            hard_requirements_met=rubric.hard_requirements_met,
            hard_requirements_total=rubric.hard_requirements_total,
            hard_blocker=hard_blocker,
            experience_delta_years=rubric.experience_delta_years,
            skills_matched=rubric.skills_matched,
            skills_partial=rubric.skills_partial,
            skills_missing=rubric.skills_missing,
            seniority_fit=rubric.seniority_fit,
            domain_fit=rubric.domain_fit,
            location_fit=rubric.location_fit,
            salary_overlap=rubric.salary_overlap,
            company_stage_fit=rubric.company_stage_fit,
            language_fit=rubric.language_fit,
            evidence_spans=[span.model_dump() for span in valid_spans],
            gap_closers=rubric.gap_closers,
            red_flags=rubric.red_flags,
            scoring_version=SCORING_VERSION,
            model_used=rubric_call.model_id if rubric_call else None,
            cost_usd=float(rubric_call.cost_usd) if rubric_call else 0.0,
        )
        db.add(fit_score)
        db.commit()

        auto_added = False
        if fit_score.recommendation in _AUTO_PIPELINE_RECOMMENDATIONS:
            try:
                auto_added = _auto_add_to_pipeline(db, job=job, persona=persona, user_id=user_id)
            except Exception:
                # Best-effort — a real FitScore row is already committed
                # above; a failure to also auto-create the Application
                # must not surface as a scoring failure.
                db.rollback()

        return ScoreJobResult(
            job_id=job.id,
            job_title=job.title,
            decision=prefilter_result.decision,
            reason=prefilter_result.reason,
            recommendation=fit_score.recommendation,
            overall_score=float(fit_score.overall_score),
            auto_added_to_pipeline=auto_added,
        )
