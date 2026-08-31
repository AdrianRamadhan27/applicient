"""F6/F7 — application CRUD, the pipeline board's state machine, and
the application-agent trigger/resume streams. Same
EventSourceResponse/SSE stage-event shape as radar.py/job_groups.py
for the two streaming endpoints; everything else is plain REST.
"""

from __future__ import annotations

import asyncio
import contextlib
import csv
import io
import json
import uuid
from datetime import datetime, timezone

import httpx
import websockets
from fastapi import APIRouter, Depends, HTTPException, Response, WebSocket, WebSocketDisconnect
from sqlalchemy.orm import Session, sessionmaker
from sse_starlette.sse import EventSourceResponse

from applicient_agents.application_service import (
    BROWSER_WORKER_URL,
    resume_application_attempt,
    start_application_attempt,
)

from applicient_api import pipeline_stage_service, schemas
from applicient_api.deps import current_user_id, get_db, get_session_factory
from applicient_api.document_resolution import resolve_application_documents
from applicient_api.models.agents import AgentRun, RunEvent
from applicient_api.models.discovery import Job
from applicient_api.models.enums import EventActor
from applicient_api.models.pipeline import Application, ApplicationAttempt, ApplicationEvent
from applicient_api.models.profile import Persona
from applicient_api.object_storage import get_object
from applicient_api.pipeline_service import MarkAppliedError, TransitionError, is_ghosted, latest_event_times, transition
from applicient_api.pipeline_service import mark_applied as mark_applied_service

router = APIRouter(prefix="/applications", tags=["applications"])


def _to_out(application: Application, *, ghosted: bool, job: Job | None = None) -> schemas.ApplicationOut:
    out = schemas.ApplicationOut.model_validate(application)
    out.ghosted = ghosted
    if job is not None:
        out.job_title = job.title
        out.company_name = job.company_name_raw
    return out


def _jobs_by_id(db: Session, applications: list[Application]) -> dict[uuid.UUID, Job]:
    job_ids = {a.job_id for a in applications}
    if not job_ids:
        return {}
    return {j.id: j for j in db.query(Job).filter(Job.id.in_(job_ids)).all()}


@router.post("", response_model=schemas.ApplicationOut, status_code=201)
def create_application(
    body: schemas.ApplicationCreate,
    db: Session = Depends(get_db),
    user_id: uuid.UUID = Depends(current_user_id),
) -> schemas.ApplicationOut:
    job = db.query(Job).filter_by(id=body.job_id, user_id=user_id).one_or_none()
    if job is None:
        raise HTTPException(404, "job not found")

    existing = db.query(Application).filter_by(job_id=body.job_id, user_id=user_id).one_or_none()
    if existing is not None:
        return _to_out(existing, ghosted=False, job=job)

    persona = db.query(Persona).filter_by(id=body.persona_id, user_id=user_id).one_or_none()
    if persona is None:
        raise HTTPException(404, "persona not found")

    application = Application(
        user_id=user_id,
        job_id=body.job_id,
        persona_id=persona.id,
        job_group_id=body.job_group_id,
        primary_document_id=body.primary_document_id,
        # M5 follow-up — the user's own first pipeline stage, not a
        # fixed "discovered" literal. The fallback is defensive only:
        # every user should already have stages by the time they can
        # reach this endpoint (provisioned at signup/seed).
        state=pipeline_stage_service.first_stage_key(db, user_id=user_id) or "discovered",
    )
    db.add(application)
    db.commit()
    db.refresh(application)
    db.add(
        ApplicationEvent(
            application_id=application.id,
            actor=EventActor.USER.value,
            event_type="created",
            payload={},
            occurred_at=datetime.now(timezone.utc),
        )
    )
    db.commit()
    return _to_out(application, ghosted=False, job=job)


@router.get("", response_model=list[schemas.ApplicationOut])
def list_applications(
    state: str | None = None,
    db: Session = Depends(get_db),
    user_id: uuid.UUID = Depends(current_user_id),
) -> list[schemas.ApplicationOut]:
    query = db.query(Application).filter_by(user_id=user_id)
    if state:
        query = query.filter_by(state=state)
    applications = query.order_by(Application.created_at.desc()).all()
    latest = latest_event_times(db, [a.id for a in applications])
    jobs = _jobs_by_id(db, applications)
    return [
        _to_out(a, ghosted=is_ghosted(a, latest_event_at=latest.get(a.id)), job=jobs.get(a.job_id))
        for a in applications
    ]


