"""F6.3/§9 — reusable question -> answer memory, the first stop in the
application-agent's field resolution chain. Mirrors
`scoring_engine.retrieve_relevant_evidence`'s cosine-distance retrieval
shape and `embedding_service._raw_embed`'s metered-embed-call shape —
both reused directly, not reinvented for this one new table.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy.orm import sessionmaker

from applicient_api.embedding_service import _raw_embed
from applicient_api.models.pipeline import FormAnswer

# First-pass calibration, not tuned against a real eval set yet (this
# codebase's own precedent for dedup/similarity thresholds — PRD
# §7.5/§13.2 — flags exactly this as something to calibrate later, not
# something to silently treat as final). Below this cosine distance,
# an existing answer is treated as "the same question" rather than
# risking a wrong-but-plausible reuse.
_MATCH_THRESHOLD = 0.15


def lookup_form_answer(
    session_factory: sessionmaker,
    *,
    user_id: uuid.UUID,
    persona_id: uuid.UUID,
    question: str,
    embeddings_client,
    provider: str,
) -> str | None:
    """F6.3's first fallback step. Returns None (not an error) when
    nothing similar enough exists yet — the caller's chain moves on to
    the next resolution step, exactly like `retrieve_relevant_evidence`
    degrading to an empty list rather than raising."""

    [vector] = _raw_embed(
        embeddings_client,
        [question],
        user_id=user_id,
        session_factory=session_factory,
        provider=provider,
        stage="application.form_answer_lookup",
    )

    with session_factory() as db:
        distance_col = FormAnswer.question_embedding.cosine_distance(vector).label("distance")
        result = (
            db.query(FormAnswer, distance_col)
            .filter(FormAnswer.persona_id == persona_id, FormAnswer.question_embedding.isnot(None))
            .order_by(distance_col)
            .first()
        )
        if result is None:
            return None
        row, distance = result
        if distance is None or distance > _MATCH_THRESHOLD:
            return None
        row.times_reused += 1
        db.commit()
        return row.answer_text


def save_form_answer(
    session_factory: sessionmaker,
    *,
    user_id: uuid.UUID,
    persona_id: uuid.UUID,
    question: str,
    answer: str,
    embeddings_client,
    provider: str,
    source_application_id: uuid.UUID | None = None,
) -> None:
    """A question asked once (via an interrupt) is saved so the
    resolution chain never asks it again for this persona."""

    [vector] = _raw_embed(
        embeddings_client,
        [question],
        user_id=user_id,
        session_factory=session_factory,
        provider=provider,
        stage="application.form_answer_save",
    )
    with session_factory() as db:
        db.add(
            FormAnswer(
                user_id=user_id,
                persona_id=persona_id,
                question_text=question,
                question_embedding=vector,
                answer_text=answer,
                source_application_id=source_application_id,
                times_reused=0,
            )
        )
        db.commit()
