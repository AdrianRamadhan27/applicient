"""M5 follow-up — the user-customizable pipeline stage list that
replaced the fixed 13-value ApplicationState enum. This is the
service layer routers/pipeline_stages.py wraps, plus the read-side
helpers (`get_stage_keys`, `first_stage_key`) pipeline_service.py and
email_ingestion.py call directly for validation/routing.
"""

from __future__ import annotations

import re
import uuid

from sqlalchemy.orm import Session

from applicient_api.models.pipeline import Application, PipelineStage

# Adrian, direct: "right now theres too many. Even though user can
# edit the stages the default one is too many. There should only be
# Discovered, Applied, Screening, Interview, Offer, Rejected as
# default." Trimmed from the original 13 down to these 6 — every stage
# key this codebase references elsewhere (STATE_APPLIED in
# pipeline_service.py, email_ingestion.py's classification->state
# map) already tolerates a stage it expects not existing for a given
# user (a plain "skip that auto-transition" no-op, not an error), so
# dropping shortlisted/preparing/ready/acknowledged/assessment/
# withdrawn/ghosted from the DEFAULT list is safe — a user who wants
# any of them back can still add them via Manage Stages. Existing
# users' own stage lists are NOT retroactively touched by this change —
# only what a brand-new signup gets provisioned with.
DEFAULT_STAGES: list[tuple[str, str]] = [
    ("discovered", "Discovered"),
    ("applied", "Applied"),
    ("screening", "Screening"),
    ("interview", "Interview"),
    ("offer", "Offer"),
    ("rejected", "Rejected"),
]

_KEY_MAX_LEN = 20
_KEY_BASE_MAX_LEN = 15  # leaves headroom for a "-NN" dedupe suffix


class PipelineStageNotFoundError(Exception):
    pass


class StageInUseError(Exception):
    def __init__(self, stage: PipelineStage, in_use_count: int):
        self.stage = stage
        self.in_use_count = in_use_count
        super().__init__(f"'{stage.display_name}' is used by {in_use_count} application(s)")


def list_stages(session: Session, *, user_id: uuid.UUID) -> list[PipelineStage]:
    return session.query(PipelineStage).filter_by(user_id=user_id).order_by(PipelineStage.position.asc()).all()


def get_stage_keys(session: Session, *, user_id: uuid.UUID) -> set[str]:
    return {row[0] for row in session.query(PipelineStage.key).filter_by(user_id=user_id).all()}


def first_stage_key(session: Session, *, user_id: uuid.UUID) -> str | None:
    stage = (
        session.query(PipelineStage)
        .filter_by(user_id=user_id)
        .order_by(PipelineStage.position.asc())
        .first()
    )
    return stage.key if stage else None


def provision_default_stages(session: Session, *, user_id: uuid.UUID) -> list[PipelineStage]:
    """Idempotent — a no-op if this user already has any stages.
    Called from signup, the dev seed script, and (for users who
    existed before this feature) the migration's own backfill."""

    existing = list_stages(session, user_id=user_id)
    if existing:
        return existing
    stages = [
        PipelineStage(user_id=user_id, key=key, display_name=name, position=i)
        for i, (key, name) in enumerate(DEFAULT_STAGES)
    ]
    session.add_all(stages)
    session.flush()
    return stages


def _slugify(display_name: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", display_name.strip().lower()).strip("-")
    return slug[:_KEY_BASE_MAX_LEN] or "stage"


def _unique_key(session: Session, *, user_id: uuid.UUID, display_name: str) -> str:
    base = _slugify(display_name)
    existing_keys = get_stage_keys(session, user_id=user_id)
    if base not in existing_keys:
        return base
    for n in range(2, 100):
        candidate = f"{base}-{n}"[:_KEY_MAX_LEN]
        if candidate not in existing_keys:
            return candidate
    # Astronomically unlikely for a single user's stage list, but key
    # generation must never fail outright.
    return f"{base[:14]}-{uuid.uuid4().hex[:5]}"


def create_stage(session: Session, *, user_id: uuid.UUID, display_name: str) -> PipelineStage:
    display_name = display_name.strip()
    key = _unique_key(session, user_id=user_id, display_name=display_name)
    max_position = session.query(PipelineStage).filter_by(user_id=user_id).count()
    stage = PipelineStage(user_id=user_id, key=key, display_name=display_name, position=max_position)
    session.add(stage)
    session.flush()
    return stage


def rename_stage(session: Session, *, user_id: uuid.UUID, stage_id: uuid.UUID, display_name: str) -> PipelineStage:
    stage = session.query(PipelineStage).filter_by(id=stage_id, user_id=user_id).one_or_none()
    if stage is None:
        raise PipelineStageNotFoundError(str(stage_id))
    # key is never touched — this is what makes renaming safe: nothing
    # that depends on a specific key (ghosted-derivation, email-driven
    # transitions, mark_applied) is affected by a display-only rename.
    stage.display_name = display_name.strip()
    session.flush()
    return stage


def delete_stage(session: Session, *, user_id: uuid.UUID, stage_id: uuid.UUID) -> None:
    stage = session.query(PipelineStage).filter_by(id=stage_id, user_id=user_id).one_or_none()
    if stage is None:
        raise PipelineStageNotFoundError(str(stage_id))
    in_use = session.query(Application).filter_by(user_id=user_id, state=stage.key).count()
    if in_use > 0:
        raise StageInUseError(stage, in_use)
    session.delete(stage)
    session.flush()
    # Re-pack positions so the "0..N-1, no gaps" invariant holds after
    # a delete too, not just after an explicit reorder.
    remaining = list_stages(session, user_id=user_id)
    for i, s in enumerate(remaining):
        s.position = i
    session.flush()


def reorder_stages(session: Session, *, user_id: uuid.UUID, ordered_ids: list[uuid.UUID]) -> list[PipelineStage]:
    current = list_stages(session, user_id=user_id)
    current_ids = {s.id for s in current}
    if set(ordered_ids) != current_ids or len(ordered_ids) != len(current):
        raise ValueError("ordered_ids must contain exactly this user's current stage ids, no more or fewer")
    by_id = {s.id: s for s in current}
    for i, stage_id in enumerate(ordered_ids):
        by_id[stage_id].position = i
    session.flush()
    return list_stages(session, user_id=user_id)
