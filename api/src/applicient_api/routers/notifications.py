"""M5 F8.7 — read/mark-read the in-app notification list.
notification_service.py is the only writer; nothing here creates one."""

import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from applicient_api import notification_service, schemas
from applicient_api.deps import current_user_id, get_db

router = APIRouter(prefix="/notifications", tags=["notifications"])


@router.get("", response_model=list[schemas.NotificationOut])
def list_notifications(
    unread_only: bool = False, db: Session = Depends(get_db), user_id: uuid.UUID = Depends(current_user_id)
):
    return notification_service.list_notifications(db, user_id=user_id, unread_only=unread_only)


@router.get("/unread-count")
def get_unread_count(db: Session = Depends(get_db), user_id: uuid.UUID = Depends(current_user_id)):
    return {"count": notification_service.unread_count(db, user_id=user_id)}


@router.post("/{notification_id}/read", response_model=schemas.NotificationOut)
def mark_read(notification_id: uuid.UUID, db: Session = Depends(get_db), user_id: uuid.UUID = Depends(current_user_id)):
    notification = notification_service.mark_read(db, user_id=user_id, notification_id=notification_id)
    if notification is None:
        raise HTTPException(404, "notification not found")
    db.commit()
    db.refresh(notification)
    return notification
