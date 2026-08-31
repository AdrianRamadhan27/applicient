"""M5 F8.3-F8.6/F9.2 — Gmail message ingestion, classification,
matching, and confidence-gated state transitions.

Simplification from the original design: this build always re-lists
matching messages (`users.messages.list`) rather than using Gmail's
`users.history.list` delta API — `history_id` tracking/resync-on-expiry
is real added complexity for an efficiency gain only, and correctness
doesn't depend on it: every message is still deduped by
`gmail_message_id`'s unique constraint before any processing happens,
so a re-list is wasted API calls, not wrong results. Worth revisiting
once ingestion volume actually matters.

Scope boundary, reversed from the original F8.2 design: this no longer
gates on a manually-applied Gmail label (raised directly — nobody
wants to hand-label every application email as it arrives). See
`_KEYWORD_QUERY` below for the real mechanism now: a keyword-OR search
run server-side by Gmail itself, acting as a free prefilter before any
message is even fetched. `GmailConnection.label_name` is unused by
ingestion as of this change — kept in the schema rather than migrated
away, but vestigial.

`GmailIngestor.poll()` (scheduler-driven) and `.handle_push()`
(webhook-driven, routers/webhooks.py) both funnel into the same
`sync_new_messages` core — F8.1's "two adapters, one interface" for
real, not just in name.
"""

from __future__ import annotations

import base64
import re
import uuid
from asyncio import to_thread
from datetime import datetime, timezone
from typing import Literal

import httpx
from pydantic import BaseModel
from sqlalchemy.orm import Session, sessionmaker

from applicient_api import gmail_service, notification_service, pipeline_service, pipeline_stage_service
from applicient_api.gmail_service import GMAIL_API_ROOT
from applicient_api.llm_retry import invoke_structured_with_retry
from applicient_api.models.discovery import Job
from applicient_api.models.email import EmailMessage
from applicient_api.models.enums import ApplicationState, EmailClassification, EventActor, LedgerSource
from applicient_api.models.gmail import GmailConnection
from applicient_api.models.pipeline import Application, ApplicationEvent, AppliedLedgerEntry
from applicient_api.tier_resolution import resolve_tier

# Tunable, not hardcoded product law (no numeric value was specified
# in the PRD excerpt this milestone was built from) — a real product
# decision to revisit once there's enough real ingested mail to tune
# against actual false-positive/negative rates.
MATCH_THRESHOLD = 0.5
AUTO_APPLY_THRESHOLD = 0.75

_CLASSIFICATION_TO_STATE: dict[str, str] = {
    EmailClassification.CONFIRMATION.value: ApplicationState.ACKNOWLEDGED.value,
    EmailClassification.REJECTION.value: ApplicationState.REJECTED.value,
    EmailClassification.INTERVIEW_INVITE.value: ApplicationState.INTERVIEW.value,
    EmailClassification.ASSESSMENT_INVITE.value: ApplicationState.ASSESSMENT.value,
    EmailClassification.OFFER.value: ApplicationState.OFFER.value,
}
_EXTRACTION_CLASSIFICATIONS = {
    EmailClassification.INTERVIEW_INVITE.value,
    EmailClassification.ASSESSMENT_INVITE.value,
    EmailClassification.SCHEDULING_REQUEST.value,
}
# F8.7 — interview invites, assessments/psychotests, and offers get an
# in-app notification; rejection/confirmation/etc. don't (per the
# PRD's own F8.7 list, not an oversight).
_NOTIFY_CLASSIFICATIONS: dict[str, str] = {
    EmailClassification.INTERVIEW_INVITE.value: "Interview invite",
    EmailClassification.ASSESSMENT_INVITE.value: "Assessment invite",
    EmailClassification.OFFER.value: "Offer",
}


class EmailClassificationOutput(BaseModel):
    classification: Literal[
        "confirmation",
        "rejection",
        "interview_invite",
        "assessment_invite",
        "offer",
        "recruiter_outreach",
        "scheduling_request",
        "information_request",
        "irrelevant",
    ]
    confidence: float


class EmailExtractionOutput(BaseModel):
    date: str | None = None
    time: str | None = None
    timezone: str | None = None
    duration_minutes: int | None = None
    meeting_link: str | None = None
    interviewer_names: list[str] = []
    format: str | None = None
    deadline: str | None = None


