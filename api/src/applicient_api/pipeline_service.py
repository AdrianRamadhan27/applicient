"""F7 — the pipeline board's transition validation and ghosted
derivation. Lives in `api/` (not `agents/`) specifically so both the
REST router (a human transitioning an application by hand) and the
application-agent's `application_transition` tool
(`agents/src/applicient_agents/browser_tools.py`, which already
depends on `api/`) go through the exact same `transition()` — `agents`
importing from `api` is the established dependency direction
throughout this codebase; the reverse would be circular.

M5 follow-up — the fixed `ALLOWED_TRANSITIONS` graph (and the
`find_transition_path`/`transition_via_path` BFS helper briefly added
to work around it) is gone: pipeline stages are now a per-user
customizable list (`pipeline_stage_service.py`) with fully permissive
transitions — any of a user's own defined stages can move directly to
any other, validated as flat set-membership against
`PipelineStage.key`, not a graph. `STATE_APPLIED` replaces the old
`ApplicationState.APPLIED.value` references — a plain string constant,
since key-based stage identity means this literal doesn't change even
if a user renames the "Applied" stage's display label.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy.orm import Session

from applicient_api import pipeline_stage_service
from applicient_api.models.pipeline import Application, ApplicationEvent

STATE_APPLIED = "applied"

# F7.3 — configurable, default 30 days.
GHOSTED_AFTER_DAYS = 30


class TransitionError(Exception):
    pass


class MarkAppliedError(Exception):
    pass


def transition(
    db: Session, *, application: Application, new_state: str, actor: str, note: str = ""
) -> ApplicationEvent:
    old_state = application.state
    valid_keys = pipeline_stage_service.get_stage_keys(db, user_id=application.user_id)
    if new_state not in valid_keys:
        raise TransitionError(
            f"'{new_state}' is not one of your defined pipeline stages — valid options: {sorted(valid_keys)}"
        )
    application.state = new_state
    if new_state == STATE_APPLIED:
        application.applied_at = datetime.now(timezone.utc)
    event = ApplicationEvent(
        application_id=application.id,
        actor=actor,
        event_type="state_changed",
        payload={"from": old_state, "to": new_state, "note": note},
        occurred_at=datetime.now(timezone.utc),
    )
    db.add(event)
    return event


def mark_applied(
    db: Session, *, application: Application, actor: str, event_type: str, note: str = ""
) -> ApplicationEvent | None:
    """A direct assertion that the application really was submitted —
    bypasses `transition()`'s stage-membership check entirely, same as
    F9.3's manual mark-as-applied (routers/applications.py's original
    `mark_applied` endpoint, now just a thin wrapper over this). This
    is "I am telling you this real-world thing happened," not "please
    validate this as a normal forward workflow hop" — a one-shot
    successful agent submit from any earlier stage legitimately skips
    past intermediate prep stages entirely, not violates anything.
    Returns None (no event, no-op) if the application was already
    marked applied — idempotent, since a resumed/retried run could
    reach this twice.

    Raises MarkAppliedError if the user has deleted their "applied"
    stage — this function bypasses the normal key-membership check
    `transition()` enforces, so without this guard it could write
    `state="applied"` even after that stage no longer exists for this
    user, orphaning the value exactly like the delete-block on
    PipelineStage exists to prevent. A direct "mark this applied"
    action deserves a real, visible failure here, not a silent no-op
    that leaves the caller believing it succeeded."""

    if application.state == STATE_APPLIED:
        return None
    if STATE_APPLIED not in pipeline_stage_service.get_stage_keys(db, user_id=application.user_id):
        raise MarkAppliedError("you've removed your 'applied' pipeline stage — add it back to mark applications applied")
    old_state = application.state
    application.state = STATE_APPLIED
    application.applied_at = datetime.now(timezone.utc)
    event = ApplicationEvent(
        application_id=application.id,
        actor=actor,
        event_type=event_type,
        payload={"from": old_state, "to": STATE_APPLIED, "note": note},
        occurred_at=datetime.now(timezone.utc),
    )
    db.add(event)
    return event


def is_ghosted(application: Application, *, latest_event_at: datetime | None) -> bool:
    """F7.3 — derived at query/list time, never stored: no event since
    `applied_at` (or since the application itself was created, if it
    somehow has no events at all) for `GHOSTED_AFTER_DAYS`.

    No stage-existence guard needed here (unlike mark_applied): this
    only ever reads `application.state`, whatever's already stored on
    this specific row — if a user deletes their "applied" stage,
    `transition()`/`mark_applied()` simply can't write "applied" onto
    any application of theirs ever again, so this naturally and
    correctly returns False forever after. Honest degradation, not a
    bug to patch here."""

    if application.state != STATE_APPLIED or application.applied_at is None:
        return False
    reference = latest_event_at or application.applied_at
    return datetime.now(timezone.utc) - reference > timedelta(days=GHOSTED_AFTER_DAYS)


def latest_event_times(db: Session, application_ids: list[uuid.UUID]) -> dict[uuid.UUID, datetime]:
    if not application_ids:
        return {}
    rows = (
        db.query(ApplicationEvent.application_id, ApplicationEvent.occurred_at)
        .filter(ApplicationEvent.application_id.in_(application_ids))
        .order_by(ApplicationEvent.application_id, ApplicationEvent.occurred_at.desc())
        .all()
    )
    latest: dict[uuid.UUID, datetime] = {}
    for app_id, occurred_at in rows:
        if app_id not in latest:
            latest[app_id] = occurred_at
    return latest
