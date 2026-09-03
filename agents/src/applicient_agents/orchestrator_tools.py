"""M7 — the orchestrator agent's real tool surface. Every tool here
wraps an already-existing, already-working service function (radar's
`run_radar_search`, tailoring's verify/regenerate loop, the
application-agent's own attempt driver, ...) rather than
reimplementing any of them — the orchestrator's whole point is to
drive the same real pipeline a human already drives by hand through
Radar/Composer/Pipeline, not a second, parallel implementation of it.

A handful of the functions wrapped here are FastAPI route handlers
(`discover_company_candidates`, `create_application`) whose `Depends(...)`
parameters are ordinary Python default values outside of a real
request — calling them directly with explicit `db=`/`user_id=` kwargs
bypasses FastAPI's DI cleanly and is the same pattern this codebase
already uses for calling `render_document`/`get_rendered_pdf` etc.
directly from other service code.

`emit_progress(event_type, data)` is how a tool whose underlying work
takes multiple minutes (`run_discovery`, `tailor_cv`) surfaces
intermediate progress into the conversation's own live event stream —
without it, a human watching the chat would see nothing at all until
the whole tool call returns. It's a plain closure the caller
(`orchestrator_service.py`) provides, same "closure lets a tool report
side-channel state" pattern `browser_tools.py`'s `record_screenshot`/
`record_email_draft` already established.
"""

from __future__ import annotations

import asyncio
import json
import uuid
from collections.abc import Callable
from datetime import datetime, timezone

from dateutil import parser as date_parser
from fastapi import HTTPException
from langchain_core.tools import tool
from sqlalchemy.orm import sessionmaker

from applicient_agents.application_service import start_application_attempt

from applicient_api import schemas
from applicient_api.billing_service import current_period_spend_usd
from applicient_api.claim_verification_service import (
    VerificationError,
    regenerate_from_last_verification,
    run_verification_attempt,
)
from applicient_api.cover_letter_service import generate_cover_letter
from applicient_api.cv_latex_edit_engine import run_latex_edit
from applicient_api.latex_rendering import RenderError, compile_tex
from applicient_api.models.agents import AgentRun, RunEvent
from applicient_api.models.billing import Plan, Subscription
from applicient_api.models.calendar import CalendarEvent
from applicient_api.models.discovery import Job, SavedSearch, Source
from applicient_api.models.interview import InterviewSession
from applicient_api.models.documents import Document, JobGroup, JobGroupMember
from applicient_api.models.enums import DocumentType
from applicient_api.models.pipeline import Application, ApplicationAttempt, PipelineStage
from applicient_api.models.profile import Persona, Preference, Profile
from applicient_api.models.scoring import FitScore
from applicient_api.radar import run_radar_search
from applicient_api.rendering_service import get_document_tex, render_document, save_document_tex_override
from applicient_api.routers.applications import create_application as _create_application_route
from applicient_api.routers.applications import update_application as _update_application_route
from applicient_api.routers.company_candidates import discover_company_candidates as _discover_candidates_route
from applicient_api.routers.job_groups import create_job_group as _create_job_group_route
from applicient_api.tailoring_service import TailoringError, tailor_job_group
from applicient_api.tier_resolution import TierResolutionError, resolve_tier

# Same rank order the Job Inbox itself uses (routers/jobs.py) — "best
# matched" means these two recommendations, strongest first.
_TOP_RECOMMENDATIONS = ("strong_apply", "apply")


def _try_uuid(value: str) -> uuid.UUID | None:
    """Every id this agent's own tools take (job_id, job_group_id,
    application_id, saved_search_id) comes from the LLM's own text
    generation, not a typed caller — a hallucinated or malformed id
    string raises `ValueError` inside a bare `uuid.UUID(...)` call,
    which propagates uncaught straight through the tool and crashes
    the whole turn with a raw "badly formed hexadecimal UUID string"
    error (hit live). Every id parse in this file goes through this
    instead, so a bad id becomes a normal "error: ..." tool result the
    agent can see and recover from — same discipline as every other
    tool's own error handling in this codebase."""

    try:
        return uuid.UUID(value)
    except (ValueError, AttributeError, TypeError):
        return None


