"""M5 F8.4/F8.6 — read the ingested email log and confirm a
low-confidence proposed state transition. Ingestion itself
(email_ingestion.py) writes these rows; nothing here writes a new one.
"""

import re
import uuid

from fastapi import APIRouter, Depends, HTTPException, Response
from sqlalchemy.orm import Session

from applicient_api import ics_export, pipeline_service, schemas
from applicient_api.deps import current_user_id, get_db
from applicient_api.models.email import EmailMessage
from applicient_api.models.enums import EventActor
from applicient_api.models.pipeline import Application

router = APIRouter(prefix="/email-messages", tags=["email-messages"])


@router.get("", response_model=list[schemas.EmailMessageOut])
def list_email_messages(
    review_needed: bool | None = None,
    db: Session = Depends(get_db),
    user_id: uuid.UUID = Depends(current_user_id),
):
    query = db.query(EmailMessage).filter_by(user_id=user_id)
    if review_needed is not None:
        query = query.filter_by(review_needed=review_needed)
    return query.order_by(EmailMessage.received_at.desc()).limit(200).all()


@router.post("/{email_message_id}/confirm-transition", response_model=schemas.EmailMessageOut)
def confirm_transition(
    email_message_id: uuid.UUID,
    body: schemas.EmailTransitionConfirm,
    db: Session = Depends(get_db),
    user_id: uuid.UUID = Depends(current_user_id),
):
    """F8.6 — approves a transition email_ingestion.py proposed but
    didn't apply (low confidence, or an illegal jump from the current
    state). Rejecting just clears review_needed without transitioning —
    the email stays on record either way."""

    msg = db.query(EmailMessage).filter_by(id=email_message_id, user_id=user_id).one_or_none()
    if msg is None:
        raise HTTPException(404, "email message not found")
    if not msg.review_needed:
        raise HTTPException(409, "this email has no pending review")

    if body.approve:
        if msg.matched_application_id is None or not body.new_state:
            raise HTTPException(422, "no matched application or proposed state to apply")
        application = db.get(Application, msg.matched_application_id)
        if application is None or application.user_id != user_id:
            raise HTTPException(404, "matched application not found")
        try:
            pipeline_service.transition(
                db, application=application, new_state=body.new_state, actor=EventActor.USER.value,
                note=f"confirmed from email {msg.gmail_message_id}",
            )
        except pipeline_service.TransitionError as exc:
            raise HTTPException(409, str(exc))

    msg.review_needed = False
    db.commit()
    db.refresh(msg)
    return msg


@router.get("/{email_message_id}/ics")
def download_ics(email_message_id: uuid.UUID, db: Session = Depends(get_db), user_id: uuid.UUID = Depends(current_user_id)):
    msg = db.query(EmailMessage).filter_by(id=email_message_id, user_id=user_id).one_or_none()
    if msg is None:
        raise HTTPException(404, "email message not found")
    try:
        ics_bytes = ics_export.build_ics(msg)
    except ValueError as exc:
        raise HTTPException(422, str(exc))
    filename = re.sub(r"[^\w.-]+", "_", msg.subject or "event")[:80] + ".ics"
    return Response(
        content=ics_bytes, media_type="text/calendar",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
