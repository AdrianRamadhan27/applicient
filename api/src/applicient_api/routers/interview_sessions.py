"""Phase 11 (v2 plan) — interview/FGD/LGD practice REST surface. Same
EventSourceResponse/SSE convention as routers/orchestrator.py for the
two streaming endpoints (thin route: ownership + validation, then hand
off to interview_service.py); everything else is plain REST."""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi.responses import Response
from sqlalchemy.orm import Session
from sse_starlette.sse import EventSourceResponse

from applicient_agents.interview_service import (
    InterviewServiceError,
    end_interview_session,
    start_interview_session,
    submit_turn,
)

from applicient_api import schemas
from applicient_api.deps import current_user_id, get_db, get_session_factory
from applicient_api.models.agents import AgentRun, RunEvent
from applicient_api.models.discovery import Job
from applicient_api.models.interview import InterviewSession
from applicient_api.models.pipeline import Application
from applicient_api.object_storage import delete_prefix, get_object

router = APIRouter(prefix="/interview-sessions", tags=["interview-sessions"])

# Every turn's audio is stored as a WAV now (interview_service.py's
# own _synthesize_stream_and_store wraps the streamed PCM into one at
# the end of a turn) — mp3/ogg/flac kept here regardless so a filename
# from before the streaming rewrite still serves back with the right
# header instead of silently mislabeled as mpeg.
_AUDIO_EXT_MEDIA_TYPES = {"mp3": "audio/mpeg", "wav": "audio/wav", "ogg": "audio/ogg", "flac": "audio/flac"}


def _owned_session(db: Session, session_id: uuid.UUID, user_id: uuid.UUID) -> InterviewSession:
    session_row = db.query(InterviewSession).filter_by(id=session_id, user_id=user_id).one_or_none()
    if session_row is None:
        raise HTTPException(404, "interview session not found")
    return session_row


@router.post("", status_code=201)
def create_interview_session(
    body: schemas.InterviewSessionCreate, db: Session = Depends(get_db), user_id: uuid.UUID = Depends(current_user_id)
) -> EventSourceResponse:
    """Creates the session row and immediately streams its opening turn
    (the agent's first question) — `{"event": "stage" | "message" |
    "done" | "error", "data": "<json>"}`."""

    if body.practice_type not in schemas.INTERVIEW_PRACTICE_TYPES:
        raise HTTPException(422, f"invalid practice_type: {body.practice_type!r}")
    if body.category is not None and body.category not in schemas.INTERVIEW_CATEGORIES:
        raise HTTPException(422, f"invalid category: {body.category!r}")
    if not body.job_id and not body.role_title and not body.company_name:
        raise HTTPException(422, "at least one of job_id, role_title, or company_name is required")

    role_title = body.role_title
    company_name = body.company_name
    if body.application_id is not None:
        app = db.query(Application).filter_by(id=body.application_id, user_id=user_id).one_or_none()
        if app is None:
            raise HTTPException(422, f"application {body.application_id} not found")
        job_id = body.job_id or app.job_id
    else:
        job_id = body.job_id

    if job_id is not None:
        job = db.query(Job).filter_by(id=job_id, user_id=user_id).one_or_none()
        if job is None:
            raise HTTPException(422, f"job {job_id} not found")
        # Denormalized onto the row at creation, not re-joined live —
        # one real source of truth going forward, same reasoning
        # CalendarEvent's router derives job_id from application_id.
        role_title = job.title
        company_name = job.company_name_raw

    session_row = InterviewSession(
        user_id=user_id,
        persona_id=body.persona_id,
        job_id=job_id,
        application_id=body.application_id,
        role_title=role_title,
        company_name=company_name,
        seniority=body.seniority,
        practice_type=body.practice_type,
        category=body.category,
        thread_id=str(uuid.uuid4()),
        status="in_progress",
    )
    db.add(session_row)
    db.commit()
    db.refresh(session_row)

    # The generator's own events never carry the session id (start_interview_session
    # is also reused by /{id}/start, which is called against an id the
    # caller already has) — the frontend needs it up front here to know
    # where to POST later turns, so it rides along as a plain response
    # header rather than a bespoke first SSE frame.
    return EventSourceResponse(
        start_interview_session(get_session_factory(), session_id=session_row.id, user_id=user_id),
        headers={"X-Interview-Session-Id": str(session_row.id)},
    )


@router.post("/{session_id}/start")
def start_session(
    session_id: uuid.UUID, db: Session = Depends(get_db), user_id: uuid.UUID = Depends(current_user_id)
) -> EventSourceResponse:
    """Kicks off the opening turn for a session that was created WITHOUT
    one already running — the Assistant's `start_interview_practice`
    tool creates the plain row only (a synchronous tool call can't
    drive an SSE stream), so the dedicated page calls this once, on
    first open, to actually start the conversation. `create_interview_session`
    above already does both steps in one call for the page's own "New
    practice" form, so this only ever needs calling for a session that
    has no events yet — calling it again on one that's already started
    would kick off a second, redundant opening turn."""

    session_row = _owned_session(db, session_id, user_id)
    if session_row.status != "in_progress":
        raise HTTPException(422, f"this session is already {session_row.status}")
    return EventSourceResponse(start_interview_session(get_session_factory(), session_id=session_id, user_id=user_id))


