"""Resolves the best available document for an Application to use —
shared by the application-agent's own `browser_upload` tool
(`agents/application_service.py`) and by the Pipeline page's manual
CV/cover-letter download (the "apply by email" flow), so both actually
see the same fallback logic instead of the agent silently having less
to work with than a human clicking a download button would.

Real gap this closes: an Application created directly from the Inbox
(no Composer session at all — `job_group_id`/`primary_document_id`
both `None`) had nothing here to offer at all. Every `Document` row
requires a real `job_group_id` (F5.10 — no "default"/groupless CV
concept exists), so an application with no Composer session behind it
could never resolve to one, no matter how the lookup was written.
`Application.primary_document_id` was also dead weight — written by
both the Inbox and Composer "Add to Pipeline" flows, but never read by
anything until now.

The one asset that's always real and available: `Profile.raw_cv_object_key`,
the user's originally-uploaded CV file, stored the moment a CV was
ever parsed for this persona (`routers/cv.py`) — never served back out
anywhere in the app until now. A real live run asked the human to
re-upload their own CV from scratch because of exactly this gap.
"""

from __future__ import annotations

import mimetypes
import uuid
from dataclasses import dataclass

from sqlalchemy.orm import Session, sessionmaker

from applicient_api.models.documents import Document, JobGroup, JobGroupMember
from applicient_api.models.pipeline import Application
from applicient_api.models.profile import Persona, Profile
from applicient_api.rendering_service import RenderError, render_document


@dataclass
class ResolvedDocument:
    key: str
    filename: str
    content_type: str


def resolve_job_group_id_for(db: Session, *, job_id: uuid.UUID, persona_id: uuid.UUID, user_id: uuid.UUID) -> uuid.UUID | None:
    """Adrian, direct: "this job is already added to job group and has
    tailored cv. But the cv button direct to base cv instead of the
    tailored cv for that job group" — an Application only ever got
    `job_group_id` set if whichever flow created it happened to pass it
    explicitly (only Composer's own "add to pipeline" ever did — Job
    Inbox and this same page's own "Add to pipeline" dialog never did,
    even when a job group with a real tailored CV already existed for
    this exact (job, persona)). Called both at Application-creation
    time (routers/applications.py) AND every time documents are
    resolved for one (below) — the latter is what makes this a real
    fix for an ALREADY-existing, already-broken Application row too,
    not just new ones, since it never needs a backfill migration.

    A job can belong to more than one group (JobGroupMember is
    many-to-many) — genuinely ambiguous only in that case, broken by
    preferring whichever candidate group actually has a generated
    Document (a group with no tailored CV yet is no better than none
    for this purpose), most recent first."""

    group_ids = [
        row[0]
        for row in (
            db.query(JobGroupMember.job_group_id)
            .join(JobGroup, JobGroup.id == JobGroupMember.job_group_id)
            .filter(JobGroupMember.job_id == job_id, JobGroup.persona_id == persona_id)
            .all()
        )
    ]
    if not group_ids:
        return None
    with_document = (
        db.query(Document.job_group_id)
        .filter(Document.job_group_id.in_(group_ids), Document.user_id == user_id)
        .order_by(Document.created_at.desc())
        .first()
    )
    return with_document[0] if with_document is not None else group_ids[0]


def _effective_job_group_id(db: Session, application: Application) -> uuid.UUID | None:
    """`application.job_group_id` if already set, else a live lookup —
    and self-heals the row the first time it resolves to something, so
    this lookup only ever runs once per application rather than on
    every single document fetch/panel open."""

    if application.job_group_id is not None:
        return application.job_group_id
    resolved = resolve_job_group_id_for(
        db, job_id=application.job_id, persona_id=application.persona_id, user_id=application.user_id
    )
    if resolved is not None:
        application.job_group_id = resolved
        db.commit()
    return resolved