@router.get("/export")
def export_applications(
    format: str = "csv",
    db: Session = Depends(get_db),
    user_id: uuid.UUID = Depends(current_user_id),
) -> Response:
    """F7.6."""

    applications = db.query(Application).filter_by(user_id=user_id).order_by(Application.created_at.desc()).all()
    latest = latest_event_times(db, [a.id for a in applications])
    jobs = _jobs_by_id(db, applications)
    rows = [
        {
            "id": str(a.id),
            "job_id": str(a.job_id),
            "job_title": jobs[a.job_id].title if a.job_id in jobs else "",
            "company_name": jobs[a.job_id].company_name_raw if a.job_id in jobs else "",
            "state": a.state,
            "ghosted": is_ghosted(a, latest_event_at=latest.get(a.id)),
            "autonomy_level": a.autonomy_level,
            "applied_at": a.applied_at.isoformat() if a.applied_at else None,
            "created_at": a.created_at.isoformat(),
        }
        for a in applications
    ]

    if format == "json":
        return Response(content=json.dumps(rows, indent=2), media_type="application/json")

    buf = io.StringIO()
    writer = csv.DictWriter(buf, fieldnames=list(rows[0].keys()) if rows else ["id"])
    writer.writeheader()
    writer.writerows(rows)
    return Response(content=buf.getvalue(), media_type="text/csv")


@router.get("/{application_id}", response_model=schemas.ApplicationDetailOut)
def get_application(
    application_id: uuid.UUID,
    db: Session = Depends(get_db),
    user_id: uuid.UUID = Depends(current_user_id),
) -> schemas.ApplicationDetailOut:
    application = db.query(Application).filter_by(id=application_id, user_id=user_id).one_or_none()
    if application is None:
        raise HTTPException(404, "application not found")
    events = (
        db.query(ApplicationEvent)
        .filter_by(application_id=application_id)
        .order_by(ApplicationEvent.occurred_at.desc())
        .all()
    )
    attempts = (
        db.query(ApplicationAttempt)
        .filter_by(application_id=application_id)
        .order_by(ApplicationAttempt.attempt_number.desc())
        .all()
    )
    latest = latest_event_times(db, [application_id])
    ghosted = is_ghosted(application, latest_event_at=latest.get(application_id))
    job = db.get(Job, application.job_id)
    out = schemas.ApplicationDetailOut.model_validate(application)
    out.ghosted = ghosted
    if job is not None:
        out.job_title = job.title
        out.company_name = job.company_name_raw
    out.events = [schemas.ApplicationEventOut.model_validate(e) for e in events]
    out.attempts = [schemas.ApplicationAttemptOut.model_validate(a) for a in attempts]
    return out


@router.get("/{application_id}/documents/{doc_type}")
def get_application_document(
    application_id: uuid.UUID,
    doc_type: str,
    user_id: uuid.UUID = Depends(current_user_id),
    session_factory: sessionmaker = Depends(get_session_factory),
) -> Response:
    """Same fallback chain the application-agent's own `browser_upload`
    tool uses (`document_resolution.resolve_application_documents`): an
    explicit primary document, then the job_group's tailored documents,
    then the persona's own originally-uploaded CV. Backs the Pipeline
    page's "apply by email" download buttons, which used to require a
    job_group_id (a Composer session behind this application) and hit
    the identical dead end an Inbox-direct application gave the agent —
    nothing to offer either path. Ownership is enforced inside the
    resolver itself (it filters the Application by user_id first), not
    duplicated here — an unowned or nonexistent application_id just
    resolves to nothing, same 404 as a genuinely missing document."""

    resolved = resolve_application_documents(session_factory, application_id=application_id, user_id=user_id)
    doc = resolved.get(doc_type)
    if doc is None:
        raise HTTPException(404, f"no '{doc_type}' document available for this application")
    return Response(
        content=get_object(doc.key),
        media_type=doc.content_type,
        headers={"Content-Disposition": f'attachment; filename="{doc.filename}"'},
    )


