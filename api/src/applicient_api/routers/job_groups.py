"""M3 §2/F5.10 — job group CRUD and the tailoring trigger.

Streams tailoring progress via SSE, same EventSourceResponse pattern
as cv.py/radar.py — a single LLM call is fast enough that this could
be a plain request/response, but keeping the same stage-event shape
here is what lets M3 §3 (rendering) and §4 (claim verification) extend
this exact stream later with more stages, rather than the Composer UI
needing a second, differently-shaped call once those land.
"""

import json
import uuid
from asyncio import to_thread
from datetime import datetime, timezone
from typing import AsyncGenerator

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import ValidationError
from sqlalchemy.orm import Session
from sse_starlette.sse import EventSourceResponse

from applicient_api import schemas
from applicient_api.deps import current_user_id, get_db, get_session_factory
from applicient_api.latex_rendering import COVER_LETTER_TEMPLATES, RenderError, TEMPLATES
from applicient_api.models.agents import AgentRun
from applicient_api.models.discovery import Job
from applicient_api.models.documents import ClaimVerification, Document, JobGroup, JobGroupMember
from applicient_api.credit_ledger import (
    FEATURE_ANSWER_PACK,
    FEATURE_COVER_LETTER,
    FEATURE_CV_TAILOR,
    FEATURE_SKILL_GAP_SYLLABUS,
    charge_credits,
    require_credits,
)
from applicient_api.models.profile import Persona
from applicient_api.rate_limit import rate_limit
from applicient_api.claim_verification_service import (
    VerificationError,
    regenerate_from_last_verification,
    run_verification_attempt,
)
from applicient_api.answer_pack_service import generate_answer_pack
from applicient_api.cover_letter_service import generate_cover_letter
from applicient_api.rendering_service import (
    clear_document_tex_override,
    get_document_tex,
    get_rendered_pdf,
    render_base_cv,
    render_document,
    save_document_tex_override,
)
from applicient_api.skill_gap_service import (
    SkillGapError,
    complete_skill_gap_item,
    generate_syllabus,
    reopen_skill_gap_item,
    sync_skill_gap_items,
)
from applicient_api.tailoring_engine import TailoringOutput
from applicient_api.tailoring_service import TailoringError, save_document_delta, tailor_job_group
from applicient_api.tier_resolution import TierResolutionError, active_model_profile

router = APIRouter(prefix="/job-groups", tags=["job-groups"])
persona_router = APIRouter(prefix="/personas/{persona_id}/job-groups", tags=["job-groups"])
documents_router = APIRouter(prefix="/documents", tags=["documents"])
base_cv_router = APIRouter(prefix="/personas/{persona_id}/base-cv", tags=["documents"])


@documents_router.get("/templates")
def list_templates(doc_type: str = "cv"):
    registry = COVER_LETTER_TEMPLATES if doc_type == "cover_letter" else TEMPLATES
    return [{"id": tid, "name": t["name"], "description": t["description"]} for tid, t in registry.items()]


@base_cv_router.post("")
def render_base_cv_route(
    persona_id: uuid.UUID,
    template_id: str,
    db: Session = Depends(get_db),
    user_id: uuid.UUID = Depends(current_user_id),
):
    """An untailored baseline CV straight from the persona's evidence
    bank, so the Composer shows something real before any job group
    exists to tailor against (raised by Adrian). Stateless by design —
    see render_base_cv's own docstring for why this is never persisted
    as a Document."""

    if db.query(Persona).filter_by(id=persona_id, user_id=user_id).one_or_none() is None:
        raise HTTPException(404, "persona not found")
    try:
        pdf_bytes = render_base_cv(
            get_session_factory(), persona_id=persona_id, user_id=user_id, template_id=template_id
        )
    except RenderError as exc:
        raise HTTPException(422, str(exc))
    return Response(content=pdf_bytes, media_type="application/pdf")


@documents_router.get("/{document_id}", response_model=schemas.DocumentOut)
def get_document(document_id: uuid.UUID, db: Session = Depends(get_db), user_id: uuid.UUID = Depends(current_user_id)):
    """The plain row — every other document route returns a derivative
    (`/rendered` PDF bytes, `/tex` source, `/verifications` history);
    nothing returned the row itself until now. Backs the Assistant
    chat's document card, which only has a `document_id` from a tool
    result and needs `doc_type`/`template`/`verified`/`json_delta` to
    render a preview + diff view."""

    document = db.query(Document).filter_by(id=document_id, user_id=user_id).one_or_none()
    if document is None:
        raise HTTPException(404, "document not found")
    return document


@documents_router.get("/{document_id}/verifications", response_model=list[schemas.ClaimVerificationOut])
def list_document_verifications(
    document_id: uuid.UUID, db: Session = Depends(get_db), user_id: uuid.UUID = Depends(current_user_id)
):
    if db.query(Document).filter_by(id=document_id, user_id=user_id).one_or_none() is None:
        raise HTTPException(404, "document not found")
    return (
        db.query(ClaimVerification)
        .filter_by(document_id=document_id)
        .order_by(ClaimVerification.attempt_number.desc())
        .all()
    )