_CLASSIFY_SYSTEM_PROMPT = (
    "You classify a job application-related email into exactly one category. "
    "Categories: confirmation (application received acknowledgment), rejection, "
    "interview_invite, assessment_invite (a test/assignment/psychometric task), "
    "offer, recruiter_outreach (unsolicited recruiter contact), "
    "scheduling_request (asks to pick/confirm a time), "
    "information_request (asks the candidate for more info/documents), "
    "irrelevant (not actually about a job application). "
    "Give a confidence between 0 and 1."
)
_EXTRACT_SYSTEM_PROMPT = (
    "Extract scheduling/event details from this job application email, if present. "
    "Leave any field null/empty if it isn't mentioned — never guess a date or time "
    "that isn't actually stated in the text."
)


def _decode_b64url(data: str) -> str:
    padded = data + "=" * (-len(data) % 4)
    return base64.urlsafe_b64decode(padded).decode("utf-8", errors="replace")


def _extract_body_text(payload: dict) -> str:
    mime_type = payload.get("mimeType", "")
    body_data = payload.get("body", {}).get("data")
    if mime_type == "text/plain" and body_data:
        return _decode_b64url(body_data)
    for part in payload.get("parts", []):
        text = _extract_body_text(part)
        if text:
            return text
    if mime_type == "text/html" and body_data:
        html = _decode_b64url(body_data)
        return re.sub(r"<[^>]+>", " ", html)
    return ""


def _header(headers: list[dict], name: str) -> str | None:
    for h in headers:
        if h.get("name", "").lower() == name.lower():
            return h.get("value")
    return None


async def _fetch_message(access_token: str, message_id: str) -> dict:
    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.get(
            f"{GMAIL_API_ROOT}/messages/{message_id}",
            headers={"Authorization": f"Bearer {access_token}"},
            params={"format": "full"},
        )
    resp.raise_for_status()
    return resp.json()


# Reversal of the original F8.2 "one manually-applied label" scope
# gate, raised directly: manual labeling was a real adoption blocker —
# nobody wants to hand-label every application email as it arrives.
# This is the actual scope boundary now: a keyword-OR search run
# server-side by Gmail itself (not a local regex pass over fetched
# mail — nothing outside this set is ever even downloaded), acting as
# a free, zero-LLM-cost prefilter. Real classification (irrelevant
# included) still happens via the LLM step below — this list is
# deliberately broad/over-inclusive, a false-positive here just costs
# one cheap "fast" tier classification call, not a wrong action.
_KEYWORD_QUERY = (
    '("your application" OR "application received" OR "thank you for applying" OR interview OR '
    '"next steps" OR assessment OR "coding challenge" OR "take-home" OR recruiter OR "hiring team" OR '
    'offer OR "we regret" OR "not moving forward" OR "other candidates" OR "background check" OR '
    'onboarding OR "schedule a call" OR "phone screen") -in:spam -in:trash'
)
# A defensive backstop, not the real boundary — `newer_than:{days}d`
# (GmailConnection.scan_window_days) is what actually bounds a sync.
# Bumped well above the old flat 50 now that the date window is doing
# the real limiting.
_MAX_RESULTS = 200


async def _list_message_ids(access_token: str, scan_window_days: int) -> list[str]:
    query = f"{_KEYWORD_QUERY} newer_than:{scan_window_days}d"
    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.get(
            f"{GMAIL_API_ROOT}/messages",
            headers={"Authorization": f"Bearer {access_token}"},
            params={"q": query, "maxResults": _MAX_RESULTS},
        )
    resp.raise_for_status()
    return [m["id"] for m in resp.json().get("messages", [])]


def _text_overlap_score(text: str, company_name: str, title: str) -> float:
    score = 0.0
    company_l = company_name.lower().strip()
    if company_l and company_l in text:
        score += 0.7
    title_tokens = {t for t in re.findall(r"[a-z0-9]+", title.lower()) if len(t) > 2}
    if title_tokens:
        matched = sum(1 for t in title_tokens if t in text)
        score += 0.3 * (matched / len(title_tokens))
    return min(score, 1.0)