@router.patch("/{application_id}", response_model=schemas.ApplicationOut)
def update_application(
    application_id: uuid.UUID,
    body: schemas.ApplicationUpdate,
    db: Session = Depends(get_db),
    user_id: uuid.UUID = Depends(current_user_id),
) -> schemas.ApplicationOut:
    application = db.query(Application).filter_by(id=application_id, user_id=user_id).one_or_none()
    if application is None:
        raise HTTPException(404, "application not found")

    if body.state is not None:
        try:
            transition(db, application=application, new_state=body.state, actor=EventActor.USER.value)
        except TransitionError as exc:
            raise HTTPException(400, str(exc))
    if body.autonomy_level is not None:
        application.autonomy_level = body.autonomy_level
    if body.primary_document_id is not None:
        application.primary_document_id = body.primary_document_id
    db.commit()
    db.refresh(application)
    latest = latest_event_times(db, [application_id])
    job = db.get(Job, application.job_id)
    return _to_out(application, ghosted=is_ghosted(application, latest_event_at=latest.get(application_id)), job=job)


@router.post("/{application_id}/mark-applied", response_model=schemas.ApplicationOut)
def mark_applied(
    application_id: uuid.UUID,
    body: schemas.MarkAppliedIn,
    db: Session = Depends(get_db),
    user_id: uuid.UUID = Depends(current_user_id),
) -> schemas.ApplicationOut:
    """F9.3 — manual mark-as-applied from any job card, independent of
    whether the agent ever ran for this application at all."""

    application = db.query(Application).filter_by(id=application_id, user_id=user_id).one_or_none()
    if application is None:
        raise HTTPException(404, "application not found")

    try:
        mark_applied_service(
            db,
            application=application,
            actor=EventActor.USER.value,
            event_type="marked_applied_manually",
            note=body.note or "",
        )
    except MarkAppliedError as exc:
        raise HTTPException(409, str(exc))
    db.commit()
    db.refresh(application)
    return _to_out(application, ghosted=False, job=db.get(Job, application.job_id))


@router.post("/{application_id}/apply")
def apply(
    application_id: uuid.UUID,
    db: Session = Depends(get_db),
    user_id: uuid.UUID = Depends(current_user_id),
) -> EventSourceResponse:
    """Starts a real application-agent run. Streams
    `{"event": "stage" | "interrupt" | "done" | "error", "data": "<json>"}`
    — an `interrupt` event means the stream has paused for a human
    decision; resolve it via `POST /applications/{id}/attempts/{attempt_id}/resume`."""

    application = db.query(Application).filter_by(id=application_id, user_id=user_id).one_or_none()
    if application is None:
        raise HTTPException(404, "application not found")
    return EventSourceResponse(
        start_application_attempt(get_session_factory(), application_id=application_id, user_id=user_id)
    )


@router.post("/{application_id}/attempts/{attempt_id}/resume")
def resume(
    application_id: uuid.UUID,
    attempt_id: uuid.UUID,
    body: schemas.InterruptDecisionsIn,
    user_id: uuid.UUID = Depends(current_user_id),
) -> EventSourceResponse:
    decisions = [
        {"type": d.type, **({"message": d.message} if d.message is not None else {})} for d in body.decisions
    ]
    return EventSourceResponse(
        resume_application_attempt(
            get_session_factory(), attempt_id=attempt_id, user_id=user_id, decisions=decisions
        )
    )


def _owned_attempt(
    db: Session, *, application_id: uuid.UUID, attempt_id: uuid.UUID, user_id: uuid.UUID
) -> ApplicationAttempt:
    attempt = (
        db.query(ApplicationAttempt)
        .join(Application, ApplicationAttempt.application_id == Application.id)
        .filter(
            ApplicationAttempt.id == attempt_id,
            ApplicationAttempt.application_id == application_id,
            Application.user_id == user_id,
        )
        .one_or_none()
    )
    if attempt is None:
        raise HTTPException(404, "attempt not found")
    return attempt


@router.get("/{application_id}/attempts/{attempt_id}/events", response_model=schemas.RunEventsOut)
def list_attempt_events(
    application_id: uuid.UUID,
    attempt_id: uuid.UUID,
    since_seq: int = 0,
    db: Session = Depends(get_db),
    user_id: uuid.UUID = Depends(current_user_id),
):
    """Replay/reconnect endpoint — mirrors saved_searches.py's
    `list_run_events` exactly, same reason: navigating away from an
    in-progress run and back used to show nothing but `status:
    "in_progress"`, because the live log only ever existed on the one
    open SSE connection (application_service.py's `_emit` now writes
    every event down as a durable `RunEvent` row first). Polling this
    on an interval while the attempt is still active approximates a
    live reconnect — same "no separate live-push channel" tradeoff as
    the radar run-events endpoint."""

    attempt = _owned_attempt(db, application_id=application_id, attempt_id=attempt_id, user_id=user_id)

    run_status = "completed"
    if attempt.agent_run_id is not None:
        run = db.get(AgentRun, attempt.agent_run_id)
        if run is not None:
            run_status = run.status

    events = (
        db.query(RunEvent)
        .filter(RunEvent.agent_run_id == attempt.agent_run_id, RunEvent.seq > since_seq)
        .order_by(RunEvent.seq)
        .all()
    )
    return schemas.RunEventsOut(
        run_status=run_status,
        events=[schemas.RunEventOut.model_validate(e) for e in events],
    )


