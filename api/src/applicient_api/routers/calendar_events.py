"""Phase 9 (v2 plan) — CalendarEvent CRUD. Manual creation is the
only writer in this router; the auto-created rows email_ingestion.py
adds when it detects an interview/assessment email show up through
the same list, nothing special about them here."""

import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from applicient_api import schemas
from applicient_api.deps import current_user_id, get_db
from applicient_api.models.calendar import CalendarEvent
from applicient_api.models.discovery import Job
from applicient_api.models.pipeline import Application

router = APIRouter(prefix="/calendar-events", tags=["calendar-events"])


def _validate_event_type(event_type: str) -> None:
    if event_type not in schemas.CALENDAR_EVENT_TYPES:
        raise HTTPException(422, f"invalid event_type: {event_type!r}")


def _owned_application(db: Session, application_id: uuid.UUID, user_id: uuid.UUID) -> Application:
    app = db.query(Application).filter_by(id=application_id, user_id=user_id).one_or_none()
    if app is None:
        raise HTTPException(422, f"application {application_id} not found")
    return app


def _owned_job(db: Session, job_id: uuid.UUID, user_id: uuid.UUID) -> None:
    if db.query(Job.id).filter_by(id=job_id, user_id=user_id).first() is None:
        raise HTTPException(422, f"job {job_id} not found")


def _to_out(event: CalendarEvent, *, job: Job | None) -> schemas.CalendarEventOut:
    out = schemas.CalendarEventOut.model_validate(event)
    if job is not None:
        out.job_title = job.title
        out.company_name = job.company_name_raw
    return out


def _jobs_by_id(db: Session, events: list[CalendarEvent]) -> dict[uuid.UUID, Job]:
    job_ids = {e.job_id for e in events if e.job_id}
    if not job_ids:
        return {}
    return {j.id: j for j in db.query(Job).filter(Job.id.in_(job_ids)).all()}


@router.get("", response_model=list[schemas.CalendarEventOut])
def list_calendar_events(db: Session = Depends(get_db), user_id: uuid.UUID = Depends(current_user_id)):
    events = db.query(CalendarEvent).filter_by(user_id=user_id).order_by(CalendarEvent.scheduled_at).all()
    jobs = _jobs_by_id(db, events)
    return [_to_out(e, job=jobs.get(e.job_id)) for e in events]


@router.post("", response_model=schemas.CalendarEventOut, status_code=201)
def create_calendar_event(
    body: schemas.CalendarEventCreate, db: Session = Depends(get_db), user_id: uuid.UUID = Depends(current_user_id)
):
    _validate_event_type(body.event_type)
    job_id = body.job_id
    if body.application_id is not None:
        app = _owned_application(db, body.application_id, user_id)
        # A manually-added event tied to an application but no explicit
        # job — derive job_id from the application so this event's job
        # title/company still resolve on the calendar view, same as the
        # email-detected ones do.
        job_id = job_id or app.job_id
    if job_id is not None:
        _owned_job(db, job_id, user_id)

    event = CalendarEvent(
        user_id=user_id,
        application_id=body.application_id,
        job_id=job_id,
        event_type=body.event_type,
        title=body.title,
        scheduled_at=body.scheduled_at,
        notes=body.notes,
    )
    db.add(event)
    db.commit()
    db.refresh(event)
    job = db.get(Job, job_id) if job_id else None
    return _to_out(event, job=job)


def _owned_event(db: Session, event_id: uuid.UUID, user_id: uuid.UUID) -> CalendarEvent:
    event = db.query(CalendarEvent).filter_by(id=event_id, user_id=user_id).one_or_none()
    if event is None:
        raise HTTPException(404, "calendar event not found")
    return event


@router.patch("/{event_id}", response_model=schemas.CalendarEventOut)
def update_calendar_event(
    event_id: uuid.UUID,
    body: schemas.CalendarEventUpdate,
    db: Session = Depends(get_db),
    user_id: uuid.UUID = Depends(current_user_id),
):
    event = _owned_event(db, event_id, user_id)
    updates = body.model_dump(exclude_unset=True)
    if "event_type" in updates:
        _validate_event_type(updates["event_type"])
    if "application_id" in updates:
        # job_id always follows application_id here (never edited
        # independently through this endpoint) — same derivation as
        # create, so the calendar view's job label stays consistent
        # with whichever application is actually linked.
        new_application_id = updates["application_id"]
        if new_application_id is not None:
            app = _owned_application(db, new_application_id, user_id)
            updates["job_id"] = app.job_id
        else:
            updates["job_id"] = None
    for field, value in updates.items():
        setattr(event, field, value)
    db.commit()
    db.refresh(event)
    job = db.get(Job, event.job_id) if event.job_id else None
    return _to_out(event, job=job)


@router.delete("/{event_id}", status_code=204)
def delete_calendar_event(
    event_id: uuid.UUID, db: Session = Depends(get_db), user_id: uuid.UUID = Depends(current_user_id)
):
    event = _owned_event(db, event_id, user_id)
    db.delete(event)
    db.commit()