def _match_application(session: Session, *, user_id: uuid.UUID, email_msg: EmailMessage) -> tuple[Application | None, float]:
    """F8.4 — thread continuity (a reply in an already-matched thread
    wins outright) beats fuzzy company/role text matching. Never
    guesses: caller treats anything below MATCH_THRESHOLD as
    unmatched, not a low-confidence guess."""

    if email_msg.thread_id:
        prior = (
            session.query(EmailMessage)
            .filter(
                EmailMessage.user_id == user_id,
                EmailMessage.thread_id == email_msg.thread_id,
                EmailMessage.matched_application_id.isnot(None),
                EmailMessage.id != email_msg.id,
            )
            .order_by(EmailMessage.received_at.desc())
            .first()
        )
        if prior is not None:
            app = session.get(Application, prior.matched_application_id)
            if app is not None:
                return app, 0.95

    text = f"{email_msg.subject or ''} {email_msg.snippet or ''}".lower()
    candidates = session.query(Application, Job).join(Job, Job.id == Application.job_id).filter(Application.user_id == user_id).all()
    best_app, best_score = None, 0.0
    for app, job in candidates:
        score = _text_overlap_score(text, job.company_name_raw, job.title)
        if score > best_score:
            best_app, best_score = app, score
    return (best_app, best_score) if best_app is not None else (None, 0.0)


def _classify(session: Session, session_factory: sessionmaker, *, user_id: uuid.UUID, subject: str, body: str) -> EmailClassificationOutput:
    model = resolve_tier(session, user_id=user_id, tier="fast", stage="email_classification", session_factory=session_factory)
    structured = model.with_structured_output(EmailClassificationOutput)
    result = invoke_structured_with_retry(
        structured, [("system", _CLASSIFY_SYSTEM_PROMPT), ("user", f"SUBJECT: {subject}\n\nBODY:\n{body[:4000]}")]
    )
    if not isinstance(result, EmailClassificationOutput):
        raise RuntimeError(f"email classification returned unexpected type: {type(result)}")
    return result


def _extract(session: Session, session_factory: sessionmaker, *, user_id: uuid.UUID, subject: str, body: str) -> EmailExtractionOutput:
    model = resolve_tier(session, user_id=user_id, tier="balanced", stage="email_extraction", session_factory=session_factory)
    structured = model.with_structured_output(EmailExtractionOutput)
    result = invoke_structured_with_retry(
        structured, [("system", _EXTRACT_SYSTEM_PROMPT), ("user", f"SUBJECT: {subject}\n\nBODY:\n{body[:4000]}")]
    )
    if not isinstance(result, EmailExtractionOutput):
        raise RuntimeError(f"email extraction returned unexpected type: {type(result)}")
    return result


async def _process_message(
    session: Session, session_factory: sessionmaker, *, user_id: uuid.UUID, email_msg: EmailMessage, body: str,
    valid_stage_keys: set[str],
) -> None:
    subject = email_msg.subject or ""
    classification_result = await to_thread(_classify, session, session_factory, user_id=user_id, subject=subject, body=body)
    email_msg.classification = classification_result.classification

    if classification_result.classification == EmailClassification.IRRELEVANT.value:
        # The keyword prefilter is deliberately broad (real inbox mail
        # matches on common words with no actual job-application
        # connection) — an "irrelevant" verdict means there's nothing
        # to match or review, not an unmatched-but-real application
        # email. Record and stop, don't flood the review queue.
        email_msg.processed_at = datetime.now(timezone.utc)
        session.flush()
        return

    app, match_confidence = _match_application(session, user_id=user_id, email_msg=email_msg)
    email_msg.match_confidence = match_confidence

    if app is None or match_confidence < MATCH_THRESHOLD:
        email_msg.review_needed = True
        email_msg.processed_at = datetime.now(timezone.utc)
        session.flush()
        return

    email_msg.matched_application_id = app.id

    if classification_result.classification in _EXTRACTION_CLASSIFICATIONS:
        extraction = await to_thread(_extract, session, session_factory, user_id=user_id, subject=subject, body=body)
        email_msg.extracted_data = extraction.model_dump(exclude_none=True)

    new_state = _CLASSIFICATION_TO_STATE.get(classification_result.classification)
    if new_state and new_state not in valid_stage_keys:
        # The user has renamed/deleted this well-known stage — nothing
        # a real target to propose. Still classified/matched/notified
        # above, just no doomed state-change proposal (one that would
        # 409 on every confirm attempt since the key doesn't exist).
        new_state = None
    high_confidence = match_confidence >= AUTO_APPLY_THRESHOLD and classification_result.confidence >= AUTO_APPLY_THRESHOLD

    if new_state and high_confidence:
        try:
            pipeline_service.transition(
                session, application=app, new_state=new_state, actor=EventActor.EMAIL.value,
                note=f"from email {email_msg.gmail_message_id}",
            )
        except pipeline_service.TransitionError as exc:
            email_msg.review_needed = True
            session.add(ApplicationEvent(
                application_id=app.id, actor=EventActor.EMAIL.value, event_type="email_matched",
                payload={
                    "proposed_state": new_state, "email_message_id": email_msg.gmail_message_id,
                    "needs_confirmation": True, "reason": str(exc),
                },
                occurred_at=datetime.now(timezone.utc),
            ))
    elif new_state:
        # Classified with a real proposed transition but not confident
        # enough to auto-apply — queued for the human to confirm
        # (F8.6), not applied and not dropped.
        email_msg.review_needed = True
        session.add(ApplicationEvent(
            application_id=app.id, actor=EventActor.EMAIL.value, event_type="email_matched",
            payload={
                "proposed_state": new_state, "email_message_id": email_msg.gmail_message_id,
                "needs_confirmation": True,
            },
            occurred_at=datetime.now(timezone.utc),
        ))

    if classification_result.classification == EmailClassification.CONFIRMATION.value and high_confidence:
        job = session.get(Job, app.job_id)
        session.add(AppliedLedgerEntry(
            user_id=user_id, company_name=job.company_name_raw if job else "", role_title=job.title if job else "",
            source=LedgerSource.EMAIL_DERIVED.value, matched_application_id=app.id,
        ))

    if classification_result.classification in _NOTIFY_CLASSIFICATIONS:
        job = session.get(Job, app.job_id)
        job_label = f"{job.title} at {job.company_name_raw}" if job else "an application"
        notification_service.create_notification(
            session, user_id=user_id,
            subject=f"{_NOTIFY_CLASSIFICATIONS[classification_result.classification]}: {job_label}",
            body=subject, related_type="application", related_id=app.id,
        )

    email_msg.processed_at = datetime.now(timezone.utc)
    session.flush()


