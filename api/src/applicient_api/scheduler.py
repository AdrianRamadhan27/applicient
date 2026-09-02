"""M5 F10 — an in-process scheduler (APScheduler's AsyncIOScheduler)
embedded in the api service, chosen over standing up separate
scheduler/worker containers since neither exists yet in the running
stack — this is genuinely new infrastructure either way, and the
in-process version ships without new containers/queue plumbing.

APScheduler's default jobstore is in-memory, with no persistence
across a process restart — start_scheduler's own reconciliation pass
(re-adding a job per active, cron-having SavedSearch) is what recovers
schedule state on every startup, not optional bookkeeping.

Budget-cap enforcement (F10.4) is deliberately NOT built in this pass
— `Budget` rows exist but nothing reads them yet anywhere in this
codebase, and wiring real spend enforcement is its own scoped piece of
work, not a one-line addition alongside the rest of this module.

SaaS pivot — real multi-tenant constraint, stated plainly rather than
discovered in production: this scheduler must stay a single `api`
replica. APScheduler's in-memory jobstore has no distributed lock or
leader election, so a second replica would independently reconstruct
and fire the exact same job set (`start_scheduler`'s own reconciliation
pass runs identically in every process) — every saved-search cron,
every Gmail poll, every daily digest would fire twice. Real horizontal
scaling of this scheduler needs either a distributed jobstore/leader
election or moving cron ownership out of `api` into a dedicated
service — a real, separate piece of architecture work, not attempted
here.
"""

from __future__ import annotations

import asyncio
import logging
import os
import uuid
from datetime import datetime, timedelta, timezone

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger
from apscheduler.triggers.interval import IntervalTrigger
from dateutil import parser as date_parser
from sqlalchemy.orm import sessionmaker

from applicient_api import email_ingestion, email_service, gmail_service, notification_service
from applicient_api.models.discovery import Job, SavedSearch
from applicient_api.models.email import EmailMessage
from applicient_api.models.enums import Recommendation
from applicient_api.models.gmail import GmailConnection
from applicient_api.models.notifications import Notification
from applicient_api.models.profile import Persona, Profile, User
from applicient_api.models.scoring import FitScore
from applicient_api.radar import run_radar_search

logger = logging.getLogger(__name__)

_scheduler: AsyncIOScheduler | None = None
_session_factory: sessionmaker | None = None

GMAIL_POLL_INTERVAL_MINUTES = 5
WATCH_RENEWAL_CHECK_INTERVAL_MINUTES = 60
WATCH_RENEWAL_WINDOW = timedelta(hours=24)
DIGEST_HOUR_UTC = 8
DEADLINE_LOOKAHEAD = timedelta(days=3)

# SaaS pivot — this loop used to await every user's Gmail poll one
# after another with no bound, on the one shared event loop the whole
# api process runs on: a slow/hanging real Gmail API call for one
# tenant delayed every other tenant's poll behind it, and could push
# a poll past its own next scheduled firing. A semaphore caps how many
# connections poll concurrently (Gmail's API, not this process, is the
# real bottleneck); a per-connection timeout guarantees one hung call
# can't consume the whole 5-minute window.
GMAIL_POLL_CONCURRENCY = 5
GMAIL_POLL_TIMEOUT_SECONDS = 60


def _saved_search_job_id(saved_search_id: uuid.UUID) -> str:
    return f"saved-search:{saved_search_id}"


def schedule_saved_search(saved_search: SavedSearch) -> None:
    if _scheduler is None or not saved_search.schedule_cron:
        return
    try:
        trigger = CronTrigger.from_crontab(saved_search.schedule_cron)
    except ValueError:
        logger.warning("saved search %s has an invalid schedule_cron %r — not scheduled", saved_search.id, saved_search.schedule_cron)
        return
    _scheduler.add_job(
        run_scheduled_search,
        trigger,
        id=_saved_search_job_id(saved_search.id),
        args=[saved_search.id, saved_search.user_id],
        replace_existing=True,
        misfire_grace_time=300,
    )


def unschedule_saved_search(saved_search_id: uuid.UUID) -> None:
    if _scheduler is None:
        return
    try:
        _scheduler.remove_job(_saved_search_job_id(saved_search_id))
    except Exception:
        pass  # not scheduled — fine, this is called unconditionally on every update/delete


