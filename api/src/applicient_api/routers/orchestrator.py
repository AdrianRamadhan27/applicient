"""M7 — the conversational orchestrator's REST surface. Same
EventSourceResponse/SSE convention as routers/applications.py for the
two streaming endpoints (thin route: ownership check, then hand off to
`orchestrator_service.py`); everything else is plain REST.
"""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from sse_starlette.sse import EventSourceResponse

from applicient_agents.orchestrator_service import (
    archive_conversation as _archive_conversation,
    create_conversation as _create_conversation,
    resume_message,
    send_message,
)

from applicient_api import schemas
from applicient_api.deps import current_user_id, get_db, get_session_factory
from applicient_api.models.agents import AgentRun, OrchestratorConversation, RunEvent

router = APIRouter(prefix="/orchestrator", tags=["orchestrator"])


def _owned_conversation(db: Session, conversation_id: uuid.UUID, user_id: uuid.UUID) -> OrchestratorConversation:
    convo = db.query(OrchestratorConversation).filter_by(id=conversation_id, user_id=user_id).one_or_none()
    if convo is None:
        raise HTTPException(404, "conversation not found")
    return convo


@router.post("/conversations", response_model=schemas.ConversationOut, status_code=201)
def create_conversation(
    body: schemas.ConversationCreate, db: Session = Depends(get_db), user_id: uuid.UUID = Depends(current_user_id)
) -> schemas.ConversationOut:
    """Always creates a genuinely new conversation — no idempotency
    (a real, deliberate change: an earlier version of this endpoint
    was idempotent per persona, which made "start a new chat" mean
    nothing once one already existed). The frontend's own initial page
    load is what resumes the most recent one by default, via the plain
    `GET /conversations` list below — this endpoint is "new chat," full
    stop."""

    convo = _create_conversation(get_session_factory(), persona_id=body.persona_id, user_id=user_id, title=body.title)
    return schemas.ConversationOut.model_validate(convo)


@router.get("/conversations", response_model=list[schemas.ConversationOut])
def list_conversations(
    persona_id: uuid.UUID | None = None,
    db: Session = Depends(get_db),
    user_id: uuid.UUID = Depends(current_user_id),
):
    query = db.query(OrchestratorConversation).filter_by(user_id=user_id)
    if persona_id is not None:
        query = query.filter_by(persona_id=persona_id)
    return query.order_by(OrchestratorConversation.last_active_at.desc()).all()


@router.get("/conversations/{conversation_id}", response_model=schemas.ConversationOut)
def get_conversation(
    conversation_id: uuid.UUID, db: Session = Depends(get_db), user_id: uuid.UUID = Depends(current_user_id)
):
    return _owned_conversation(db, conversation_id, user_id)


@router.post("/conversations/{conversation_id}/archive", response_model=schemas.ConversationOut)
def archive_conversation(
    conversation_id: uuid.UUID, db: Session = Depends(get_db), user_id: uuid.UUID = Depends(current_user_id)
):
    """Hides a conversation from the active list without deleting its
    history — the real escape hatch for one that's stuck on a decision
    the human doesn't want to make right now (a genuinely pending
    ask_user interrupt is still safe to leave archived; nothing times
    it out or requires it to be resolved)."""

    _owned_conversation(db, conversation_id, user_id)
    convo = _archive_conversation(get_session_factory(), conversation_id=conversation_id, user_id=user_id)
    if convo is None:
        raise HTTPException(404, "conversation not found")
    return convo


@router.post("/conversations/{conversation_id}/messages")
def post_message(
    conversation_id: uuid.UUID,
    body: schemas.MessageIn,
    db: Session = Depends(get_db),
    user_id: uuid.UUID = Depends(current_user_id),
) -> EventSourceResponse:
    """Streams `{"event": "stage" | "interrupt" | "done" | "error", "data": "<json>"}`
    — an ordinary chat turn. 409s inside the stream (as an `error`
    event, via orchestrator_service.py) if this conversation currently
    has a pending ask_user interrupt; resolve that via .../resume
    first, don't send a new message over it."""

    _owned_conversation(db, conversation_id, user_id)
    return EventSourceResponse(
        send_message(get_session_factory(), conversation_id=conversation_id, user_id=user_id, text=body.text)
    )


@router.post("/conversations/{conversation_id}/resume")
def post_resume(
    conversation_id: uuid.UUID,
    body: schemas.InterruptDecisionsIn,
    db: Session = Depends(get_db),
    user_id: uuid.UUID = Depends(current_user_id),
) -> EventSourceResponse:
    """Resolves the conversation's current pending ask_user interrupt.
    Same InterruptDecisionsIn/InterruptRequest shape applications.py's
    own resume endpoint uses — the orchestrator only ever gates one
    tool (ask_user), so this is always a one-item decisions list in
    practice, but the shape stays list-based for consistency."""

    _owned_conversation(db, conversation_id, user_id)
    decisions = [
        {"type": d.type, **({"message": d.message} if d.message is not None else {})} for d in body.decisions
    ]
    return EventSourceResponse(
        resume_message(get_session_factory(), conversation_id=conversation_id, user_id=user_id, decisions=decisions)
    )


@router.get("/conversations/{conversation_id}/events", response_model=schemas.ConversationEventsOut)
def list_conversation_events(
    conversation_id: uuid.UUID, db: Session = Depends(get_db), user_id: uuid.UUID = Depends(current_user_id)
):
    """Full replay, not incremental — a conversation spans many
    AgentRun rows (one per turn), so RunEvent's own per-run `seq` isn't
    a valid cross-conversation cursor, and the total event count here
    (turns x tens) is nowhere near radar's own since_seq-shaped volume
    that motivated incremental replay there. The frontend just
    re-renders the whole log from this on load/reconnect."""

    convo = _owned_conversation(db, conversation_id, user_id)
    events = (
        db.query(RunEvent)
        .join(AgentRun, AgentRun.id == RunEvent.agent_run_id)
        .filter(AgentRun.conversation_id == conversation_id)
        .order_by(RunEvent.created_at, RunEvent.seq)
        .all()
    )
    latest_run = (
        db.query(AgentRun)
        .filter(AgentRun.conversation_id == conversation_id)
        .order_by(AgentRun.started_at.desc())
        .first()
    )
    return schemas.ConversationEventsOut(
        status=convo.status,
        pending_interrupt=convo.pending_interrupt,
        run_status=latest_run.status if latest_run is not None else "completed",
        events=[schemas.ConversationEventOut.model_validate(e) for e in events],
    )