@documents_router.get("/{document_id}/rendered")
def get_rendered_pdf_route(
    document_id: uuid.UUID,
    template_id: str,
    db: Session = Depends(get_db),
    user_id: uuid.UUID = Depends(current_user_id),
):
    """The already-rendered PDF, if one exists — no recompile. Lets the
    Composer restore the preview pane on page load/document switch
    instead of showing a blank "click Preview" every time (raised by
    Adrian). 404 if this exact document/template was never rendered."""

    if db.query(Document).filter_by(id=document_id, user_id=user_id).one_or_none() is None:
        raise HTTPException(404, "document not found")
    pdf_bytes = get_rendered_pdf(
        get_session_factory(), document_id=document_id, user_id=user_id, template_id=template_id
    )
    if pdf_bytes is None:
        raise HTTPException(404, "not rendered yet for this template")
    return Response(content=pdf_bytes, media_type="application/pdf")


@documents_router.post("/{document_id}/render")
def render_document_route(
    document_id: uuid.UUID,
    template_id: str,
    db: Session = Depends(get_db),
    user_id: uuid.UUID = Depends(current_user_id),
):
    """Synchronous, not SSE — Tectonic compiles in low single-digit
    seconds, this is what the Composer's live preview calls on every
    debounced edit/template switch. Returns the PDF bytes directly
    (so the preview pane doesn't need a second round trip through
    object storage) and persists them as a side effect."""

    if db.query(Document).filter_by(id=document_id, user_id=user_id).one_or_none() is None:
        raise HTTPException(404, "document not found")
    try:
        _, pdf_bytes = render_document(
            get_session_factory(), document_id=document_id, user_id=user_id, template_id=template_id
        )
    except RenderError as exc:
        raise HTTPException(422, str(exc))
    return Response(content=pdf_bytes, media_type="application/pdf")


@documents_router.get("/{document_id}/tex", response_model=schemas.DocumentTexOut)
def get_document_tex_route(
    document_id: uuid.UUID,
    template_id: str,
    db: Session = Depends(get_db),
    user_id: uuid.UUID = Depends(current_user_id),
):
    """The raw .tex source for this document/template — a saved hand
    edit if one exists, else freshly generated from the current
    json_delta. What the Composer's "Edit LaTeX" view loads."""

    if db.query(Document).filter_by(id=document_id, user_id=user_id).one_or_none() is None:
        raise HTTPException(404, "document not found")
    try:
        tex, is_edited = get_document_tex(
            get_session_factory(), document_id=document_id, user_id=user_id, template_id=template_id
        )
    except RenderError as exc:
        raise HTTPException(422, str(exc))
    return schemas.DocumentTexOut(tex=tex, is_edited=is_edited)


@documents_router.put("/{document_id}/tex", response_model=schemas.DocumentOut)
def save_document_tex_route(
    document_id: uuid.UUID,
    body: schemas.DocumentTexIn,
    db: Session = Depends(get_db),
    user_id: uuid.UUID = Depends(current_user_id),
):
    """Saves a hand edit. Never re-runs the claim verifier (F5.4) —
    once a human's hands are on the text, that's their call, stated
    plainly in the model's own docstring rather than silently assumed
    equivalent to AI-authored content."""

    if db.query(Document).filter_by(id=document_id, user_id=user_id).one_or_none() is None:
        raise HTTPException(404, "document not found")
    try:
        return save_document_tex_override(
            get_session_factory(),
            document_id=document_id,
            user_id=user_id,
            template_id=body.template_id,
            tex=body.tex,
        )
    except RenderError as exc:
        raise HTTPException(422, str(exc))


@documents_router.delete("/{document_id}/tex", response_model=schemas.DocumentOut)
def clear_document_tex_route(
    document_id: uuid.UUID,
    template_id: str,
    db: Session = Depends(get_db),
    user_id: uuid.UUID = Depends(current_user_id),
):
    """"Reset to AI draft" — discards the hand edit for this template."""

    if db.query(Document).filter_by(id=document_id, user_id=user_id).one_or_none() is None:
        raise HTTPException(404, "document not found")
    try:
        return clear_document_tex_override(
            get_session_factory(), document_id=document_id, user_id=user_id, template_id=template_id
        )
    except RenderError as exc:
        raise HTTPException(422, str(exc))