def build_orchestrator_tools(
    *,
    user_id: uuid.UUID,
    persona_id: uuid.UUID,
    agent_run_id: uuid.UUID,
    session_factory: sessionmaker,
    emit_progress: Callable[[str, dict], None],
    emit_card: Callable[[str, dict], None],
) -> list:
    """One agent turn's worth of tools, scoped to one (user, persona)
    via closures — mirrors `build_application_tools`'s own per-run
    scoping exactly. `agent_run_id` is the CURRENT chat turn's own
    `AgentRun` row (`run_type="orchestrator"`) — passed through to
    every nested service call's own `agent_run_id` parameter so real
    LLM cost this turn triggers (discovery's query expansion,
    tailoring, verification, ...) is attributed to it, visible in the
    Cost dashboard and Run Console exactly like any other run, rather
    than needing a second, redundant `AgentRun` per tool call."""

    def _emit(event_type: str, **data) -> None:
        emit_progress(event_type, data)

    @tool
    def get_preferences() -> str:
        """Read this persona's stated job-search preferences (target
        roles, seniority, salary, locations, relocation willingness,
        remote policy, industries, deal-breakers). Always check this
        before asking the human anything it might already answer —
        an empty field here means "never asked," not "deliberately
        blank," so treat only genuinely empty fields as needing a
        question."""

        with session_factory() as db:
            pref = db.query(Preference).filter_by(persona_id=persona_id, user_id=user_id).one_or_none()
            if pref is None:
                return "no preferences saved yet for this persona — every field is unset"
            out = schemas.PreferenceOut.model_validate(pref)
            lines = [f"{k}: {v}" for k, v in out.model_dump().items() if k not in ("id", "persona_id") and v not in (None, "", [])]
            return "\n".join(lines) if lines else "a preferences row exists but every field is still empty"

    @tool
    def update_preferences(
        target_roles: list[str] | None = None,
        seniority: list[str] | None = None,
        salary_floor: float | None = None,
        salary_target: float | None = None,
        salary_currency: str | None = None,
        locations: list[str] | None = None,
        willing_to_relocate: bool | None = None,
        remote_policy: list[str] | None = None,
        industries_include: list[str] | None = None,
        industries_exclude: list[str] | None = None,
        company_size_pref: list[str] | None = None,
        deal_breakers: list[str] | None = None,
    ) -> str:
        """Save whichever preference fields the human just told you —
        pass only the fields they actually answered, leave the rest
        as None (they stay unchanged, same PATCH semantics the
        Preferences page itself uses). Persists to the same row the
        Profile Studio preferences form reads and writes."""

        body = schemas.PreferenceUpsert(
            target_roles=target_roles, seniority=seniority, salary_floor=salary_floor,
            salary_target=salary_target, salary_currency=salary_currency, locations=locations,
            willing_to_relocate=willing_to_relocate, remote_policy=remote_policy,
            industries_include=industries_include, industries_exclude=industries_exclude,
            company_size_pref=company_size_pref, deal_breakers=deal_breakers,
        )
        updates = body.model_dump(exclude_unset=True, exclude_none=True)
        if not updates:
            return "nothing to save — no fields were provided"
        with session_factory() as db:
            persona = db.get(Persona, persona_id)
            pref = db.query(Preference).filter_by(persona_id=persona_id, user_id=user_id).one_or_none()
            if pref is None:
                pref = Preference(user_id=user_id, persona_id=persona_id)
                db.add(pref)
            for field, value in updates.items():
                setattr(pref, field, value)
            persona.revision += 1
            db.commit()
        return f"saved: {', '.join(updates)}"

    @tool
    def ensure_saved_search(role_titles: list[str]) -> str:
        """Make sure an active saved search exists for this persona
        before calling run_discovery — discovery has nothing to run
        against otherwise. Reuses an existing active saved search if
        one is already there (does not create a duplicate); otherwise
        creates one from every currently enabled source on this
        account and the role titles you pass in. Returns an error
        string (not an exception) if there are no enabled sources at
        all — that's a real blocker only a human can fix (pick at
        least one platform — LinkedIn, Indeed, RemoteOK, or an ATS
        board — when creating a saved search in Radar first; this tool
        can't provision a source on its own)."""

        with session_factory() as db:
            existing = (
                db.query(SavedSearch).filter_by(persona_id=persona_id, user_id=user_id, active=True).first()
            )
            if existing is not None:
                return f"using existing saved search '{existing.name}' (id={existing.id}), sources={len(existing.source_ids)}"

            enabled_sources = db.query(Source).filter_by(user_id=user_id, enabled=True).all()
            if not enabled_sources:
                return (
                    "error: no sources exist on this account yet — in Radar, create a saved search and pick "
                    "at least one platform (LinkedIn, Indeed, RemoteOK, or an ATS board) first"
                )

            saved_search = SavedSearch(
                user_id=user_id, persona_id=persona_id, name="Assistant search",
                role_titles=role_titles, source_ids=[s.id for s in enabled_sources],
                filters={}, active=True,
            )
            db.add(saved_search)
            db.commit()
            return f"created saved search '{saved_search.name}' (id={saved_search.id}) with {len(enabled_sources)} source(s)"

    @tool
    async def discover_companies() -> str:
        """Propose candidate companies from this persona's stated
        preferences and resolve each against known ATS platforms —
        the same "Discover companies" action Radar's own dialog runs.
        Requires preferences to already be saved (call
        update_preferences first if get_preferences came back empty).
        Real LLM + network calls, takes a few seconds to a minute."""

        def _run() -> str:
            with session_factory() as db:
                try:
                    candidates = _discover_candidates_route(
                        persona_id, db=db, user_id=user_id, session_factory=session_factory
                    )
                except HTTPException as exc:
                    return f"error: {exc.detail}"
                if not candidates:
                    return "no new candidate companies found"
                lines = [f"{c.company_name}: {c.status}" for c in candidates]
                return f"found {len(candidates)} candidate compan{'y' if len(candidates) == 1 else 'ies'}:\n" + "\n".join(lines)

        return await asyncio.to_thread(_run)

    @tool
    async def run_discovery(saved_search_id: str) -> str:
        """Run a real discovery pass against the given saved search —
        expands queries, fans out to every source it lists,
        normalizes/dedupes/scores every posting found. Takes anywhere
        from under a minute to several minutes depending on source
        count; progress is streamed live into this conversation as it
        runs, not just returned at the end. Use ensure_saved_search
        first to get a real saved_search_id."""

        search_id = _try_uuid(saved_search_id)
        if search_id is None:
            return f"error: '{saved_search_id}' is not a valid saved_search_id — use the id ensure_saved_search returned"

        # run_radar_search itself has no precondition checks (they live
        # in routers/radar.py, which this tool bypasses) — replicated
        # here rather than silently skipped, since scoring against an
        # unconfirmed profile would be silently wrong, not just denied.
        with session_factory() as db:
            search = db.query(SavedSearch).filter_by(id=search_id, user_id=user_id).one_or_none()
            if search is None:
                return "error: saved search not found"
            if not search.active:
                return "error: saved search is not active"
            if not search.source_ids:
                return "error: saved search has no sources selected"
            persona = db.get(Persona, search.persona_id)
            if persona is None or not persona.active:
                return "error: saved search's persona is missing or inactive"
            profile = db.get(Profile, persona.profile_id)
            if profile is None or not profile.confirmed:
                return "error: this persona's profile must be confirmed (in Profile Studio) before running a search"

        new_count = 0
        scored_count = 0
        errors: list[str] = []
        try:
            async for evt in run_radar_search(search_id, user_id, session_factory):
                event_type = evt["event"]
                data = json.loads(evt["data"])
                # Only the human-readable subset of radar's own event
                # types get a chat line — run_started/embedding_*/
                # query_expansion_fallback etc. are internal bookkeeping
                # not worth surfacing here, same editorial choice this
                # tool already makes for its own final summary.
                if event_type == "source_started":
                    _emit("discovery.progress", message=f"scanning {data.get('source_name', 'a source')}…")
                elif event_type == "source_done":
                    new_count += data.get("new", 0)
                    _emit(
                        "discovery.progress",
                        message=f"{data.get('source_name', 'a source')}: {data.get('new', 0)} new, {data.get('seen', 0)} seen",
                    )
                elif event_type == "source_error":
                    msg = data.get("message", "unknown source error")
                    errors.append(msg)
                    _emit("discovery.progress", message=f"source error: {msg}")
                elif event_type == "job_scored":
                    scored_count += 1
                    _emit(
                        "discovery.progress",
                        message=f"scored: {data.get('title', 'a job')} — {data.get('recommendation', '?')} ({data.get('overall_score', '?')})",
                    )
                elif event_type == "log":
                    _emit("discovery.progress", message=data.get("message", ""))
        except Exception as exc:
            return f"error: discovery run failed: {exc}"

        summary = f"discovery finished: {new_count} new job(s), {scored_count} scored this run"
        if errors:
            summary += f"; {len(errors)} source error(s): " + "; ".join(errors[:3])
        return summary

    @tool
    def list_top_jobs(limit: int = 10) -> str:
        """List this persona's best-matched jobs so far (recommendation
        strong_apply or apply, highest score first) — real job_id
        values from this output are what create_job_group needs.
        Never invent a job that isn't in this list."""

        with session_factory() as db:
            rows = (
                db.query(Job, FitScore)
                .join(FitScore, FitScore.job_id == Job.id)
                .filter(
                    Job.user_id == user_id,
                    FitScore.persona_id == persona_id,
                    FitScore.recommendation.in_(_TOP_RECOMMENDATIONS),
                )
                .order_by(FitScore.overall_score.desc())
                .limit(limit)
                .all()
            )
            if not rows:
                return "no scored jobs match strong_apply/apply yet — run discovery first"
            lines = [
                f"- job_id={job.id} | {job.title} at {job.company_name_raw} | "
                f"{job.location or 'location not stated'} | score={float(fs.overall_score)} ({fs.recommendation})"
                for job, fs in rows
            ]
            emit_card("jobs", {
                "jobs": [
                    {
                        "job_id": str(job.id), "title": job.title, "company_name": job.company_name_raw,
                        "location": job.location, "score": float(fs.overall_score), "recommendation": fs.recommendation,
                    }
                    for job, fs in rows
                ],
            })
            return "\n".join(lines)

    @tool
    def create_job_group(name: str, job_ids: list[str]) -> str:
        """Create a job group from a list of job_id values the human
        has confirmed they want to pursue together (from
        list_top_jobs's real output — never invent an id). One
        tailored CV gets generated per group, serving every job in it.
        Always confirm the specific jobs in plain chat before calling
        this — it's the first real commitment in the pipeline."""

        parsed_ids = []
        for j in job_ids:
            parsed = _try_uuid(j)
            if parsed is None:
                return f"error: '{j}' is not a valid job_id — use real job_id values from list_top_jobs"
            parsed_ids.append(parsed)

        with session_factory() as db:
            body = schemas.JobGroupCreate(name=name, job_ids=parsed_ids)
            out = _create_job_group_route(persona_id, body, db=db, user_id=user_id)
        return f"created job group '{out.name}' (id={out.id}) with {len(out.job_ids)} job(s)"

    @tool
    async def tailor_cv(job_group_id: str) -> str:
        """Generate a tailored CV for this job group, then verify every
        claim against the evidence bank — reproduces the exact
        generate -> verify -> (regenerate -> re-verify) sequence the
        Composer page itself runs, hard-capped at one regeneration.
        Real, slow (1-3+ minutes per LLM call, up to 4 calls). Progress
        is streamed live into this conversation as each step runs."""

        group_id = _try_uuid(job_group_id)
        if group_id is None:
            return f"error: '{job_group_id}' is not a valid job_group_id"

        def _tailor() -> "Document":
            return tailor_job_group(session_factory, job_group_id=group_id, user_id=user_id, agent_run_id=agent_run_id)

        def _verify(document_id: uuid.UUID, attempt_number: int) -> tuple:
            return run_verification_attempt(
                session_factory, document_id=document_id, user_id=user_id,
                attempt_number=attempt_number, agent_run_id=agent_run_id,
            )

        def _regenerate(document_id: uuid.UUID):
            return regenerate_from_last_verification(
                session_factory, document_id=document_id, user_id=user_id, agent_run_id=agent_run_id
            )

        try:
            _emit("tailoring.started", message="generating tailored CV delta")
            document = await asyncio.to_thread(_tailor)
            _emit("tailoring.done", message="tailored CV delta generated")

            _emit("verifying.started", message="checking every claim against the evidence bank", attempt=1)
            document, clean = await asyncio.to_thread(_verify, document.id, 1)
            _emit("verifying.done", message="all claims verified" if clean else "some claims flagged — regenerating", attempt=1, clean=clean)

            if not clean:
                _emit("regenerating.started", message="re-tailoring to fix flagged claims")
                document = await asyncio.to_thread(_regenerate, document.id)
                _emit("regenerating.done", message="re-tailored delta generated")

                _emit("verifying.started", message="re-checking every claim", attempt=2)
                document, clean = await asyncio.to_thread(_verify, document.id, 2)
                _emit("verifying.done", message="all claims verified" if clean else "still unresolved after 2 attempts", attempt=2, clean=clean)
        except (TailoringError, VerificationError, TierResolutionError) as exc:
            return f"error: {exc}"

        emit_card("document", {
            "document_id": str(document.id), "doc_type": document.doc_type,
            "template": document.template, "verified": document.verified,
            "job_group_id": str(document.job_group_id),
        })
        status = "verified" if document.verified else "NOT verified — some claims could not be confirmed after 2 attempts"
        return f"CV tailored, document_id={document.id}, status: {status}"

    @tool
    async def generate_cover_letter_tool(job_group_id: str, tone: str = "neutral", length: str = "medium") -> str:
        """Generate a cover letter for this job group — same
        generate -> verify -> (regenerate -> re-verify) sequence as
        tailor_cv. Only call this if the human actually asked for a
        cover letter; it's off by default same as in Composer."""

        group_id = _try_uuid(job_group_id)
        if group_id is None:
            return f"error: '{job_group_id}' is not a valid job_group_id"

        def _generate() -> "Document":
            return generate_cover_letter(
                session_factory, job_group_id=group_id, user_id=user_id,
                tone=tone, length=length, agent_run_id=agent_run_id,
            )

        def _verify(document_id: uuid.UUID, attempt_number: int) -> tuple:
            return run_verification_attempt(
                session_factory, document_id=document_id, user_id=user_id,
                attempt_number=attempt_number, agent_run_id=agent_run_id,
            )

        def _regenerate(document_id: uuid.UUID):
            return regenerate_from_last_verification(
                session_factory, document_id=document_id, user_id=user_id, agent_run_id=agent_run_id
            )

        try:
            _emit("tailoring.started", message="writing a cover letter")
            document = await asyncio.to_thread(_generate)
            _emit("tailoring.done", message="cover letter draft generated")

            _emit("verifying.started", message="checking every claim against the evidence bank", attempt=1)
            document, clean = await asyncio.to_thread(_verify, document.id, 1)
            _emit("verifying.done", message="all claims verified" if clean else "some claims flagged — regenerating", attempt=1, clean=clean)

            if not clean:
                _emit("regenerating.started", message="rewriting to fix flagged claims")
                document = await asyncio.to_thread(_regenerate, document.id)
                _emit("regenerating.done", message="revised cover letter generated")

                _emit("verifying.started", message="re-checking every claim", attempt=2)
                document, clean = await asyncio.to_thread(_verify, document.id, 2)
                _emit("verifying.done", message="all claims verified" if clean else "still unresolved after 2 attempts", attempt=2, clean=clean)
        except (TailoringError, VerificationError, TierResolutionError) as exc:
            return f"error: {exc}"

        emit_card("document", {
            "document_id": str(document.id), "doc_type": document.doc_type,
            "template": document.template, "verified": document.verified,
            "job_group_id": str(document.job_group_id),
        })
        status = "verified" if document.verified else "NOT verified — some claims could not be confirmed after 2 attempts"
        return f"cover letter generated, document_id={document.id}, status: {status}"

    @tool
    def create_application_for_job(
        job_id: str, job_group_id: str | None = None, document_id: str | None = None
    ) -> str:
        """Create a tracked Application for one job — required before
        run_application_agent can run. Idempotent: calling this again
        for a job that already has an Application just returns the
        existing one (and still applies document_id below if given,
        so this is also the right call to attach/change which CV an
        already-existing application uses). Pass job_group_id if this
        job's tailored documents should be attached via that group.
        Pass document_id (a real document_id from list_cv_documents)
        to explicitly attach one specific tailored CV/cover letter for
        run_application_agent to actually use — without it, the
        application-agent falls back to whatever this job's job group
        produced, or the persona's originally-uploaded CV as a last
        resort, which may not be the version the human actually wants
        used on a live run."""

        job_uuid = _try_uuid(job_id)
        if job_uuid is None:
            return f"error: '{job_id}' is not a valid job_id"
        group_uuid = None
        if job_group_id:
            group_uuid = _try_uuid(job_group_id)
            if group_uuid is None:
                return f"error: '{job_group_id}' is not a valid job_group_id"
        doc_uuid = None
        if document_id:
            doc_uuid = _try_uuid(document_id)
            if doc_uuid is None:
                return f"error: '{document_id}' is not a valid document_id"

        with session_factory() as db:
            body = schemas.ApplicationCreate(
                job_id=job_uuid, persona_id=persona_id, job_group_id=group_uuid, primary_document_id=doc_uuid
            )
            out = _create_application_route(body, db=db, user_id=user_id)
            # create_application is idempotent (returns the existing
            # row untouched for a job that already has one) — without
            # this, a document_id passed on a later call would be
            # silently dropped instead of actually attaching/changing it.
            if doc_uuid is not None and out.primary_document_id != doc_uuid:
                out = _update_application_route(
                    out.id, schemas.ApplicationUpdate(primary_document_id=doc_uuid), db=db, user_id=user_id
                )
        attached = f", primary_document_id={out.primary_document_id}" if out.primary_document_id else ""
        return f"application_id={out.id}, state={out.state}{attached}"

    @tool
    def attach_cv_to_application(application_id: str, document_id: str) -> str:
        """Attach (or change) which tailored CV/cover letter document
        an already-existing Application will use for a live
        application-agent run — use this when the human refers to an
        application already in the Pipeline (from list_pipeline) by
        name rather than by job_id, so you don't need to re-derive
        job_id just to fix which document is attached. Get a real
        document_id from list_cv_documents first."""

        app_uuid = _try_uuid(application_id)
        if app_uuid is None:
            return f"error: '{application_id}' is not a valid application_id"
        doc_uuid = _try_uuid(document_id)
        if doc_uuid is None:
            return f"error: '{document_id}' is not a valid document_id"

        with session_factory() as db:
            application = db.query(Application).filter_by(id=app_uuid, user_id=user_id).one_or_none()
            if application is None:
                return f"error: application {application_id} not found"
            document = db.query(Document).filter_by(id=doc_uuid, user_id=user_id).one_or_none()
            if document is None:
                return f"error: document {document_id} not found"
            out = _update_application_route(
                app_uuid, schemas.ApplicationUpdate(primary_document_id=doc_uuid), db=db, user_id=user_id
            )
        return f"application_id={out.id} now uses primary_document_id={out.primary_document_id}"

    @tool
    async def run_application_agent(application_id: str) -> str:
        """Start the real application-agent on this Application — it
        opens the job's real apply form in a live browser and fills
        it. This call returns as soon as the run pauses for a human
        (a submit-review, a login/captcha handoff, or an unresolvable
        field) or finishes — it never blocks this conversation waiting
        for that human decision. Any pause is resolved through the
        existing Pipeline page (or its Live Browser view), completely
        independent of this chat; call check_application_attempt_status
        later to see how it went."""

        app_uuid = _try_uuid(application_id)
        if app_uuid is None:
            return f"error: '{application_id}' is not a valid application_id"

        # The card appears the moment attempt_id is known (this
        # application's own attempt_id, present on every event
        # application_service.py emits) — not only once the run
        # finishes — so a human watching the chat gets a live "View in
        # Pipeline" link right away. Emitted again, in place, once a
        # session_id shows up (the run opened a real browser), which
        # additionally unlocks the "Watch live browser" link.
        card_attempt_id: str | None = None
        last_event: dict | None = None
        try:
            async for evt in start_application_attempt(session_factory, application_id=app_uuid, user_id=user_id):
                data = json.loads(evt["data"])
                if card_attempt_id is None and data.get("attempt_id"):
                    card_attempt_id = data["attempt_id"]
                    emit_card("application", {
                        "application_id": application_id, "attempt_id": card_attempt_id, "session_id": None,
                    })
                if evt["event"] == "stage" and data.get("stage") == "browser" and data.get("status") == "session_opened":
                    emit_card("application", {
                        "application_id": application_id, "attempt_id": card_attempt_id,
                        "session_id": data.get("session_id"),
                    })
                if evt["event"] == "stage":
                    _emit("application.progress", message=data.get("message", ""))
                elif evt["event"] == "interrupt":
                    tools_waiting = ", ".join(r.get("tool", "?") for r in data.get("requests", []))
                    _emit("application.progress", message=f"paused, waiting on a human ({tools_waiting})")
                elif evt["event"] == "done":
                    _emit("application.progress", message="application run finished")
                elif evt["event"] == "error":
                    _emit("application.progress", message=f"error: {data.get('message', 'unknown error')}")
                last_event = {"event": evt["event"], **data}
        except Exception as exc:
            return f"error: application run failed: {exc}"

        if last_event is None:
            return "error: application run produced no events"
        if last_event["event"] == "interrupt":
            requests = last_event.get("requests", [])
            tools_waiting = ", ".join(r.get("tool", "?") for r in requests)
            return f"paused, waiting on a human ({tools_waiting}) — tell them to check Pipeline, not resolvable from this chat"
        if last_event["event"] == "done":
            return "application run finished — check_application_attempt_status for the outcome"
        return f"error: {last_event.get('message', 'application run ended unexpectedly')}"

    @tool
    def check_application_attempt_status(application_id: str) -> str:
        """Check on an application-agent run started earlier (in this
        conversation or a previous one) without starting a new one —
        use this instead of calling run_application_agent again just
        to check status."""

        app_uuid = _try_uuid(application_id)
        if app_uuid is None:
            return f"error: '{application_id}' is not a valid application_id"

        with session_factory() as db:
            application = db.query(Application).filter_by(id=app_uuid, user_id=user_id).one_or_none()
            if application is None:
                return "error: application not found"
            attempt = (
                db.query(ApplicationAttempt)
                .filter_by(application_id=application.id)
                .order_by(ApplicationAttempt.attempt_number.desc())
                .first()
            )
            if attempt is None:
                return f"application state={application.state}, no attempts have run yet"

            # Same card the human already saw when run_application_agent
            # first started this attempt — re-emitted here too, since a
            # later "how's it going?" turn (this tool, not a fresh run)
            # previously left them with only a text description and no
            # actual link. The browser-worker session_id itself is
            # never stored on the attempt row (it's an ephemeral,
            # in-memory concept) — recovered from this attempt's own
            # persisted "browser session opened" RunEvent instead, the
            # same durable trail every run already writes.
            session_id = None
            if attempt.agent_run_id is not None:
                events = (
                    db.query(RunEvent)
                    .filter_by(agent_run_id=attempt.agent_run_id, event_type="stage")
                    .order_by(RunEvent.seq.desc())
                    .all()
                )
                for evt in events:
                    if evt.data.get("stage") == "browser" and evt.data.get("status") == "session_opened":
                        session_id = evt.data.get("session_id")
                        break
            emit_card("application", {
                "application_id": application_id, "attempt_id": str(attempt.id), "session_id": session_id,
            })

            return (
                f"application state={application.state}, latest attempt #{attempt.attempt_number} "
                f"status={attempt.status}" + (f", error={attempt.error}" if attempt.error else "")
            )

    @tool
    def list_saved_searches() -> str:
        """List this persona's saved searches — name, role titles,
        active/paused state, schedule, source count, and when each
        last ran. Check this before ensure_saved_search/run_discovery:
        an existing active search may already cover what the human's
        asking for, so there's no need to create a new one."""

        with session_factory() as db:
            searches = (
                db.query(SavedSearch)
                .filter_by(persona_id=persona_id, user_id=user_id)
                .order_by(SavedSearch.created_at.desc())
                .all()
            )
            if not searches:
                return "no saved searches exist yet for this persona"

            lines = []
            for s in searches:
                last_run = (
                    db.query(AgentRun)
                    .filter_by(saved_search_id=s.id, run_type="radar")
                    .order_by(AgentRun.started_at.desc())
                    .first()
                )
                if last_run is None:
                    last_run_desc = "never run"
                else:
                    when = last_run.finished_at or last_run.started_at
                    last_run_desc = f"last run {last_run.status} at {when.isoformat()}"
                lines.append(
                    f"- saved_search_id={s.id} | {s.name} | roles={', '.join(s.role_titles) or '(none)'} | "
                    f"{'active' if s.active else 'paused'} | schedule={s.schedule_cron or 'manual only'} | "
                    f"sources={len(s.source_ids)} | {last_run_desc}"
                )
            return "\n".join(lines)

    @tool
    def list_job_inbox(recommendation: str | None = None, limit: int = 15) -> str:
        """List jobs in this persona's Job Inbox, most recently
        discovered first — broader than list_top_jobs (which only
        returns strong_apply/apply): this includes unscored and
        lower-ranked jobs too, so it's the right tool for "what's
        in my inbox" rather than "what should I apply to". Pass
        recommendation ("strong_apply", "apply", "maybe", or "pass")
        to filter to one bucket; omit it to see everything."""

        with session_factory() as db:
            query = (
                db.query(Job, FitScore)
                .outerjoin(FitScore, (FitScore.job_id == Job.id) & (FitScore.persona_id == persona_id))
                .filter(Job.user_id == user_id)
            )
            if recommendation:
                query = query.filter(FitScore.recommendation == recommendation)
            rows = query.order_by(Job.created_at.desc()).limit(limit).all()
            if not rows:
                return "no jobs in the inbox yet — run discovery first"
            lines = [
                f"- job_id={job.id} | {job.title} at {job.company_name_raw} | "
                f"{job.location or 'location not stated'} | "
                + (f"score={float(fs.overall_score)} ({fs.recommendation})" if fs else "not yet scored")
                for job, fs in rows
            ]
            emit_card("jobs", {
                "jobs": [
                    {
                        "job_id": str(job.id), "title": job.title, "company_name": job.company_name_raw,
                        "location": job.location,
                        "score": float(fs.overall_score) if fs else None,
                        "recommendation": fs.recommendation if fs else None,
                    }
                    for job, fs in rows
                ],
            })
            return "\n".join(lines)

    @tool
    def list_pipeline() -> str:
        """List this persona's Application Pipeline, grouped by stage
        — what's been applied to and where each one currently stands.
        Stage names come from this user's own custom PipelineStage
        labels (renamed any time from the Pipeline page), not a fixed
        vocabulary — match against exactly what's returned here, never
        assume a literal stage name like "applied" or "interview"."""

        with session_factory() as db:
            rows = (
                db.query(Application, Job)
                .join(Job, Job.id == Application.job_id)
                .filter(Application.user_id == user_id, Application.persona_id == persona_id)
                .order_by(Application.updated_at.desc())
                .all()
            )
            if not rows:
                return "no applications tracked yet for this persona"

            stages = {s.key: s.display_name for s in db.query(PipelineStage).filter_by(user_id=user_id).all()}
            grouped: dict[str, list[str]] = {}
            for app, job in rows:
                stage_label = stages.get(app.state, app.state)
                grouped.setdefault(stage_label, []).append(
                    f"application_id={app.id} | {job.title} at {job.company_name_raw}"
                )

            lines = []
            for stage_label, entries in grouped.items():
                lines.append(f"{stage_label} ({len(entries)}):")
                lines.extend(f"  - {e}" for e in entries)
            return "\n".join(lines)

    @tool
    def get_usage_status() -> str:
        """Check this account's current billing-period LLM spend
        against its plan's monthly usage cap. Call this before
        starting an expensive operation (tailor_cv, run_discovery,
        run_application_agent) if the human seems cost-conscious, or
        right after a tool call fails with a usage-cap error."""

        with session_factory() as db:
            subscription = db.query(Subscription).filter_by(user_id=user_id).one_or_none()
            if subscription is None:
                return "no subscription found for this account"
            plan = db.get(Plan, subscription.plan_id)
            if plan is None:
                return "subscription exists but its plan could not be found"
            spend = current_period_spend_usd(db, user_id=user_id, subscription=subscription)
            cap = float(plan.monthly_usage_cap_usd)
            return (
                f"plan={plan.name} | spent ${spend:.2f} of ${cap:.2f} this billing period "
                f"(${max(cap - spend, 0):.2f} remaining)"
            )

    @tool
    def list_calendar_events(limit: int = 20) -> str:
        """List this account's upcoming Calendar events (interviews,
        assessment deadlines, application deadlines, custom reminders)
        soonest first — includes both manually added events and the
        ones auto-detected from interview/assessment emails. Check
        this before create_calendar_event if the human's intent might
        already be covered by an existing entry. Not persona-scoped —
        the Calendar covers every persona on this account."""

        with session_factory() as db:
            events = (
                db.query(CalendarEvent)
                .filter(CalendarEvent.user_id == user_id, CalendarEvent.scheduled_at >= datetime.now(timezone.utc))
                .order_by(CalendarEvent.scheduled_at)
                .limit(limit)
                .all()
            )
            if not events:
                return "no upcoming calendar events"
            job_ids = {e.job_id for e in events if e.job_id}
            jobs = {j.id: j for j in db.query(Job).filter(Job.id.in_(job_ids)).all()} if job_ids else {}
            lines = []
            for e in events:
                job = jobs.get(e.job_id)
                job_desc = f" | {job.title} at {job.company_name_raw}" if job else ""
                lines.append(
                    f"- calendar_event_id={e.id} | {e.event_type} | {e.title} | "
                    f"{e.scheduled_at.isoformat()}{job_desc}"
                )
            return "\n".join(lines)

    @tool
    def create_calendar_event(
        title: str, event_type: str, scheduled_at: str, application_id: str | None = None, notes: str | None = None
    ) -> str:
        """Add an event to the human's Calendar — an interview, an
        assessment deadline, an application deadline, or anything else
        worth not missing. event_type must be exactly one of:
        interview, assessment_deadline, application_deadline, custom.
        scheduled_at must be an ISO 8601 datetime (e.g.
        "2026-09-10T14:00:00+07:00") — include a timezone offset if
        the human stated or implied one, otherwise this is interpreted
        as UTC; never guess a date/time that wasn't actually given.
        Pass application_id (from list_pipeline) to link this event to
        a specific tracked application, if relevant — optional."""

        if event_type not in schemas.CALENDAR_EVENT_TYPES:
            return f"error: event_type must be one of {', '.join(schemas.CALENDAR_EVENT_TYPES)}"
        try:
            when = date_parser.isoparse(scheduled_at)
        except (ValueError, OverflowError):
            return f"error: '{scheduled_at}' is not a valid ISO 8601 datetime"
        if when.tzinfo is None:
            when = when.replace(tzinfo=timezone.utc)

        with session_factory() as db:
            app_uuid = None
            job_id = None
            if application_id:
                app_uuid = _try_uuid(application_id)
                if app_uuid is None:
                    return f"error: '{application_id}' is not a valid application_id"
                app = db.query(Application).filter_by(id=app_uuid, user_id=user_id).one_or_none()
                if app is None:
                    return f"error: application {application_id} not found"
                job_id = app.job_id

            event = CalendarEvent(
                user_id=user_id, application_id=app_uuid, job_id=job_id,
                event_type=event_type, title=title, scheduled_at=when, notes=notes,
            )
            db.add(event)
            db.commit()
            db.refresh(event)

        emit_card("calendar_event", {
            "calendar_event_id": str(event.id), "title": event.title, "event_type": event.event_type,
            "scheduled_at": event.scheduled_at.isoformat(),
        })
        return f"calendar_event_id={event.id}, scheduled {event.scheduled_at.isoformat()}"

    @tool
    def start_interview_practice(
        practice_type: str,
        job_id: str | None = None,
        role_title: str | None = None,
        company_name: str | None = None,
        seniority: str | None = None,
        category: str | None = None,
    ) -> str:
        """Set up a voice-based interview/FGD/LGD practice session for
        the human — this only CREATES the session and hands back a
        card with a link into the dedicated practice page; it can't
        run the actual practice inside this chat (recording/playing
        audio only works there). practice_type must be exactly one of:
        interview, fgd, lgd. For practice_type="interview", category
        may optionally be one of: screening, hr, user, role,
        experience, all (omit for a mix across all of them; ignored
        for fgd/lgd — the agent picks its own case there). Target the
        session with at least one of: job_id (a real one from
        list_job_inbox, to ground it in that posting's actual
        requirements), role_title, or company_name — any combination
        is fine (e.g. company_name alone to practice for a specific
        employer without a specific listing). seniority is free text
        like "junior"/"mid"/"senior" if the human said or implied one."""

        if practice_type not in schemas.INTERVIEW_PRACTICE_TYPES:
            return f"error: practice_type must be one of {', '.join(schemas.INTERVIEW_PRACTICE_TYPES)}"
        if category is not None and category not in schemas.INTERVIEW_CATEGORIES:
            return f"error: category must be one of {', '.join(schemas.INTERVIEW_CATEGORIES)}"
        if not job_id and not role_title and not company_name:
            return "error: provide at least one of job_id, role_title, or company_name to target the practice"

        with session_factory() as db:
            job_uuid = None
            resolved_role, resolved_company = role_title, company_name
            if job_id:
                job_uuid = _try_uuid(job_id)
                if job_uuid is None:
                    return f"error: '{job_id}' is not a valid job_id"
                job = db.query(Job).filter_by(id=job_uuid, user_id=user_id).one_or_none()
                if job is None:
                    return f"error: job {job_id} not found"
                # Denormalized onto the row, not re-joined live — same
                # reasoning routers/interview_sessions.py's own
                # create_interview_session already follows.
                resolved_role, resolved_company = job.title, job.company_name_raw

            session_row = InterviewSession(
                user_id=user_id, persona_id=persona_id, job_id=job_uuid,
                role_title=resolved_role, company_name=resolved_company, seniority=seniority,
                practice_type=practice_type, category=category, thread_id=str(uuid.uuid4()), status="in_progress",
            )
            db.add(session_row)
            db.commit()
            db.refresh(session_row)

        emit_card("interview_session", {
            "interview_session_id": str(session_row.id), "practice_type": session_row.practice_type,
            "role_title": session_row.role_title, "company_name": session_row.company_name,
        })
        return (
            f"interview_session_id={session_row.id} — session created but not yet started; "
            "tell the human to open the link shown to begin (opening it starts the agent's first "
            "question automatically)."
        )

    @tool
    def list_job_groups() -> str:
        """List this persona's job groups — name, member job count and
        titles, and whether a CV has been generated for it yet. Unlike
        list_cv_documents (which only shows groups that already have a
        CV), this shows every group, including ones with no document
        generated yet — use this for "what job groups do I have" and
        list_cv_documents for "what CVs do I have"."""

        with session_factory() as db:
            groups = db.query(JobGroup).filter_by(persona_id=persona_id, user_id=user_id).all()
            if not groups:
                return "no job groups exist yet for this persona — create one via create_job_group"

            group_ids = [g.id for g in groups]
            members = db.query(JobGroupMember).filter(JobGroupMember.job_group_id.in_(group_ids)).all()
            jobs_by_id = {j.id: j for j in db.query(Job).filter(Job.id.in_({m.job_id for m in members})).all()}
            members_by_group: dict[uuid.UUID, list[str]] = {}
            for m in members:
                job = jobs_by_id.get(m.job_id)
                if job is not None:
                    members_by_group.setdefault(m.job_group_id, []).append(f"{job.title} at {job.company_name_raw}")
            has_document = {
                d.job_group_id
                for d in db.query(Document.job_group_id).filter_by(user_id=user_id, doc_type=DocumentType.CV.value).all()
            }

            lines = []
            for g in groups:
                job_list = members_by_group.get(g.id, [])
                lines.append(
                    f"- job_group_id={g.id} | {g.name} | {len(job_list)} job(s): "
                    f"{', '.join(job_list) or '(none assigned yet)'} | "
                    f"{'CV generated' if g.id in has_document else 'no CV yet'}"
                )
            return "\n".join(lines)

    @tool
    def list_cv_documents() -> str:
        """List this persona's CV documents — the tailored version
        generated for each job group, most recent first — so you know
        which document_id to pass to edit_cv_latex. Call this before
        edit_cv_latex if the human refers to "my CV"/"the resume" by
        description rather than giving you a document_id directly."""

        with session_factory() as db:
            docs = (
                db.query(Document)
                .filter_by(user_id=user_id, persona_id=persona_id, doc_type=DocumentType.CV.value)
                .order_by(Document.created_at.desc())
                .all()
            )
            if not docs:
                return "no CV documents exist yet for this persona — generate one first via tailor_cv"

            group_ids = {d.job_group_id for d in docs}
            groups = {g.id: g.name for g in db.query(JobGroup).filter(JobGroup.id.in_(group_ids)).all()}

            lines = [
                f"- document_id={d.id} | job group: {groups.get(d.job_group_id, 'unknown')} | v{d.version} | "
                f"{'verified' if d.verified else 'unverified'} | "
                f"template={d.template or 'not yet rendered'}"
                for d in docs
            ]
            emit_card("documents", {
                "documents": [
                    {
                        "document_id": str(d.id), "job_group_name": groups.get(d.job_group_id, "unknown"),
                        "version": d.version, "verified": d.verified,
                    }
                    for d in docs
                ],
            })
            return "\n".join(lines)

    @tool
    def show_cv(document_id: str) -> str:
        """Show a CV's real rendered preview inline in this chat —
        use this whenever the human asks to see/show/view a CV.
        Read-only: doesn't change anything, unlike edit_cv_latex (for
        making changes) or list_cv_documents (metadata only, no
        preview). Use list_cv_documents first to get a real
        document_id."""

        doc_uuid = _try_uuid(document_id)
        if doc_uuid is None:
            return f"error: '{document_id}' is not a valid document_id"

        with session_factory() as db:
            document = db.query(Document).filter_by(id=doc_uuid, user_id=user_id).one_or_none()
            if document is None:
                return f"error: document {document_id} not found"
            template_id = document.template or "jakes-resume-adrian"
            verified, version, job_group_id = document.verified, document.version, document.job_group_id

        emit_card("document", {
            "document_id": document_id, "doc_type": "cv", "template": template_id,
            "verified": verified, "job_group_id": str(job_group_id),
        })
        return f"showing CV preview for document_id={document_id} (v{version}, {'verified' if verified else 'unverified'})"

    @tool
    def edit_cv_latex(document_id: str, instruction: str) -> str:
        """Edit a CV's rendered LaTeX per a plain-English instruction
        — e.g. "remove the Bangkit Academy entry", "shorten the
        summary to 2 sentences", "reorder Projects before Education".
        This is the Composer's replacement for manual LaTeX editing —
        the human describes what they want changed, you make the
        edit. Use list_cv_documents first to get a real document_id.
        The edit is compiled and confirmed to actually produce a PDF
        before anything is saved — if it fails to compile, nothing is
        saved and you'll see the compiler error in the result, so you
        can retry with a fix rather than leaving the CV broken."""

        doc_uuid = _try_uuid(document_id)
        if doc_uuid is None:
            return f"error: '{document_id}' is not a valid document_id"

        # Every CV document renders through this one template today
        # (latex_rendering.TEMPLATES has a single entry) — not hardcoded
        # product law, just nothing else to choose between yet.
        template_id = "jakes-resume-adrian"

        with session_factory() as db:
            document = db.query(Document).filter_by(id=doc_uuid, user_id=user_id).one_or_none()
            if document is None:
                return f"error: document {document_id} not found"

            try:
                current_tex, _is_edited = get_document_tex(
                    session_factory, document_id=doc_uuid, user_id=user_id, template_id=template_id
                )
            except RenderError as exc:
                return f"error: {exc}"

            try:
                model = resolve_tier(
                    db, user_id=user_id, tier="deep", stage="cv-latex-edit",
                    agent_run_id=agent_run_id, session_factory=session_factory,
                )
            except TierResolutionError as exc:
                return f"error: model routing not configured: {exc}"

            edited_tex = run_latex_edit(model, current_tex=current_tex, instruction=instruction)

            try:
                compile_tex(edited_tex)
            except RenderError as exc:
                return f"error: the edited LaTeX did not compile — nothing was saved. Compiler said:\n{exc}"

            save_document_tex_override(
                session_factory, document_id=doc_uuid, user_id=user_id, template_id=template_id, tex=edited_tex
            )
            # Re-render immediately (via the real persistence path, not
            # just the validation compile above) so the Composer's
            # preview reflects this edit without the human needing to
            # press Preview themselves — same "don't make them
            # re-click" discipline as tailor_cv's auto-preview.
            try:
                render_document(session_factory, document_id=doc_uuid, user_id=user_id, template_id=template_id)
            except RenderError:
                pass  # already confirmed compilable above; a storage hiccup here shouldn't fail the whole edit

        emit_card("document", {
            "document_id": document_id, "doc_type": "cv", "template": template_id,
            "verified": document.verified, "job_group_id": str(document.job_group_id),
        })
        return f"CV LaTeX updated for document_id={document_id} — compiled successfully and saved."

    @tool
    async def ask_user(question: str) -> str:
        """Ask the human a specific question when you're genuinely
        blocked — an ambiguous choice only they can make, or
        confirming before a costly step (tailoring, running the
        application agent) actually starts. This pauses the
        conversation and waits for their reply; do not use this for
        ordinary back-and-forth — just say it in your normal response
        and wait for their next message instead. Call at most once per
        response."""

        return f"question asked: {question}"

    return [
        get_preferences,
        update_preferences,
        ensure_saved_search,
        discover_companies,
        run_discovery,
        list_top_jobs,
        create_job_group,
        tailor_cv,
        generate_cover_letter_tool,
        create_application_for_job,
        attach_cv_to_application,
        run_application_agent,
        check_application_attempt_status,
        list_saved_searches,
        list_job_inbox,
        list_pipeline,
        get_usage_status,
        list_calendar_events,
        create_calendar_event,
        start_interview_practice,
        list_job_groups,
        list_cv_documents,
        show_cv,
        edit_cv_latex,
        ask_user,
    ]
