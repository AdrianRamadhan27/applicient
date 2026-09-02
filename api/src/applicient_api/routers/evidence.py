"""F1.2 — the evidence bank. Every generated CV bullet must trace back
to a row here (F5.3); the claim verifier checks against these and
nothing else (F5.4)."""

import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from applicient_api import schemas
from applicient_api.cv_parsing import parse_loose_date
from applicient_api.deps import current_user_id, get_db, get_session_factory
from applicient_api.embedding_service import embed_evidence_items
from applicient_api.models.enums import EvidenceCategory
from applicient_api.models.profile import EvidenceItem, Profile
from applicient_api.tier_resolution import TierResolutionError, resolve_embedding_tier

router = APIRouter(prefix="/profiles/{profile_id}/evidence-items", tags=["evidence"])


def _owned_profile(db: Session, profile_id: uuid.UUID, user_id: uuid.UUID) -> Profile:
    profile = db.query(Profile).filter_by(id=profile_id, user_id=user_id).one_or_none()
    if profile is None:
        raise HTTPException(404, "profile not found")
    return profile


@router.get("", response_model=list[schemas.EvidenceItemOut])
def list_evidence(
    profile_id: uuid.UUID, db: Session = Depends(get_db), user_id: uuid.UUID = Depends(current_user_id)
):
    _owned_profile(db, profile_id, user_id)
    return db.query(EvidenceItem).filter_by(profile_id=profile_id).all()


@router.post("", response_model=schemas.EvidenceItemOut, status_code=201)
def create_evidence(
    profile_id: uuid.UUID,
    body: schemas.EvidenceItemCreate,
    db: Session = Depends(get_db),
    user_id: uuid.UUID = Depends(current_user_id),
):
    _owned_profile(db, profile_id, user_id)
    if body.category not in {category.value for category in EvidenceCategory}:
        raise HTTPException(422, f"invalid evidence category: {body.category}")
    if not body.text.strip():
        raise HTTPException(422, "evidence text cannot be empty")
    item = EvidenceItem(
        user_id=user_id,
        profile_id=profile_id,
        category=body.category,
        title=body.title,
        text=body.text,
        skills=body.skills,
        metrics=body.metrics,
        employer=body.employer,
        date_start=parse_loose_date(body.date_start),
        date_end=parse_loose_date(body.date_end),
    )
    db.add(item)
    db.flush()

    # Same embed-before-commit discipline as update_evidence's own
    # title/text/skills/metrics path below — without this, a manually
    # added item's `embedding` stays NULL forever, and
    # scoring_engine.retrieve_relevant_evidence filters on
    # `embedding.isnot(None)`, so it would silently never surface for
    # scoring or tailoring despite existing in the bank.
    try:
        embeddings_client, provider = resolve_embedding_tier(db, user_id=user_id)
        embed_evidence_items(
            db, embeddings_client, [item], user_id=user_id,
            session_factory=get_session_factory(), provider=provider, stage="evidence-create",
        )
    except TierResolutionError as exc:
        db.rollback()
        raise HTTPException(409, f"model routing not configured: {exc}") from exc
    except Exception as exc:
        db.rollback()
        raise HTTPException(502, f"could not embed evidence: {str(exc)[:240]}") from exc

    profile = db.query(Profile).filter_by(id=profile_id, user_id=user_id).one()
    profile.revision += 1
    profile.confirmed = False
    db.commit()
    db.refresh(item)
    return item


@router.patch("/{evidence_id}", response_model=schemas.EvidenceItemOut)
def update_evidence(
    profile_id: uuid.UUID,
    evidence_id: uuid.UUID,
    body: schemas.EvidenceItemUpdate,
    db: Session = Depends(get_db),
    user_id: uuid.UUID = Depends(current_user_id),
):
    """F1.3 — the user can edit every parsed field before anything
    downstream uses it. Text/skills/metrics edits are re-embedded before
    the response returns; a failed re-embed leaves the edit unapplied."""

    profile = _owned_profile(db, profile_id, user_id)
    item = db.query(EvidenceItem).filter_by(id=evidence_id, profile_id=profile_id).one_or_none()
    if item is None:
        raise HTTPException(404, "evidence item not found")

    updates = body.model_dump(exclude_unset=True)
    if "category" in updates and updates["category"] not in {category.value for category in EvidenceCategory}:
        raise HTTPException(422, f"invalid evidence category: {updates['category']}")
    if "text" in updates and not updates["text"].strip():
        raise HTTPException(422, "evidence text cannot be empty")
    for date_field in ("date_start", "date_end"):
        if date_field in updates:
            updates[date_field] = parse_loose_date(updates[date_field])
    for field, value in updates.items():
        setattr(item, field, value)
    profile.revision += 1
    profile.confirmed = False
    # Title, text and skills are what the current retrieval input is built
    # from. Marking the vector stale makes the safety boundary visible
    # instead of silently searching with an embedding for the old claim.
    if any(field in updates for field in ("title", "text", "skills", "metrics")):
        item.embedding = None
    item.verified = False

    if any(field in updates for field in ("title", "text", "skills", "metrics")):
        try:
            embeddings_client, provider = resolve_embedding_tier(db, user_id=user_id)
            embed_evidence_items(
                db,
                embeddings_client,
                [item],
                user_id=user_id,
                session_factory=get_session_factory(),
                provider=provider,
                stage="evidence-edit",
            )
        except TierResolutionError as exc:
            db.rollback()
            raise HTTPException(409, f"model routing not configured: {exc}") from exc
        except Exception as exc:
            db.rollback()
            raise HTTPException(502, f"could not re-embed evidence: {str(exc)[:240]}") from exc

    db.commit()
    db.refresh(item)
    return item


@router.delete("/{evidence_id}", status_code=204)
def delete_evidence(
    profile_id: uuid.UUID,
    evidence_id: uuid.UUID,
    db: Session = Depends(get_db),
    user_id: uuid.UUID = Depends(current_user_id),
):
    profile = _owned_profile(db, profile_id, user_id)
    item = db.query(EvidenceItem).filter_by(id=evidence_id, profile_id=profile_id).one_or_none()
    if item is None:
        raise HTTPException(404, "evidence item not found")
    db.delete(item)
    profile.revision += 1
    profile.confirmed = False
    db.commit()