async def run_scheduled_search(saved_search_id: uuid.UUID, user_id: uuid.UUID) -> None:
    """The cron-driven entry point. Re-validates the same preconditions
    the manual "run saved search" route checks synchronously
    (routers/radar.py) — a schedule firing against a since-deactivated
    search/persona/profile degrades to a skipped, logged run rather
    than crashing the scheduler.

    v2 Phase 2 — a cron-fired run used to silently update state with no
    signal the user ever ran it; now notifies (in-app + email) the same
    "quiet runs stay quiet" way _daily_digest already does — nothing
    written if the run found nothing new."""

    assert _session_factory is not None
    with _session_factory() as session:
        saved_search = session.get(SavedSearch, saved_search_id)
        if saved_search is None or saved_search.user_id != user_id or not saved_search.active or not saved_search.source_ids:
            logger.info("scheduled run for saved search %s skipped — inactive/missing/no sources", saved_search_id)
            return
        persona = session.get(Persona, saved_search.persona_id)
        if persona is None or not persona.active:
            logger.info("scheduled run for saved search %s skipped — persona missing/inactive", saved_search_id)
            return
        profile = session.get(Profile, persona.profile_id)
        if profile is None or not profile.confirmed:
            logger.info("scheduled run for saved search %s skipped — profile not confirmed", saved_search_id)
            return
        saved_search_name = saved_search.name

    run_started_at = datetime.now(timezone.utc)
    try:
        async for _event in run_radar_search(saved_search_id, user_id, _session_factory):
            pass
    except Exception:
        logger.exception("scheduled run for saved search %s failed", saved_search_id)
        return

    with _session_factory() as session:
        new_jobs = session.query(Job).filter(Job.user_id == user_id, Job.created_at >= run_started_at).count()
        strong = (
            session.query(FitScore)
            .filter(
                FitScore.user_id == user_id,
                FitScore.created_at >= run_started_at,
                FitScore.recommendation == Recommendation.STRONG_APPLY.value,
            )
            .count()
        )
        if not new_jobs and not strong:
            return

        parts = []
        if new_jobs:
            parts.append(f"{new_jobs} new job{'s' if new_jobs != 1 else ''}")
        if strong:
            parts.append(f"{strong} strong match{'es' if strong != 1 else ''}")
        notification_service.create_notification(
            session, user_id=user_id, subject=f"{saved_search_name}: " + ", ".join(parts),
        )
        session.commit()
        user = session.get(User, user_id)

    if user is None:
        return
    radar_url = f"{os.environ.get('FRONTEND_URL') or 'http://localhost:3000'}/radar"
    try:
        await email_service.send_scheduled_run_summary_email(
            to=user.email,
            saved_search_name=saved_search_name,
            new_jobs_count=new_jobs,
            strong_matches_count=strong,
            radar_url=radar_url,
        )
    except (RuntimeError, email_service.EmailSendError):
        # Same non-blocking treatment as auth.py's verification email —
        # the in-app notification above already landed regardless.
        logger.warning("scheduled-run summary email failed for user %s", user_id, extra={"user_id": user_id})


async def _poll_one_connection(connection_id: uuid.UUID, user_id: uuid.UUID, semaphore: asyncio.Semaphore) -> None:
    # user_id passed through purely for structured logging (see
    # logging_config.py) — diagnosing one noisy/broken tenant's Gmail
    # connection from `docker logs` shouldn't require grepping a
    # connection UUID and cross-referencing it against the DB by hand.
    async with semaphore:
        try:
            await asyncio.wait_for(
                email_ingestion.GmailIngestor.poll(_session_factory, connection_id),
                timeout=GMAIL_POLL_TIMEOUT_SECONDS,
            )
        except asyncio.TimeoutError:
            logger.warning(
                "gmail poll for connection %s exceeded %ss, abandoned",
                connection_id, GMAIL_POLL_TIMEOUT_SECONDS,
                extra={"user_id": user_id, "connection_id": connection_id},
            )
        except Exception:
            logger.exception(
                "gmail poll failed for connection %s", connection_id,
                extra={"user_id": user_id, "connection_id": connection_id},
            )


async def _poll_all_gmail_connections() -> None:
    assert _session_factory is not None
    with _session_factory() as session:
        connections = (
            session.query(GmailConnection.id, GmailConnection.user_id)
            .filter(GmailConnection.polling_enabled.is_(True))
            .all()
        )
    semaphore = asyncio.Semaphore(GMAIL_POLL_CONCURRENCY)
    await asyncio.gather(
        *(_poll_one_connection(cid, uid, semaphore) for cid, uid in connections)
    )