@router.get("", response_model=list[schemas.InterviewSessionOut])
def list_interview_sessions(
    persona_id: uuid.UUID | None = None,
    db: Session = Depends(get_db),
    user_id: uuid.UUID = Depends(current_user_id),
):
    query = db.query(InterviewSession).filter_by(user_id=user_id)
    if persona_id is not None:
        query = query.filter_by(persona_id=persona_id)
    return query.order_by(InterviewSession.created_at.desc()).all()


@router.get("/{session_id}", response_model=schemas.InterviewSessionOut)
def get_interview_session(
    session_id: uuid.UUID, db: Session = Depends(get_db), user_id: uuid.UUID = Depends(current_user_id)
):
    return _owned_session(db, session_id, user_id)


@router.post("/{session_id}/turns")
async def post_turn(
    session_id: uuid.UUID,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    user_id: uuid.UUID = Depends(current_user_id),
) -> EventSourceResponse:
    """One recorded answer -> the agent's next turn. Same event shape
    as session creation, plus a `transcribing`/`synthesizing` stage
    pair around the `agent` one."""

    _owned_session(db, session_id, user_id)
    audio_bytes = await file.read()
    if not audio_bytes:
        raise HTTPException(422, "empty audio upload")
    return EventSourceResponse(
        submit_turn(
            get_session_factory(),
            session_id=session_id,
            user_id=user_id,
            audio_bytes=audio_bytes,
            filename=file.filename or "answer.webm",
            content_type=file.content_type or "audio/webm",
        )
    )


@router.post("/{session_id}/end", response_model=schemas.InterviewSessionOut)
async def end_session(
    session_id: uuid.UUID, db: Session = Depends(get_db), user_id: uuid.UUID = Depends(current_user_id)
):
    _owned_session(db, session_id, user_id)
    try:
        return await end_interview_session(get_session_factory(), session_id=session_id, user_id=user_id)
    except InterviewServiceError as exc:
        raise HTTPException(422, str(exc))


@router.get("/{session_id}/events", response_model=schemas.InterviewSessionEventsOut)
def list_session_events(
    session_id: uuid.UUID, db: Session = Depends(get_db), user_id: uuid.UUID = Depends(current_user_id)
):
    session_row = _owned_session(db, session_id, user_id)
    events = (
        db.query(RunEvent)
        .join(AgentRun, AgentRun.id == RunEvent.agent_run_id)
        .filter(AgentRun.interview_session_id == session_id)
        .order_by(RunEvent.created_at, RunEvent.seq)
        .all()
    )
    return schemas.InterviewSessionEventsOut(
        status=session_row.status,
        events=[schemas.InterviewSessionEventOut.model_validate(e) for e in events],
    )


@router.delete("/{session_id}", status_code=204)
def delete_interview_session(
    session_id: uuid.UUID, db: Session = Depends(get_db), user_id: uuid.UUID = Depends(current_user_id)
):
    """Deletes a past practice session for real — its full transcript
    history (every RunEvent under every AgentRun this session ever
    drove, not just the summary row) and its stored turn audio, so
    nothing lingers once it's gone from the list. Cost-ledger rows
    (LlmCall) are deliberately left alone — same "billing history
    outlives the thing that generated it" precedent AgentRun's own
    interview_session_id column already sets (ondelete=SET NULL, not
    CASCADE) elsewhere; deleting a practice session doesn't
    retroactively erase what it already cost."""

    session_row = _owned_session(db, session_id, user_id)
    run_ids = [r.id for r in db.query(AgentRun.id).filter_by(interview_session_id=session_id).all()]
    if run_ids:
        db.query(RunEvent).filter(RunEvent.agent_run_id.in_(run_ids)).delete(synchronize_session=False)
        db.query(AgentRun).filter(AgentRun.id.in_(run_ids)).delete(synchronize_session=False)
    db.delete(session_row)
    db.commit()
    try:
        delete_prefix(f"interview-audio/{session_id}/")
    except Exception:
        # The DB deletion (the source of truth for "does this session
        # still exist") already succeeded — a storage hiccup here just
        # leaves orphaned objects in the bucket, not a broken session
        # or a confusing error on an otherwise-successful delete.
        pass


@router.get("/{session_id}/audio/{filename}")
def get_turn_audio(
    session_id: uuid.UUID, filename: str, db: Session = Depends(get_db), user_id: uuid.UUID = Depends(current_user_id)
):
    """Serves one synthesized turn's audio back — object_storage has no
    presigned-URL path in this codebase (routers/applications.py's own
    document-download endpoints are the precedent: a direct server-side
    proxy), so this mirrors that exactly rather than inventing a new
    access pattern. `filename` is never trusted as an arbitrary key —
    only ever the last path segment of a key this same session already
    wrote (interview_service.py's own `{session_id}/{uuid}.mp3`
    convention), reconstructed here, not accepted as a full path."""

    _owned_session(db, session_id, user_id)
    key = f"interview-audio/{session_id}/{filename}"
    try:
        content = get_object(key)
    except Exception:
        raise HTTPException(404, "audio not found")
    # interview_media.synthesize() derives the real extension from the
    # provider's actual response (mp3 vs wav — confirmed live both
    # happen depending on provider/model), so the extension on this
    # already-stored filename is trustworthy; media_type follows it
    # instead of assuming mp3 always.
    ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    media_type = _AUDIO_EXT_MEDIA_TYPES.get(ext, "audio/mpeg")
    return Response(content=content, media_type=media_type)
