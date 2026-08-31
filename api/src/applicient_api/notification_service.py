"""M5 F8.7 — in-app notifications only for this pass. `Notification.channel`
is always written as "in_app"; email/Telegram/Discord delivery is a
deliberately deferred fast-follow — the column already supports those
values, no schema change needed to add them later.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy.orm import Session

from applicient_api.models.enums import NotificationChannel
from applicient_api.models.notifications import Notification


def create_notification(
    session: Session, *, user_id: uuid.UUID, subject: str, body: str | None = None,
    related_type: str | None = None, related_id: uuid.UUID | None = None,
) -> Notification:
    notification = Notification(
        user_id=user_id,
        channel=NotificationChannel.IN_APP.value,
        subject=subject,
        body=body,
        related_type=related_type,
        related_id=related_id,
        sent_at=datetime.now(timezone.utc),
    )
    session.add(notification)
    session.flush()
    return notification


def list_notifications(session: Session, *, user_id: uuid.UUID, unread_only: bool = False) -> list[Notification]:
    query = session.query(Notification).filter_by(user_id=user_id)
    if unread_only:
        query = query.filter(Notification.read_at.is_(None))
    return query.order_by(Notification.created_at.desc()).limit(200).all()


def unread_count(session: Session, *, user_id: uuid.UUID) -> int:
    return session.query(Notification).filter_by(user_id=user_id).filter(Notification.read_at.is_(None)).count()


def mark_read(session: Session, *, user_id: uuid.UUID, notification_id: uuid.UUID) -> Notification | None:
    notification = session.query(Notification).filter_by(id=notification_id, user_id=user_id).one_or_none()
    if notification is None:
        return None
    notification.read_at = datetime.now(timezone.utc)
    session.flush()
    return notification
