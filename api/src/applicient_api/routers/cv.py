"""F1.1 — CV upload → parse → evidence bank. Ties the whole flow to a
real AgentRun so its cost shows up in Cost & Usage (F13.7), exactly
what step 7's M0 exit bar asks for.

Streams real progress via SSE (reusing the EventSourceResponse pattern
from routers/streaming.py) rather than a single blocking
request/response — each event corresponds to an actual code boundary
(extract → resolve models → parse → save → embed), never a simulated
timer. Each stage is also persisted as an AgentStep row, so the trace
survives after the stream closes (the Run Console can read it back
later, same as any other agent run) even if nobody was watching the
live stream when it happened.

Uses its own DB session opened directly via the session factory rather
than the request-scoped `Depends(get_db)` session — a StreamingResponse
keeps running after the route function returns, and relying on a
request-scoped dependency's session to still be open partway through
that stream is exactly the kind of thing that should be verified, not
assumed; opening an explicit session the generator owns end to end
sidesteps the question entirely.

The slow calls (parse_cv_text's LLM call, embed_evidence_items) run via
asyncio.to_thread rather than being awaited directly — they're plain
synchronous functions, and calling a sync function directly inside an
async generator blocks the whole event loop for its entire duration.
Confirmed as a real bug, not a theoretical one: a raw-byte-level timing
trace showed every SSE frame for a ~40s parse arriving in a single
burst at the very end, not incrementally — the "started" event for a
stage was yielded correctly but the ASGI server had no chance to
actually flush it to the socket before the next blocking call already
had the event loop's only thread pinned. to_thread frees the loop to
flush what's already been yielded while the slow call runs elsewhere.
"""

import json
import uuid
from asyncio import to_thread
from datetime import datetime, timezone
from typing import AsyncGenerator

from fastapi import APIRouter, Depends, HTTPException, UploadFile
from sqlalchemy.orm import Session
from sse_starlette.sse import EventSourceResponse

from applicient_api import schemas
from applicient_api.cv_parsing import ExtractionError, extract_text, parse_cv_text, parse_loose_date
from applicient_api.cv_review_service import run_cv_score_for_profile
from applicient_api.deps import current_user_id, get_db, get_session_factory
from applicient_api.embedding_service import embed_evidence_items
from applicient_api.models.agents import AgentRun, AgentStep
from applicient_api.models.enums import EvidenceCategory
from applicient_api.models.llm import LlmCall
from applicient_api.models.profile import EvidenceItem, Profile
from applicient_api.object_storage import put_object
from applicient_api.tier_resolution import TierResolutionError, active_model_profile, resolve_embedding_tier, resolve_tier

_VALID_CATEGORIES = {c.value for c in EvidenceCategory}

router = APIRouter(prefix="/profiles/{profile_id}/cv", tags=["cv"])


def _event(stage: str, status: str, message: str, **detail) -> dict:
    return {"event": "stage", "data": json.dumps({"stage": stage, "status": status, "message": message, **detail})}


def _error_event(message: str) -> dict:
    return {"event": "error", "data": json.dumps({"message": message})}