async def _renew_expiring_watches() -> None:
    assert _session_factory is not None
    cutoff = datetime.now(timezone.utc) + WATCH_RENEWAL_WINDOW
    with _session_factory() as session:
        due = (
            session.query(GmailConnection)
            .filter(GmailConnection.watch_expiration.isnot(None), GmailConnection.watch_expiration <= cutoff)
            .all()
        )
        for conn in due:
            try:
                await gmail_service.start_watch(session, conn)
            except Exception:
                logger.exception("watch renewal failed for gmail connection %s", conn.id)
        session.commit()


def _approaching_deadline_messages(session, user_id: uuid.UUID) -> list[EmailMessage]:
    """F8.7's deadline-approaching notification. Deduped by checking
    for an existing "deadline" notification already pointed at this
    email message — no separate dismiss/seen flag on EmailMessage
    itself, this is the whole dedupe mechanism. `deadline` is
    free-text from the LLM extraction (F8.5 never enforced a format),
    so parsing is best-effort via dateutil and anything unparseable is
    silently skipped rather than surfaced as a false deadline."""

    now = datetime.now(timezone.utc)
    candidates = (
        session.query(EmailMessage)
        .filter(EmailMessage.user_id == user_id, EmailMessage.extracted_data["deadline"].isnot(None))
        .all()
    )
    already_notified = {
        n.related_id
        for n in session.query(Notification.related_id)
        .filter_by(user_id=user_id, related_type="email_message_deadline")
        .all()
    }
    due = []
    for msg in candidates:
        if msg.id in already_notified:
            continue
        deadline_str = msg.extracted_data.get("deadline")
        if not deadline_str:
            continue
        try:
            deadline_dt = date_parser.parse(deadline_str, fuzzy=True)
        except (ValueError, OverflowError):
            continue
        if deadline_dt.tzinfo is None:
            deadline_dt = deadline_dt.replace(tzinfo=timezone.utc)
        if now <= deadline_dt <= now + DEADLINE_LOOKAHEAD:
            due.append(msg)
    return due


async def _daily_digest() -> None:
    """F10.5 — thresholded: a day with nothing new writes no
    notification at all ("quiet days stay quiet"), rather than a daily
    ping with zero content."""

    assert _session_factory is not None
    with _session_factory() as session:
        cutoff = datetime.now(timezone.utc) - timedelta(hours=24)
        for user_id in [row[0] for row in session.query(User.id).all()]:
            new_jobs = session.query(Job).filter(Job.user_id == user_id, Job.created_at >= cutoff).count()
            strong = (
                session.query(FitScore)
                .filter(FitScore.user_id == user_id, FitScore.created_at >= cutoff, FitScore.recommendation == Recommendation.STRONG_APPLY.value)
                .count()
            )
            deadline_msgs = _approaching_deadline_messages(session, user_id)

            for msg in deadline_msgs:
                notification_service.create_notification(
                    session, user_id=user_id, subject=f"Deadline approaching: {msg.subject or 'an application'}",
                    related_type="email_message_deadline", related_id=msg.id,
                )

            if not new_jobs and not strong and not deadline_msgs:
                continue

            parts = []
            if new_jobs:
                parts.append(f"{new_jobs} new job{'s' if new_jobs != 1 else ''}")
            if strong:
                parts.append(f"{strong} strong match{'es' if strong != 1 else ''}")
            notification_service.create_notification(
                session, user_id=user_id, subject="Daily summary: " + ", ".join(parts) if parts else "Daily summary",
            )
        session.commit()


async def start_scheduler(session_factory: sessionmaker) -> None:
    global _scheduler, _session_factory
    _session_factory = session_factory
    _scheduler = AsyncIOScheduler()

    with session_factory() as session:
        due = session.query(SavedSearch).filter(SavedSearch.active.is_(True), SavedSearch.schedule_cron.isnot(None)).all()
        for saved_search in due:
            schedule_saved_search(saved_search)

    _scheduler.add_job(_poll_all_gmail_connections, IntervalTrigger(minutes=GMAIL_POLL_INTERVAL_MINUTES), id="gmail-poll")
    _scheduler.add_job(
        _renew_expiring_watches, IntervalTrigger(minutes=WATCH_RENEWAL_CHECK_INTERVAL_MINUTES), id="gmail-watch-renewal"
    )
    _scheduler.add_job(_daily_digest, CronTrigger(hour=DIGEST_HOUR_UTC, minute=0), id="daily-digest")
    _scheduler.start()


def stop_scheduler() -> None:
    global _scheduler
    if _scheduler is not None:
        _scheduler.shutdown(wait=False)
        _scheduler = None