def _add_rendered(
    resolved: dict[str, ResolvedDocument], session_factory: sessionmaker, doc: Document, user_id: uuid.UUID
) -> None:
    key = (doc.rendered_keys or {}).get(doc.template)
    if key is None:
        try:
            document, _pdf_bytes = render_document(
                session_factory, document_id=doc.id, user_id=user_id, template_id=doc.template
            )
            key = (document.rendered_keys or {}).get(doc.template)
        except RenderError:
            key = None
    if key:
        resolved[doc.doc_type] = ResolvedDocument(key=key, filename=f"{doc.doc_type}.pdf", content_type="application/pdf")


def resolve_application_documents(
    session_factory: sessionmaker, *, application_id: uuid.UUID, user_id: uuid.UUID
) -> dict[str, ResolvedDocument]:
    """One rendered file per doc_type ("cv" / "cover_letter" /
    "answer_pack"), resolved in priority order:

    1. `Application.primary_document_id`, if explicitly set — an
       explicit choice always wins for its own doc_type.
    2. Every other doc_type this application's `job_group_id` has
       generated, latest version first.
    3. Last resort, "cv" only: the persona's own originally-uploaded
       CV file — never tailored, but a real file beats asking a human
       to re-upload the exact one already on file for this persona.
    """

    resolved: dict[str, ResolvedDocument] = {}
    with session_factory() as db:
        application = db.query(Application).filter_by(id=application_id, user_id=user_id).one_or_none()
        if application is None:
            return resolved

        if application.primary_document_id is not None:
            doc = db.query(Document).filter_by(id=application.primary_document_id, user_id=user_id).one_or_none()
            if doc is not None:
                _add_rendered(resolved, session_factory, doc, user_id)

        job_group_id = _effective_job_group_id(db, application)
        if job_group_id is not None:
            docs = (
                db.query(Document)
                .filter_by(job_group_id=job_group_id, user_id=user_id)
                .order_by(Document.doc_type, Document.version.desc())
                .all()
            )
            seen_types = set(resolved)
            for doc in docs:
                if doc.doc_type in seen_types:
                    continue
                seen_types.add(doc.doc_type)
                _add_rendered(resolved, session_factory, doc, user_id)

        if "cv" not in resolved:
            persona = db.query(Persona).filter_by(id=application.persona_id, user_id=user_id).one_or_none()
            profile = db.get(Profile, persona.profile_id) if persona is not None else None
            if profile is not None and profile.raw_cv_object_key:
                key = profile.raw_cv_object_key
                ext = key.rsplit(".", 1)[-1] if "." in key else "pdf"
                content_type = mimetypes.guess_type(f"cv.{ext}")[0] or "application/octet-stream"
                resolved["cv"] = ResolvedDocument(key=key, filename=f"cv.{ext}", content_type=content_type)

    return resolved


def available_document_types(db: Session, *, application: Application) -> list[str]:
    """A cheap existence check only — same priority source as
    resolve_application_documents (explicit primary_document_id, then
    the job_group's own Documents, then the persona's raw uploaded CV)
    but never calls _add_rendered's render fallback, so checking "does
    this application have a CV/cover letter to show" never pays a real
    Tectonic compile just to draw the Pipeline detail panel. The actual
    PDF is still rendered on demand, only when a caller follows through
    via GET /applications/{id}/documents/{doc_type}."""

    types: set[str] = set()
    if application.primary_document_id is not None:
        doc = (
            db.query(Document)
            .filter_by(id=application.primary_document_id, user_id=application.user_id)
            .one_or_none()
        )
        if doc is not None:
            types.add(doc.doc_type)

    job_group_id = _effective_job_group_id(db, application)
    if job_group_id is not None:
        rows = (
            db.query(Document.doc_type)
            .filter_by(job_group_id=job_group_id, user_id=application.user_id)
            .distinct()
            .all()
        )
        types.update(row[0] for row in rows)

    if "cv" not in types:
        persona = db.query(Persona).filter_by(id=application.persona_id, user_id=application.user_id).one_or_none()
        profile = db.get(Profile, persona.profile_id) if persona is not None else None
        if profile is not None and profile.raw_cv_object_key:
            types.add("cv")

    return sorted(types)