@documents_router.put(
    "/{document_id}/delta",
    response_model=schemas.DocumentOut,
    dependencies=[Depends(require_credits(FEATURE_CV_TAILOR, label="editing this CV"))],
)
def save_document_delta_route(
    document_id: uuid.UUID,
    body: dict,
    db: Session = Depends(get_db),
    user_id: uuid.UUID = Depends(current_user_id),
):
    """A structured, per-section hand edit — add/remove a whole
    "experience card", add/remove/reword a bullet, edit the summary —
    raised by Adrian as a separate ask from raw LaTeX editing. Body is
    a TailoringOutput-shaped dict (summary, sections, skills_highlight,
    rationale); validated with the same Pydantic model the tailoring
    engine itself produces, so there's one schema, not two drifting
    copies. Resets `verified` to False — the previous verification
    described the old content, not this edit.

    Costs the same credits as generating the draft (Adrian, direct: "CV
    tailor cost not only for draft but for edits as well") — each save
    is its own charge, no agent_run_id to dedupe against (unlike the
    generation stream, a hand edit has no AgentRun of its own, and
    genuinely IS a new, separate action each time)."""

    if db.query(Document).filter_by(id=document_id, user_id=user_id).one_or_none() is None:
        raise HTTPException(404, "document not found")
    try:
        delta = TailoringOutput.model_validate(body)
    except ValidationError as exc:
        raise HTTPException(422, str(exc))
    try:
        document = save_document_delta(get_session_factory(), document_id=document_id, user_id=user_id, delta=delta)
    except TailoringError as exc:
        raise HTTPException(404, str(exc))
    charge_credits(db, user_id=user_id, feature_key=FEATURE_CV_TAILOR, label="editing this CV")
    return document


def _owned_group(db: Session, group_id: uuid.UUID, user_id: uuid.UUID) -> JobGroup:
    group = db.query(JobGroup).filter_by(id=group_id, user_id=user_id).one_or_none()
    if group is None:
        raise HTTPException(404, "job group not found")
    return group


def _to_out(db: Session, group: JobGroup) -> schemas.JobGroupOut:
    job_ids = [m.job_id for m in db.query(JobGroupMember).filter_by(job_group_id=group.id).all()]
    return schemas.JobGroupOut(
        id=group.id,
        persona_id=group.persona_id,
        name=group.name,
        job_ids=job_ids,
        target_role_title=group.target_role_title,
        target_company=group.target_company,
    )


@persona_router.get("", response_model=list[schemas.JobGroupOut])
def list_job_groups(
    persona_id: uuid.UUID, db: Session = Depends(get_db), user_id: uuid.UUID = Depends(current_user_id)
):
    if db.query(Persona).filter_by(id=persona_id, user_id=user_id).one_or_none() is None:
        raise HTTPException(404, "persona not found")
    groups = db.query(JobGroup).filter_by(persona_id=persona_id, user_id=user_id).all()
    return [_to_out(db, g) for g in groups]


@persona_router.post("", response_model=schemas.JobGroupOut, status_code=201)
def create_job_group(
    persona_id: uuid.UUID,
    body: schemas.JobGroupCreate,
    db: Session = Depends(get_db),
    user_id: uuid.UUID = Depends(current_user_id),
):
    if db.query(Persona).filter_by(id=persona_id, user_id=user_id).one_or_none() is None:
        raise HTTPException(404, "persona not found")
    group = JobGroup(
        user_id=user_id,
        persona_id=persona_id,
        name=body.name,
        target_role_title=(body.target_role_title or "").strip() or None,
        target_company=(body.target_company or "").strip() or None,
    )
    db.add(group)
    db.flush()
    for job_id in body.job_ids:
        db.add(JobGroupMember(job_group_id=group.id, job_id=job_id))
    db.commit()
    return _to_out(db, group)


@router.patch("/{group_id}", response_model=schemas.JobGroupOut)
def update_job_group(
    group_id: uuid.UUID,
    body: schemas.JobGroupUpdate,
    db: Session = Depends(get_db),
    user_id: uuid.UUID = Depends(current_user_id),
):
    group = _owned_group(db, group_id, user_id)
    for field, value in body.model_dump(exclude_unset=True).items():
        setattr(group, field, value)
    db.commit()
    return _to_out(db, group)


@router.delete("/{group_id}", status_code=204)
def delete_job_group(
    group_id: uuid.UUID, db: Session = Depends(get_db), user_id: uuid.UUID = Depends(current_user_id)
):
    group = _owned_group(db, group_id, user_id)
    db.delete(group)
    db.commit()


@router.post("/{group_id}/members", response_model=schemas.JobGroupOut, status_code=201)
def add_job_group_member(
    group_id: uuid.UUID,
    body: schemas.JobGroupAddMember,
    db: Session = Depends(get_db),
    user_id: uuid.UUID = Depends(current_user_id),
):
    group = _owned_group(db, group_id, user_id)
    if db.get(Job, body.job_id) is None:
        raise HTTPException(404, "job not found")
    existing = db.query(JobGroupMember).filter_by(job_group_id=group.id, job_id=body.job_id).one_or_none()
    if existing is None:
        db.add(JobGroupMember(job_group_id=group.id, job_id=body.job_id))
        db.commit()
    return _to_out(db, group)


