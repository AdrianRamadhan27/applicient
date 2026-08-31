"""M5 F8.8 — one .ics VEVENT built from an EmailMessage's own
extracted_data (email_ingestion.py's `_extract`). `date`/`time` are
free-text from LLM extraction, not a guaranteed format — parsed
best-effort via dateutil, same discipline as scheduler.py's deadline
parsing; a message with no usable date raises ValueError rather than
producing a bogus all-day event, since a calendar entry on the wrong
day is worse than no calendar entry.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

from dateutil import parser as date_parser
from icalendar import Calendar, Event

from applicient_api.models.email import EmailMessage

DEFAULT_DURATION_MINUTES = 60


def build_ics(email_message: EmailMessage) -> bytes:
    data = email_message.extracted_data or {}
    date_str = data.get("date")
    if not date_str:
        raise ValueError("this email has no extracted date to build a calendar event from")

    combined = f"{date_str} {data.get('time') or ''}".strip()
    try:
        start = date_parser.parse(combined, fuzzy=True)
    except (ValueError, OverflowError) as exc:
        raise ValueError(f"could not parse a date/time from {combined!r}") from exc
    if start.tzinfo is None:
        start = start.replace(tzinfo=timezone.utc)

    duration = timedelta(minutes=data.get("duration_minutes") or DEFAULT_DURATION_MINUTES)

    cal = Calendar()
    cal.add("prodid", "-//Applicient//email-ingestion//EN")
    cal.add("version", "2.0")

    event = Event()
    event.add("uid", f"{email_message.gmail_message_id}@applicient")
    event.add("summary", email_message.subject or "Application event")
    event.add("dtstart", start)
    event.add("dtend", start + duration)
    event.add("dtstamp", datetime.now(timezone.utc))

    location = data.get("meeting_link") or data.get("format")
    if location:
        event.add("location", location)

    description_lines = []
    if data.get("interviewer_names"):
        description_lines.append("With: " + ", ".join(data["interviewer_names"]))
    if email_message.snippet:
        description_lines.append(email_message.snippet)
    if description_lines:
        event.add("description", "\n\n".join(description_lines))

    cal.add_component(event)
    return cal.to_ical()
