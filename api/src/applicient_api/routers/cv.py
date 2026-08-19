"""F1.1 — CV upload → parse → evidence bank. Ties the whole flow to a
real AgentRun so its cost shows up in Cost & Usage (F13.7), exactly
what step 7's M0 exit bar asks for."""

import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, UploadFile
from sqlalchemy.orm import Session

from applicient_api import schemas
from applicient_api.cv_parsing import ExtractionError, extract_text, parse_cv_text, parse_loose_date
from applicient_api.deps import current_user_id, get_db, get_session_factory
from applicient_api.embedding_service import embed_evidence_items
from applicient_api.models.agents import AgentRun
from applicient_api.models.enums import EvidenceCategory
from applicient_api.models.llm import LlmCall
from applicient_api.models.llm import ModelProfile
from applicient_api.models.profile import EvidenceItem, Profile

_VALID_CATEGORIES = {c.value for c in EvidenceCategory}
from applicient_api.tier_resolution import TierResolutionError, resolve_embedding_tier, resolve_tier

router = APIRouter(prefix="/profiles/{profile_id}/cv", tags=["cv"])


@router.post("/parse", response_model=schemas.CVParseResult)
async def parse_cv(
    profile_id: uuid.UUID,
    file: UploadFile,
    db: Session = Depends(get_db),
    user_id: uuid.UUID = Depends(current_user_id),
):
    profile = db.query(Profile).filter_by(id=profile_id, user_id=user_id).one_or_none()
    if profile is None:
        raise HTTPException(404, "profile not found")

    content = await file.read()
    if len(content) > 10 * 1024 * 1024:
        raise HTTPException(413, "CV file is too large; the limit is 10 MB")
    try:
        cv_text = extract_text(file.filename or "", content)
    except ExtractionError as e:
        raise HTTPException(422, str(e)) from e
    if not cv_text.strip():
        raise HTTPException(422, "no extractable text found in the uploaded file")

    run = AgentRun(
        user_id=user_id,
        run_type="cv-parse",
        status="running",
        started_at=datetime.now(timezone.utc),
    )
    db.add(run)
    # Commit, not flush: the metering callback writes LlmCall from an
    # independent session/connection (see the session_factory note
    # below). flush() only makes this row visible within THIS
    # transaction — a separate connection can't see it until it's
    # actually committed, and the callback's FK write would fail.
    # Found by running the real flow, not by reasoning about it in
    # advance.
    db.commit()

    def fail_run(message: str) -> None:
        db.rollback()
        failed_run = db.get(AgentRun, run.id)
        if failed_run is not None:
            failed_run.status = "failed"
            failed_run.finished_at = datetime.now(timezone.utc)
            db.commit()

    try:
        chat_model = resolve_tier(
            db,
            user_id=user_id,
            tier="deep",
            stage="cv-parse",
            agent_run_id=run.id,
            # A fresh, independent sessionmaker — NOT the request's own
            # `db` session. The metering callback opens/closes its own
            # session on `on_llm_end`; handing it `db` would close the
            # request's session mid-flight (Session.__exit__ calls
            # close()), breaking everything after the LLM call in this
            # route. Caught before ever running this against a real file.
            session_factory=get_session_factory(),
        )
        embeddings_client = resolve_embedding_tier(db, user_id=user_id)
        extracted = parse_cv_text(chat_model, cv_text)

        created: list[EvidenceItem] = []
        for item in extracted.evidence_items:
            # Nothing enforces this against the enum at the schema level
            # (matches every other enum-as-string column in this codebase —
            # see enums.py), so an off-script model output needs a
            # fallback rather than silently polluting the column.
            category = item.category if item.category in _VALID_CATEGORIES else EvidenceCategory.OTHER.value
            row = EvidenceItem(
                user_id=user_id,
                profile_id=profile_id,
                category=category,
                text=item.text,
                skills=item.skills,
                metrics=item.metrics,
                employer=item.employer,
                date_start=parse_loose_date(item.date_start),
                date_end=parse_loose_date(item.date_end),
            )
            db.add(row)
            created.append(row)
        db.flush()

        embed_evidence_items(
            db,
            embeddings_client,
            created,
            user_id=user_id,
            session_factory=get_session_factory(),
            stage="cv-parse",
            agent_run_id=run.id,
        )

        # A new CV is a new profile revision. Keep the old evidence out of
        # the active bank only after the new parse and embeddings succeeded,
        # so a failed retry cannot destroy a previously confirmed profile.
        new_ids = [item.id for item in created]
        old_items = db.query(EvidenceItem).filter(EvidenceItem.profile_id == profile_id)
        if new_ids:
            old_items = old_items.filter(~EvidenceItem.id.in_(new_ids))
        old_items.delete(synchronize_session=False)

        profile.parsed_profile = extracted.profile.model_dump(mode="json", exclude_none=True)
        profile.parsed_at = datetime.now(timezone.utc)
        profile.confirmed = False
        profile.revision += 1
        active_model_profile = (
            db.query(ModelProfile).filter_by(user_id=user_id, is_active=True).one_or_none()
        )
        run.model_profile_id = active_model_profile.id if active_model_profile else None
        run.status = "completed"
        run.finished_at = datetime.now(timezone.utc)

        # Embedding metering is committed through an independent session, so
        # read the ledger through one as well before stamping the run total.
        with get_session_factory()() as ledger_session:
            run.total_cost_usd = sum(
                float(c.cost_usd)
                for c in ledger_session.query(LlmCall).filter_by(agent_run_id=run.id).all()
            )
        db.commit()

        for row in created:
            db.refresh(row)
        db.refresh(profile)

        return schemas.CVParseResult(
            agent_run_id=run.id,
            profile=profile,
            evidence_items=created,
            cost_usd=float(run.total_cost_usd),
        )
    except TierResolutionError as exc:
        fail_run(str(exc))
        raise HTTPException(409, f"model routing not configured: {exc}") from exc
    except Exception as exc:
        fail_run(str(exc))
        raise HTTPException(502, f"CV parse failed: {str(exc)[:240]}") from exc