@router.delete("/{group_id}/members/{job_id}", response_model=schemas.JobGroupOut)
def remove_job_group_member(
    group_id: uuid.UUID,
    job_id: uuid.UUID,
    db: Session = Depends(get_db),
    user_id: uuid.UUID = Depends(current_user_id),
):
    group = _owned_group(db, group_id, user_id)
    db.query(JobGroupMember).filter_by(job_group_id=group.id, job_id=job_id).delete()
    db.commit()
    return _to_out(db, group)


@router.get("/{group_id}/skill-gap", response_model=list[schemas.SkillGapItemOut])
def get_skill_gap(
    group_id: uuid.UUID, db: Session = Depends(get_db), user_id: uuid.UUID = Depends(current_user_id)
):
    group = _owned_group(db, group_id, user_id)
    return sync_skill_gap_items(db, group=group)


@router.post("/{group_id}/skill-gap/{item_id}/complete", response_model=schemas.SkillGapItemOut)
def complete_skill_gap(
    group_id: uuid.UUID,
    item_id: uuid.UUID,
    db: Session = Depends(get_db),
    user_id: uuid.UUID = Depends(current_user_id),
):
    group = _owned_group(db, group_id, user_id)
    try:
        return complete_skill_gap_item(
            db, group=group, item_id=item_id, user_id=user_id, session_factory=get_session_factory()
        )
    except SkillGapError as exc:
        raise HTTPException(404, str(exc))


@router.post("/{group_id}/skill-gap/{item_id}/reopen", response_model=schemas.SkillGapItemOut)
def reopen_skill_gap(
    group_id: uuid.UUID,
    item_id: uuid.UUID,
    db: Session = Depends(get_db),
    user_id: uuid.UUID = Depends(current_user_id),
):
    group = _owned_group(db, group_id, user_id)
    try:
        return reopen_skill_gap_item(db, group=group, item_id=item_id)
    except SkillGapError as exc:
        raise HTTPException(404, str(exc))


@router.post(
    "/{group_id}/skill-gap/{item_id}/generate-syllabus",
    response_model=schemas.SkillGapItemOut,
    dependencies=[
        Depends(rate_limit("skill-gap-syllabus", limit=10, window_seconds=60)),
        Depends(require_credits(FEATURE_SKILL_GAP_SYLLABUS, label="generating a learning plan")),
    ],
)
def generate_skill_gap_syllabus(
    group_id: uuid.UUID,
    item_id: uuid.UUID,
    db: Session = Depends(get_db),
    user_id: uuid.UUID = Depends(current_user_id),
):
    """Phase 10 (v2 plan) — a real LLM call (rate-limited/cap-gated
    like tailor/cover-letter/answer-pack above), but a single-shot one
    with no verify/regenerate loop, so a plain request/response is
    enough — no SSE stage stream needed the way those three have."""

    group = _owned_group(db, group_id, user_id)
    try:
        result = generate_syllabus(
            db, group=group, item_id=item_id, user_id=user_id, session_factory=get_session_factory()
        )
    except SkillGapError as exc:
        raise HTTPException(404, str(exc))
    except TierResolutionError as exc:
        raise HTTPException(422, f"model routing not configured: {exc}")
    charge_credits(db, user_id=user_id, feature_key=FEATURE_SKILL_GAP_SYLLABUS, label="generating a learning plan")
    return result


@router.get("/{group_id}/documents", response_model=list[schemas.DocumentOut])
def list_group_documents(
    group_id: uuid.UUID,
    doc_type: str | None = None,
    db: Session = Depends(get_db),
    user_id: uuid.UUID = Depends(current_user_id),
):
    """`doc_type` filters to "cv" or "cover_letter" — version numbers
    are scoped per doc_type (a CV v1 and a cover letter v1 can coexist
    for the same group), so the unfiltered list interleaves two
    independent version sequences rather than one."""

    _owned_group(db, group_id, user_id)
    query = db.query(Document).filter_by(job_group_id=group_id, user_id=user_id)
    if doc_type:
        query = query.filter_by(doc_type=doc_type)
    return query.order_by(Document.version.desc()).all()


def _event(stage: str, status: str, message: str, **detail) -> dict:
    return {"event": "stage", "data": json.dumps({"stage": stage, "status": status, "message": message, **detail})}


def _error_event(message: str) -> dict:
    return {"event": "error", "data": json.dumps({"message": message})}