@router.get("/{application_id}/attempts/{attempt_id}/screenshots/{index}")
def get_attempt_screenshot(
    application_id: uuid.UUID,
    attempt_id: uuid.UUID,
    index: int,
    db: Session = Depends(get_db),
    user_id: uuid.UUID = Depends(current_user_id),
) -> Response:
    """F6.7's review screen needs the actual screenshot, not just a
    key string — `index` supports Python-style negative indexing
    (`-1` = latest) so the Pipeline panel can always ask for "the most
    recent one" without first fetching the attempt to count them."""

    attempt = _owned_attempt(db, application_id=application_id, attempt_id=attempt_id, user_id=user_id)
    keys = attempt.screenshot_keys or []
    if not keys or not (-len(keys) <= index < len(keys)):
        raise HTTPException(404, "screenshot not found")
    return Response(content=get_object(keys[index]), media_type="image/png")


@router.get("/{application_id}/attempts/{attempt_id}/live-snapshot")
async def get_attempt_live_snapshot(
    application_id: uuid.UUID,
    attempt_id: uuid.UUID,
    session_id: str,
    db: Session = Depends(get_db),
    user_id: uuid.UUID = Depends(current_user_id),
) -> dict:
    """F6.7's review screen, field-by-field: while a `submit_application`
    (or any other) interrupt is pending, the browser session named in
    its own args is still open and paused — this proxies browser-worker's
    live accessibility-tree snapshot for it, so the human reviewing the
    approve/reject decision sees the actual current state of every
    field, not a reconstruction. Proxied (not called directly from the
    browser) so browser-worker — which has no auth of its own — stays
    unreachable from outside the compose network."""

    _owned_attempt(db, application_id=application_id, attempt_id=attempt_id, user_id=user_id)
    async with httpx.AsyncClient(timeout=15) as client:
        try:
            r = await client.get(f"{BROWSER_WORKER_URL}/sessions/{session_id}/snapshot")
        except httpx.HTTPError as exc:
            raise HTTPException(502, f"browser-worker unreachable: {exc}")
    if r.is_error:
        raise HTTPException(r.status_code, r.text)
    return r.json()


@router.websocket("/{application_id}/attempts/{attempt_id}/live-browser")
async def live_browser_proxy(
    websocket: WebSocket,
    application_id: uuid.UUID,
    attempt_id: uuid.UUID,
    session_id: str,
    db: Session = Depends(get_db),
    user_id: uuid.UUID = Depends(current_user_id),
) -> None:
    """The dedicated Live Browser page (§8.3/F6.5) — proxies
    browser-worker's own screencast WebSocket
    (`browser_worker/main.py`'s `/sessions/{id}/screencast`) through
    `api` rather than exposing browser-worker's internal port directly
    to the frontend: it has no auth of its own and isn't meant to be
    reachable outside the compose network, same reasoning as the
    live-snapshot proxy above. A dumb pipe in both directions — real
    PNG frames pass straight through one way, JSON input-forwarding
    events (click/type/key) pass straight through the other — all the
    actual logic lives in browser-worker's own SessionManager."""

    try:
        _owned_attempt(db, application_id=application_id, attempt_id=attempt_id, user_id=user_id)
    except HTTPException:
        await websocket.close(code=4404)
        return

    await websocket.accept()
    worker_ws_url = BROWSER_WORKER_URL.replace("http://", "ws://").replace("https://", "wss://")
    try:
        async with websockets.connect(f"{worker_ws_url}/sessions/{session_id}/screencast") as upstream:

            async def pump_frames() -> None:
                async for frame in upstream:
                    if isinstance(frame, (bytes, bytearray)):
                        await websocket.send_bytes(frame)

            frames_task = asyncio.create_task(pump_frames())
            try:
                while True:
                    message = await websocket.receive_text()
                    await upstream.send(message)
            except WebSocketDisconnect:
                pass
            finally:
                frames_task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await frames_task
    except (OSError, websockets.exceptions.WebSocketException):
        with contextlib.suppress(RuntimeError):
            await websocket.close(code=1011)