async def sync_new_messages(session_factory: sessionmaker, connection_id: uuid.UUID) -> int:
    """The one shared core both the polling job and the push webhook
    call. Returns the count of newly-ingested messages."""

    with session_factory() as session:
        conn = session.get(GmailConnection, connection_id)
        if conn is None:
            return 0
        try:
            access_token = await gmail_service.get_valid_access_token(conn)
            message_ids = await _list_message_ids(access_token, conn.scan_window_days)
        except (gmail_service.GmailOAuthError, httpx.HTTPStatusError, httpx.RequestError) as exc:
            conn.status = "auth_failed" if isinstance(exc, gmail_service.GmailOAuthError) else "unreachable"
            conn.last_error = str(exc)
            session.commit()
            return 0

        existing_ids = {
            row[0]
            for row in session.query(EmailMessage.gmail_message_id).filter(EmailMessage.gmail_message_id.in_(message_ids)).all()
        }
        new_ids = [m for m in message_ids if m not in existing_ids]

        # Fetched once per batch (every message in this sync belongs to
        # the same conn.user_id), not per-message.
        valid_stage_keys = pipeline_stage_service.get_stage_keys(session, user_id=conn.user_id)

        new_count = 0
        for message_id in new_ids:
            try:
                raw = await _fetch_message(access_token, message_id)
            except (httpx.HTTPStatusError, httpx.RequestError):
                continue
            headers = raw.get("payload", {}).get("headers", [])
            received_at = datetime.fromtimestamp(int(raw["internalDate"]) / 1000, tz=timezone.utc)
            email_msg = EmailMessage(
                user_id=conn.user_id,
                gmail_message_id=raw["id"],
                thread_id=raw.get("threadId"),
                subject=_header(headers, "Subject"),
                snippet=raw.get("snippet"),
                received_at=received_at,
            )
            session.add(email_msg)
            session.flush()
            body = _extract_body_text(raw.get("payload", {})) or raw.get("snippet", "")
            await _process_message(
                session, session_factory, user_id=conn.user_id, email_msg=email_msg, body=body,
                valid_stage_keys=valid_stage_keys,
            )
            new_count += 1

        conn.status = "ok"
        conn.last_error = None
        conn.last_synced_at = datetime.now(timezone.utc)
        session.commit()
        return new_count


class GmailIngestor:
    """F8.1 — two adapters, one interface."""

    @staticmethod
    async def poll(session_factory: sessionmaker, connection_id: uuid.UUID) -> int:
        return await sync_new_messages(session_factory, connection_id)

    @staticmethod
    async def handle_push(session_factory: sessionmaker, *, google_email: str) -> int:
        with session_factory() as session:
            conn = session.query(GmailConnection).filter_by(google_email=google_email).one_or_none()
            if conn is None:
                return 0
            connection_id = conn.id
        return await sync_new_messages(session_factory, connection_id)