async def _tailor_stream(group_id: uuid.UUID, user_id: uuid.UUID, verify: bool) -> AsyncGenerator[dict, None]:
    session_factory = get_session_factory()

    with session_factory() as db:
        run = AgentRun(
            user_id=user_id, run_type="composer", status="running", started_at=datetime.now(timezone.utc)
        )
        db.add(run)
        db.commit()

        def fail_run() -> None:
            db.rollback()
            failed = db.get(AgentRun, run.id)
            if failed is not None:
                failed.status = "failed"
                failed.finished_at = datetime.now(timezone.utc)
                db.commit()

        # Same fix as radar.py's stream, for the same real reason: a
        # client disconnect mid-tailor (closed tab, dropped network) or
        # a cancellation tears this generator down via GeneratorExit/
        # CancelledError — both BaseException, never caught by the
        # plain `except Exception` below — leaving `run.status` stuck
        # at "running" forever even though `tailor_job_group`/
        # `verify_and_gate` (running via to_thread) keep executing to
        # completion in their own detached thread and commit their
        # real results regardless. Confirmed live: two real runs were
        # left stuck exactly this way before this `finally` existed.
        try:
            yield _event("tailoring", "started", "Generating tailored CV delta — this is the slow step")
            document = await to_thread(
                tailor_job_group,
                session_factory,
                job_group_id=group_id,
                user_id=user_id,
                agent_run_id=run.id,
            )
            yield _event("tailoring", "done", "Tailored CV delta generated")

            # Real, separate steps — not one opaque "verifying" call —
            # so the Composer's step progression actually reflects what
            # M3 §4 is doing: an attempt can pass immediately (2 LLM
            # calls total: tailor, verify) or need one regeneration
            # (4 calls: tailor, verify, regenerate, re-verify), and
            # each one is genuinely a 1-3+ minute deep-tier call in
            # this environment — not a single fast request. That
            # latency compounds badly (up to ~4 slow calls back to
            # back), so `verify` (raised by Adrian) lets the caller
            # skip this whole block and get the tailored draft alone —
            # `document.verified` simply stays its default `False`
            # ("never checked", not "checked and failed"; the Composer
            # UI already distinguishes the two and only blocks export
            # for the latter), and the dedicated Re-verify action still
            # runs this same check later, on demand, at no loss of
            # capability — just not forced up front.
            if verify:
                yield _event("verifying", "started", "Checking every claim against the evidence bank", attempt=1)
                document, clean = await to_thread(
                    run_verification_attempt,
                    session_factory,
                    document_id=document.id,
                    user_id=user_id,
                    attempt_number=1,
                    agent_run_id=run.id,
                )
                yield _event(
                    "verifying",
                    "done",
                    "All claims verified" if clean else "Some claims were flagged — regenerating",
                    attempt=1,
                    clean=clean,
                )

                if not clean:
                    yield _event(
                        "regenerating", "started", "Re-tailoring to fix the specific claims the verifier flagged"
                    )
                    document = await to_thread(
                        regenerate_from_last_verification,
                        session_factory,
                        document_id=document.id,
                        user_id=user_id,
                        agent_run_id=run.id,
                    )
                    yield _event("regenerating", "done", "Re-tailored delta generated")

                    yield _event(
                        "verifying", "started", "Re-checking every claim against the evidence bank", attempt=2
                    )
                    document, clean = await to_thread(
                        run_verification_attempt,
                        session_factory,
                        document_id=document.id,
                        user_id=user_id,
                        attempt_number=2,
                        agent_run_id=run.id,
                    )
                    yield _event(
                        "verifying",
                        "done",
                        "All claims verified"
                        if clean
                        else "Some claims could not be verified after 2 attempts — export is blocked until resolved",
                        attempt=2,
                        clean=clean,
                    )

            # M3 §3's render step is a separate on-demand call
            # (POST /documents/{id}/render) triggered by the Composer's
            # template picker/live preview, not part of this stream —
            # rendering needs a chosen template id, which doesn't exist
            # yet at generation time.

            active_model_profile_row = active_model_profile(db)
            run.model_profile_id = active_model_profile_row.id if active_model_profile_row else None
            run.status = "completed"
            run.finished_at = datetime.now(timezone.utc)
            db.commit()
            charge_credits(db, user_id=user_id, feature_key=FEATURE_CV_TAILOR, agent_run_id=run.id, label="tailoring a CV")

            yield {
                "event": "done",
                "data": schemas.DocumentOut.model_validate(document).model_dump_json(),
            }
        except TierResolutionError as exc:
            fail_run()
            yield _error_event(f"model routing not configured: {exc}")
        except TailoringError as exc:
            fail_run()
            yield _error_event(str(exc))
        except VerificationError as exc:
            fail_run()
            yield _error_event(str(exc))
        except Exception as exc:
            fail_run()
            yield _error_event(f"tailor/verify pipeline failed: {str(exc)[:240]}")
        finally:
            # Only fires if the run never reached the normal
            # "completed" assignment above — a real exception already
            # handled by the except clauses above doesn't reach here
            # with status still "running", so this is specifically the
            # disconnect/cancellation case. Best-effort: if even this
            # fails, there's nothing further to do but avoid masking
            # whatever caused the original exit.
            if run.status == "running":
                try:
                    run.status = "failed"
                    run.finished_at = datetime.now(timezone.utc)
                    db.commit()
                except Exception:
                    db.rollback()


