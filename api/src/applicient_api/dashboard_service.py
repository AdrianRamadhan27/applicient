"""Phase 14 (v2 plan) — summary stats for the new `/console` dashboard
home. First aggregation endpoint of its kind in this codebase (no
existing `GROUP BY date(created_at)`-style query anywhere to mirror);
built fresh here rather than adapting scheduler.py's `_daily_digest`
rolling-24h count, which is a loose pattern, not reusable
infrastructure for a real per-day chart.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy import func
from sqlalchemy.orm import Session

from applicient_api.models.agents import OrchestratorConversation
from applicient_api.models.calendar import CalendarEvent
from applicient_api.models.discovery import Job, SavedSearch
from applicient_api.models.documents import Document
from applicient_api.models.interview import InterviewSession
from applicient_api.models.pipeline import Application, PipelineStage
from applicient_api.models.profile import EvidenceItem, Persona, Preference

# Two weeks — enough to see a real trend without the chart getting
# cramped; not a product-law number, just a reasonable default.
DAILY_ACTIVITY_DAYS = 14


def get_dashboard_summary(db: Session, *, user_id: uuid.UUID) -> dict:
    job_count = db.query(Job).filter_by(user_id=user_id).count()
    document_count = db.query(Document).filter_by(user_id=user_id).count()

    stages = db.query(PipelineStage).filter_by(user_id=user_id).order_by(PipelineStage.position).all()
    raw_counts: dict[str, int] = dict(
        db.query(Application.state, func.count()).filter_by(user_id=user_id).group_by(Application.state).all()
    )
    applications_by_stage = [
        {"stage": s.key, "display_name": s.display_name, "count": raw_counts.get(s.key, 0)} for s in stages
    ]
    # An application sitting in a state whose PipelineStage row was
    # since renamed/deleted — surfaced under its raw key rather than
    # silently dropped from the total the cards above imply.
    known_keys = {s.key for s in stages}
    for state, count in raw_counts.items():
        if state not in known_keys:
            applications_by_stage.append({"stage": state, "display_name": state, "count": count})

    today = datetime.now(timezone.utc).date()
    since = datetime.combine(today - timedelta(days=DAILY_ACTIVITY_DAYS - 1), datetime.min.time(), tzinfo=timezone.utc)

    jobs_by_day = dict(
        db.query(func.date(Job.created_at), func.count())
        .filter(Job.user_id == user_id, Job.created_at >= since)
        .group_by(func.date(Job.created_at))
        .all()
    )
    apps_by_day = dict(
        db.query(func.date(Application.created_at), func.count())
        .filter(Application.user_id == user_id, Application.created_at >= since)
        .group_by(func.date(Application.created_at))
        .all()
    )

    daily_activity = []
    for i in range(DAILY_ACTIVITY_DAYS - 1, -1, -1):
        d = today - timedelta(days=i)
        daily_activity.append(
            {"date": d.isoformat(), "jobs_discovered": jobs_by_day.get(d, 0), "applications_created": apps_by_day.get(d, 0)}
        )

    return {
        "job_count": job_count,
        "document_count": document_count,
        "applications_by_stage": applications_by_stage,
        "daily_activity": daily_activity,
    }


# New home page's onboarding checklist (raised directly by Adrian) —
# each step is a real, independently-checkable fact about the user's
# own data (a row exists or it doesn't), never a separately-tracked
# "did they click through this wizard" flag — so it's correct from
# outside this feature too: someone who e.g. added a job manually
# skips straight to that step showing done, exactly as it should.
# Ordered to match the actual work sequence (build a profile -> find
# jobs -> tailor -> apply -> track), same reasoning nav.ts's own
# ordering comment gives.
def get_onboarding_progress(db: Session, *, user_id: uuid.UUID) -> dict:
    def exists(query) -> bool:
        return db.query(query.exists()).scalar() or False

    steps = [
        {
            "key": "persona",
            "label": "Create a persona",
            "done": exists(db.query(Persona).filter_by(user_id=user_id)),
            "href": None,  # handled specially client-side — opens the persona dialog, not a page
        },
        {
            "key": "cv",
            "label": "Upload your CV",
            "done": exists(db.query(EvidenceItem).filter_by(user_id=user_id)),
            "href": "/console?tab=profile",
        },
        {
            "key": "preferences",
            "label": "Set your preferences",
            "done": exists(db.query(Preference).filter_by(user_id=user_id)),
            "href": "/console?tab=preferences",
        },
        {
            "key": "job_search",
            "label": "Search for jobs",
            "done": exists(db.query(SavedSearch).filter_by(user_id=user_id))
            or exists(db.query(Job).filter_by(user_id=user_id)),
            "href": "/console/radar",
        },
        {
            "key": "compose_cv",
            "label": "Tailor a CV",
            "done": exists(db.query(Document).filter_by(user_id=user_id)),
            "href": "/console/composer",
        },
        {
            "key": "apply",
            "label": "Apply with the pipeline",
            "done": exists(db.query(Application).filter_by(user_id=user_id)),
            "href": "/console/pipeline",
        },
        {
            "key": "interview_practice",
            "label": "Practice an interview",
            "done": exists(db.query(InterviewSession).filter_by(user_id=user_id)),
            "href": "/console/interview-practice",
        },
        {
            "key": "chat_assistant",
            "label": "Chat with the assistant",
            "done": exists(db.query(OrchestratorConversation).filter_by(user_id=user_id)),
            "href": "/console/assistant",
        },
        {
            "key": "tracking",
            "label": "Track statuses & events",
            "done": exists(db.query(CalendarEvent).filter_by(user_id=user_id)),
            "href": "/console/calendar",
        },
    ]
    completed = sum(1 for s in steps if s["done"])
    return {"steps": steps, "completed": completed, "total": len(steps)}