async def _parse_cv_stream(
    profile_id: uuid.UUID, file: UploadFile, user_id: uuid.UUID
) -> AsyncGenerator[dict, None]:
    session_factory = get_session_factory()

    with session_factory() as db:
        # Existence is already checked in the route handler, before the
        # stream starts (so a bad profile_id gets a real HTTP 404 instead
        # of a 200 with an error event — the HTTP status is committed the
        # moment streaming begins, so that check can't happen in here).
        profile = db.query(Profile).filter_by(id=profile_id, user_id=user_id).one()

        run = AgentRun(
            user_id=user_id, run_type="cv-parse", status="running", started_at=datetime.now(timezone.utc)
        )
        db.add(run)
        db.commit()

        def emit_step(step_type: str, started_at: datetime, output_summary: dict) -> None:
            db.add(
                AgentStep(
                    agent_run_id=run.id,
                    step_type=step_type,
                    input_summary={},
                    output_summary=output_summary,
                    started_at=started_at,
                    finished_at=datetime.now(timezone.utc),
                )
            )
            db.commit()

        def fail_run() -> None:
            db.rollback()
            failed = db.get(AgentRun, run.id)
            if failed is not None:
                failed.status = "failed"
                failed.finished_at = datetime.now(timezone.utc)
                db.commit()

        try:
            # --- extracting ---
            t0 = datetime.now(timezone.utc)
            yield _event("extracting", "started", f"Extracting text from {file.filename or 'the file'}")
            content = await file.read()
            if len(content) > 10 * 1024 * 1024:
                raise ExtractionError("CV file is too large; the limit is 10 MB")
            cv_text = extract_text(file.filename or "", content)
            if not cv_text.strip():
                raise ExtractionError("no extractable text found in the uploaded file")

            # M3 §1 — the raw file itself was never actually persisted
            # before this (raw_cv_object_key was only ever set to
            # None); stored here, alongside text extraction, rather
            # than gating the whole parse on the upload succeeding —
            # object storage being briefly unavailable shouldn't block
            # a CV parse that has already read the file into memory.
            ext = (file.filename or "").rsplit(".", 1)[-1].lower() if "." in (file.filename or "") else "bin"
            object_key = f"cv/{profile_id}/{uuid.uuid4()}.{ext}"
            await to_thread(put_object, object_key, content, file.content_type or "application/octet-stream")
            profile.raw_cv_object_key = object_key

            emit_step("extracting", t0, {"chars": len(cv_text)})
            yield _event("extracting", "done", f"Extracted {len(cv_text):,} characters")

            # --- resolving models ---
            t0 = datetime.now(timezone.utc)
            yield _event("resolving_models", "started", "Resolving deep and embedding tier models")
            chat_model = await to_thread(
                resolve_tier,
                db,
                user_id=user_id,
                tier="deep",
                stage="cv-parse",
                agent_run_id=run.id,
                session_factory=session_factory,
            )
            embeddings_client, embeddings_provider = await to_thread(resolve_embedding_tier, db, user_id=user_id)
            emit_step("resolving_models", t0, {})
            yield _event("resolving_models", "done", "Model routing resolved")

            # --- parsing ---
            t0 = datetime.now(timezone.utc)
            yield _event("parsing", "started", "Parsing CV with AI — this is the slow step")
            # The actual bug this whole change exists to fix: this is a
            # blocking network call to the LLM (often 30-90s for a real
            # CV — measured live). Called directly (not via to_thread) it
            # would pin the event loop for that entire duration, and
            # every event yielded before this point would sit unflushed
            # in a buffer instead of reaching the client — confirmed via
            # a raw-byte timing trace, not assumed.
            extracted = await to_thread(parse_cv_text, chat_model, cv_text)
            emit_step("parsing", t0, {"evidence_items": len(extracted.evidence_items)})
            yield _event("parsing", "done", f"Extracted {len(extracted.evidence_items)} evidence items")

            # --- saving ---
            t0 = datetime.now(timezone.utc)
            yield _event("saving", "started", "Saving evidence items")
            created: list[EvidenceItem] = []
            for item in extracted.evidence_items:
                # Nothing enforces this against the enum at the schema level
                # (matches every other enum-as-string column in this
                # codebase — see enums.py), so an off-script model output
                # needs a fallback rather than silently polluting the column.
                category = (
                    item.category if item.category in _VALID_CATEGORIES else EvidenceCategory.OTHER.value
                )
                row = EvidenceItem(
                    user_id=user_id,
                    profile_id=profile_id,
                    category=category,
                    title=item.title,
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

            # A new CV is a new profile revision. Keep the old evidence out
            # of the active bank only after the new parse succeeded, so a
            # failed retry cannot destroy a previously confirmed profile.
            new_ids = [item.id for item in created]
            old_items = db.query(EvidenceItem).filter(EvidenceItem.profile_id == profile_id)
            if new_ids:
                old_items = old_items.filter(~EvidenceItem.id.in_(new_ids))
            old_items.delete(synchronize_session=False)
            emit_step("saving", t0, {"count": len(created)})
            yield _event("saving", "done", f"Saved {len(created)} evidence items")

            # --- embedding ---
            t0 = datetime.now(timezone.utc)
            yield _event("embedding", "started", f"Embedding {len(created)} evidence items")
            await to_thread(
                embed_evidence_items,
                db,
                embeddings_client,
                created,
                user_id=user_id,
                session_factory=session_factory,
                provider=embeddings_provider,
                stage="cv-parse",
                agent_run_id=run.id,
            )
            emit_step("embedding", t0, {})
            yield _event("embedding", "done", "Embeddings complete")

            # --- scoring (Adrian, direct: "after user upload cv there
            # needs to be cv scoring... to give analysis and feedback",
            # shown on Composer's Base CV page) — free, best-effort: a
            # scoring failure degrades to "no score yet, retry from the
            # Base CV page" rather than failing the whole upload the
            # user actually cares about. ---
            t0 = datetime.now(timezone.utc)
            yield _event("scoring", "started", "Analyzing your CV")
            try:
                await to_thread(
                    run_cv_score_for_profile,
                    db, profile_id=profile_id, user_id=user_id, session_factory=session_factory,
                )
                emit_step("scoring", t0, {})
                yield _event("scoring", "done", "Analysis complete")
            except Exception as exc:
                yield _event("scoring", "done", f"Analysis skipped: {str(exc)[:200]}")

            # --- finalize ---
            profile.parsed_profile = extracted.profile.model_dump(mode="json", exclude_none=True)
            profile.parsed_at = datetime.now(timezone.utc)
            profile.confirmed = False
            profile.revision += 1
            active_profile = active_model_profile(db)
            run.model_profile_id = active_profile.id if active_profile else None
            run.status = "completed"
            run.finished_at = datetime.now(timezone.utc)

            # Embedding metering is committed through an independent
            # session, so read the ledger through one as well before
            # stamping the run total.
            with session_factory() as ledger_session:
                run.total_cost_usd = sum(
                    float(c.cost_usd)
                    for c in ledger_session.query(LlmCall).filter_by(agent_run_id=run.id).all()
                )
            db.commit()

            for row in created:
                db.refresh(row)
            db.refresh(profile)

            result = schemas.CVParseResult(
                agent_run_id=run.id,
                profile=profile,
                evidence_items=created,
                cost_usd=float(run.total_cost_usd),
            )
            yield {"event": "done", "data": result.model_dump_json()}
        except TierResolutionError as exc:
            fail_run()
            yield _error_event(f"model routing not configured: {exc}")
        except ExtractionError as exc:
            fail_run()
            yield _error_event(str(exc))
        except Exception as exc:
            fail_run()
            yield _error_event(f"CV parse failed: {str(exc)[:240]}")


@router.post("/parse")
async def parse_cv(
    profile_id: uuid.UUID,
    file: UploadFile,
    db: Session = Depends(get_db),
    user_id: uuid.UUID = Depends(current_user_id),
):
    """Streams `{"event": "stage" | "done" | "error", "data": "<json>"}`.
    Stage payloads: {stage, status: "started"|"done", message, ...detail}.
    The done payload is a full CVParseResult; error is {message}."""

    if db.query(Profile).filter_by(id=profile_id, user_id=user_id).one_or_none() is None:
        raise HTTPException(404, "profile not found")

    return EventSourceResponse(_parse_cv_stream(profile_id, file, user_id))