async def _reverify_stream(document_id: uuid.UUID, user_id: uuid.UUID) -> AsyncGenerator[dict, None]:
    """Re-runs verification (and the one regeneration attempt, if
    needed) against an EXISTING document's current json_delta, without
    re-tailoring from scratch. Two real cases this exists for: (1) a
    document whose verification never actually completed — e.g. a
    dropped connection before `routers/job_groups.py`'s try/finally fix
    existed, confirmed live: a real document was found with
    `verified=False` and zero ClaimVerification rows, meaning
    verification simply never ran, not that it failed — and (2)
    letting a user retry verification alone (cheaper than a full
    tailor+verify) after hand-editing the delta themselves."""

    session_factory = get_session_factory()

    with session_factory() as db:
        document = db.query(Document).filter_by(id=document_id, user_id=user_id).one_or_none()
        if document is None:
            yield _error_event("document not found")
            return

        run = AgentRun(
            user_id=user_id, run_type="composer", status="running", started_at=datetime.now(timezone.utc)
        )
        db.add(run)
        db.commit()

        try:
            yield _event("verifying", "started", "Checking every claim against the evidence bank", attempt=1)
            document, clean = await to_thread(
                run_verification_attempt,
                session_factory,
                document_id=document.id,
                user_id=user_id,
                attempt_number=1,
                agent_run_id=run.id,
            )
            yield _event(
                "verifying",
                "done",
                "All claims verified" if clean else "Some claims were flagged — regenerating",
                attempt=1,
                clean=clean,
            )

            if not clean:
                yield _event(
                    "regenerating", "started", "Re-tailoring to fix the specific claims the verifier flagged"
                )
                document = await to_thread(
                    regenerate_from_last_verification,
                    session_factory,
                    document_id=document.id,
                    user_id=user_id,
                    agent_run_id=run.id,
                )
                yield _event("regenerating", "done", "Re-tailored delta generated")

                yield _event("verifying", "started", "Re-checking every claim against the evidence bank", attempt=2)
                document, clean = await to_thread(
                    run_verification_attempt,
                    session_factory,
                    document_id=document.id,
                    user_id=user_id,
                    attempt_number=2,
                    agent_run_id=run.id,
                )
                yield _event(
                    "verifying",
                    "done",
                    "All claims verified"
                    if clean
                    else "Some claims could not be verified after 2 attempts — export is blocked until resolved",
                    attempt=2,
                    clean=clean,
                )

            run.status = "completed"
            run.finished_at = datetime.now(timezone.utc)
            db.commit()
            yield {"event": "done", "data": schemas.DocumentOut.model_validate(document).model_dump_json()}
        except VerificationError as exc:
            db.rollback()
            yield _error_event(str(exc))
        except Exception as exc:
            db.rollback()
            yield _error_event(f"verification failed: {str(exc)[:240]}")
        finally:
            if run.status == "running":
                try:
                    run.status = "failed"
                    run.finished_at = datetime.now(timezone.utc)
                    db.commit()
                except Exception:
                    db.rollback()


@documents_router.post("/{document_id}/verify")
async def reverify_document(
    document_id: uuid.UUID, db: Session = Depends(get_db), user_id: uuid.UUID = Depends(current_user_id)
):
    """Same SSE shape as /tailor's verifying/regenerating stages, but
    starting from an already-tailored document — no re-tailoring from
    scratch."""

    if db.query(Document).filter_by(id=document_id, user_id=user_id).one_or_none() is None:
        raise HTTPException(404, "document not found")
    return EventSourceResponse(_reverify_stream(document_id, user_id))


@router.post(
    "/{group_id}/tailor",
    dependencies=[
        Depends(rate_limit("tailor", limit=10, window_seconds=60)),
        Depends(require_credits(FEATURE_CV_TAILOR, label="tailoring a CV")),
    ],
)
async def tailor_group(
    group_id: uuid.UUID,
    verify: bool = False,
    db: Session = Depends(get_db),
    user_id: uuid.UUID = Depends(current_user_id),
):
    """Streams `{"event": "stage" | "done" | "error", "data": "<json>"}`.
    The done payload is a full DocumentOut; error is {message}. `verify`
    defaults to False — raised by Adrian: the mandatory verify(+retry)
    pass roughly doubled (worst case ~4x'd) an already-slow tailoring
    call, and most drafts get eyeballed by the candidate anyway before
    they'd trust it regardless. Opt in per-call for the extra safety
    net; the dedicated Re-verify action on an existing document is
    unaffected either way."""

    if db.query(JobGroup).filter_by(id=group_id, user_id=user_id).one_or_none() is None:
        raise HTTPException(404, "job group not found")

    return EventSourceResponse(_tailor_stream(group_id, user_id, verify=verify))


