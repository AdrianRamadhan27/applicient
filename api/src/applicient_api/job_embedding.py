"""M1 §4 — bounded-batch embedding of Job descriptions through the
`embedding` tier.

"Checkpointing" here is structural rather than a separate progress
table: every caller only ever passes jobs still missing
`description_embedding`, so a batch that fails (isolated per batch,
not fatal to the whole call) simply leaves those jobs unembedded —
the next call naturally picks them back up without re-charging for
or re-processing anything that already succeeded. Reuses
embedding_service._raw_embed for the actual API call and cost-ledger
write rather than duplicating that logic (see its module docstring).
"""

from __future__ import annotations

import uuid

from sqlalchemy.orm import Session, sessionmaker

from applicient_api.embedding_service import _raw_embed
from applicient_api.models.discovery import Job

BATCH_SIZE = 20
# Keeps a single job's input bounded — embedding models have their
# own context limits too, and Greenhouse postings in particular can
# carry very long HTML-derived requirements text.
_MAX_CHARS = 6000


def _embedding_input(job: Job) -> str:
    parts = [
        job.title,
        f"Company: {job.company_name_raw}" if job.company_name_raw else None,
        f"Location: {job.location}" if job.location else None,
        job.requirements,
        job.responsibilities,
        job.benefits,
    ]
    text = "\n".join(p for p in parts if p)
    return text[:_MAX_CHARS]


def embed_jobs(
    session: Session,
    embeddings_client,
    jobs: list[Job],
    *,
    user_id: uuid.UUID,
    session_factory: sessionmaker,
    provider: str,
    stage: str | None = None,
    agent_run_id: uuid.UUID | None = None,
    source_run_id: uuid.UUID | None = None,
) -> tuple[int, list[str]]:
    """Returns (embedded_count, batch_error_messages)."""

    embedded = 0
    errors: list[str] = []
    for i in range(0, len(jobs), BATCH_SIZE):
        batch = jobs[i : i + BATCH_SIZE]
        texts = [_embedding_input(j) for j in batch]
        try:
            vectors = _raw_embed(
                embeddings_client,
                texts,
                user_id=user_id,
                session_factory=session_factory,
                provider=provider,
                stage=stage,
                agent_run_id=agent_run_id,
                source_run_id=source_run_id,
            )
        except Exception as exc:
            errors.append(str(exc)[:300])
            continue
        for job, vector in zip(batch, vectors):
            job.description_embedding = vector
        session.flush()
        embedded += len(batch)
    return embedded, errors