async def _cover_letter_stream(
    group_id: uuid.UUID, user_id: uuid.UUID, tone: str, length: str
) -> AsyncGenerator[dict, None]:
    """F5.7 — same generate→verify→[regenerate→re-verify] shape as
    `_tailor_stream`, generating a cover letter instead of a CV. The
    verify/regenerate steps reuse the exact same
    `run_verification_attempt`/`regenerate_from_last_verification`
    calls the CV path uses — both are doc-type-branched internally
    (`Document.doc_type`), so nothing here needs its own copy of that
    logic, only its own generation step."""

    session_factory = get_session_factory()

    with session_factory() as db:
        run = AgentRun(
            user_id=user_id, run_type="composer", status="running", started_at=datetime.now(timezone.utc)
        )
        db.add(run)
        db.commit()

        def fail_run() -> None:
            db.rollback()
            failed = db.get(AgentRun, run.id)
            if failed is not None:
                failed.status = "failed"
                failed.finished_at = datetime.now(timezone.utc)
                db.commit()

        try:
            yield _event("tailoring", "started", "Writing a cover letter grounded in your evidence bank")
            document = await to_thread(
                generate_cover_letter,
                session_factory,
                job_group_id=group_id,
                user_id=user_id,
                tone=tone,
                length=length,
                agent_run_id=run.id,
            )
            yield _event("tailoring", "done", "Cover letter draft generated")

            yield _event("verifying", "started", "Checking every claim against the evidence bank", attempt=1)
            document, clean = await to_thread(
                run_verification_attempt,
                session_factory,
                document_id=document.id,
                user_id=user_id,
                attempt_number=1,
                agent_run_id=run.id,
            )
            yield _event(
                "verifying",
                "done",
                "All claims verified" if clean else "Some claims were flagged — regenerating",
                attempt=1,
                clean=clean,
            )

            if not clean:
                yield _event(
                    "regenerating", "started", "Rewriting to fix the specific claims the verifier flagged"
                )
                document = await to_thread(
                    regenerate_from_last_verification,
                    session_factory,
                    document_id=document.id,
                    user_id=user_id,
                    agent_run_id=run.id,
                )
                yield _event("regenerating", "done", "Revised cover letter generated")

                yield _event("verifying", "started", "Re-checking every claim against the evidence bank", attempt=2)
                document, clean = await to_thread(
                    run_verification_attempt,
                    session_factory,
                    document_id=document.id,
                    user_id=user_id,
                    attempt_number=2,
                    agent_run_id=run.id,
                )
                yield _event(
                    "verifying",
                    "done",
                    "All claims verified"
                    if clean
                    else "Some claims could not be verified after 2 attempts — export is blocked until resolved",
                    attempt=2,
                    clean=clean,
                )

            active_model_profile_row = active_model_profile(db)
            run.model_profile_id = active_model_profile_row.id if active_model_profile_row else None
            run.status = "completed"
            run.finished_at = datetime.now(timezone.utc)
            db.commit()
            charge_credits(
                db, user_id=user_id, feature_key=FEATURE_COVER_LETTER, agent_run_id=run.id,
                label="generating a cover letter",
            )

            yield {
                "event": "done",
                "data": schemas.DocumentOut.model_validate(document).model_dump_json(),
            }
        except TierResolutionError as exc:
            fail_run()
            yield _error_event(f"model routing not configured: {exc}")
        except TailoringError as exc:
            fail_run()
            yield _error_event(str(exc))
        except VerificationError as exc:
            fail_run()
            yield _error_event(str(exc))
        except Exception as exc:
            fail_run()
            yield _error_event(f"cover letter pipeline failed: {str(exc)[:240]}")
        finally:
            if run.status == "running":
                try:
                    run.status = "failed"
                    run.finished_at = datetime.now(timezone.utc)
                    db.commit()
                except Exception:
                    db.rollback()


@router.post(
    "/{group_id}/cover-letter",
    dependencies=[
        Depends(rate_limit("cover-letter", limit=10, window_seconds=60)),
        Depends(require_credits(FEATURE_COVER_LETTER, label="generating a cover letter")),
    ],
)
async def cover_letter_group(
    group_id: uuid.UUID,
    body: schemas.CoverLetterRequest | None = None,
    db: Session = Depends(get_db),
    user_id: uuid.UUID = Depends(current_user_id),
):
    """F5.7 — a per-application toggle, off by default: nothing calls
    this unless the user explicitly asks for a cover letter. `tone`/
    `length` (raised by Adrian: wanting style control, and the
    un-styled default coming out too long) default to neutral/medium
    when no body is sent. Same SSE shape as /tailor."""

    if db.query(JobGroup).filter_by(id=group_id, user_id=user_id).one_or_none() is None:
        raise HTTPException(404, "job group not found")

    req = body or schemas.CoverLetterRequest()
    return EventSourceResponse(_cover_letter_stream(group_id, user_id, req.tone, req.length))


async def _answer_pack_stream(
    group_id: uuid.UUID, user_id: uuid.UUID, questions: list[str]
) -> AsyncGenerator[dict, None]:
    """F6.8 — same generate→verify→[regenerate→re-verify] shape as
    `_tailor_stream`/`_cover_letter_stream`. `questions` are
    user-supplied (pasted from the real application) — this system has
    no scraped screening-question data to draw from."""

    session_factory = get_session_factory()

    with session_factory() as db:
        run = AgentRun(
            user_id=user_id, run_type="composer", status="running", started_at=datetime.now(timezone.utc)
        )
        db.add(run)
        db.commit()

        def fail_run() -> None:
            db.rollback()
            failed = db.get(AgentRun, run.id)
            if failed is not None:
                failed.status = "failed"
                failed.finished_at = datetime.now(timezone.utc)
                db.commit()

        try:
            yield _event("tailoring", "started", f"Answering {len(questions)} screening question(s)")
            document = await to_thread(
                generate_answer_pack,
                session_factory,
                job_group_id=group_id,
                user_id=user_id,
                questions=questions,
                agent_run_id=run.id,
            )
            yield _event("tailoring", "done", "Answer pack draft generated")

            yield _event("verifying", "started", "Checking every claim against the evidence bank", attempt=1)
            document, clean = await to_thread(
                run_verification_attempt,
                session_factory,
                document_id=document.id,
                user_id=user_id,
                attempt_number=1,
                agent_run_id=run.id,
            )
            yield _event(
                "verifying",
                "done",
                "All claims verified" if clean else "Some claims were flagged — regenerating",
                attempt=1,
                clean=clean,
            )

            if not clean:
                yield _event(
                    "regenerating", "started", "Rewriting to fix the specific claims the verifier flagged"
                )
                document = await to_thread(
                    regenerate_from_last_verification,
                    session_factory,
                    document_id=document.id,
                    user_id=user_id,
                    agent_run_id=run.id,
                )
                yield _event("regenerating", "done", "Revised answers generated")

                yield _event("verifying", "started", "Re-checking every claim against the evidence bank", attempt=2)
                document, clean = await to_thread(
                    run_verification_attempt,
                    session_factory,
                    document_id=document.id,
                    user_id=user_id,
                    attempt_number=2,
                    agent_run_id=run.id,
                )
                yield _event(
                    "verifying",
                    "done",
                    "All claims verified"
                    if clean
                    else "Some claims could not be verified after 2 attempts — export is blocked until resolved",
                    attempt=2,
                    clean=clean,
                )

            active_model_profile_row = active_model_profile(db)
            run.model_profile_id = active_model_profile_row.id if active_model_profile_row else None
            run.status = "completed"
            run.finished_at = datetime.now(timezone.utc)
            db.commit()
            charge_credits(
                db, user_id=user_id, feature_key=FEATURE_ANSWER_PACK, agent_run_id=run.id,
                label="generating an answer pack",
            )

            yield {
                "event": "done",
                "data": schemas.DocumentOut.model_validate(document).model_dump_json(),
            }
        except TierResolutionError as exc:
            fail_run()
            yield _error_event(f"model routing not configured: {exc}")
        except TailoringError as exc:
            fail_run()
            yield _error_event(str(exc))
        except VerificationError as exc:
            fail_run()
            yield _error_event(str(exc))
        except Exception as exc:
            fail_run()
            yield _error_event(f"answer pack pipeline failed: {str(exc)[:240]}")
        finally:
            if run.status == "running":
                try:
                    run.status = "failed"
                    run.finished_at = datetime.now(timezone.utc)
                    db.commit()
                except Exception:
                    db.rollback()


@router.post(
    "/{group_id}/answer-pack",
    dependencies=[
        Depends(rate_limit("answer-pack", limit=10, window_seconds=60)),
        Depends(require_credits(FEATURE_ANSWER_PACK, label="generating an answer pack")),
    ],
)
async def answer_pack_group(
    group_id: uuid.UUID,
    body: schemas.AnswerPackRequest,
    db: Session = Depends(get_db),
    user_id: uuid.UUID = Depends(current_user_id),
):
    """F6.8 — ready-to-copy answers to real screening questions
    (user-supplied, pasted from the actual application). Same SSE
    shape as /tailor."""

    if db.query(JobGroup).filter_by(id=group_id, user_id=user_id).one_or_none() is None:
        raise HTTPException(404, "job group not found")
    if not body.questions:
        raise HTTPException(422, "at least one screening question is required")

    return EventSourceResponse(_answer_pack_stream(group_id, user_id, body.questions))
