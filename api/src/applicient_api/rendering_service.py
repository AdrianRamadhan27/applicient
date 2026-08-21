"""M3 §3/§6 — wires latex_rendering.py's pure generate/compile logic to
a Document: loads the delta + this persona's evidence bank + profile
header, renders, stores the PDF via object_storage, and stamps
`Document.rendered_keys[template_id]`.

Rendering is fast (Tectonic compiles in low single-digit seconds, not
an LLM call) so this is a plain synchronous function called via
`to_thread` from the route, not its own SSE stream — the live-preview
endpoint just returns the fresh PDF bytes directly alongside storing
them, so the Composer's preview pane never needs a second round trip
through object storage to show what it just rendered.

`Document.tex_overrides[template_id]`, when present, is used verbatim
instead of regenerating from json_delta — the AI-authored CV is a
draft, not a final answer (raised by Adrian), and a user's hand edit
must compile through the exact same `compile_tex` path AI-generated
source does, not a separate one.
"""

from __future__ import annotations

import uuid

from sqlalchemy.orm import sessionmaker

from applicient_api.cover_letter_engine import CoverLetterOutput
from applicient_api.latex_rendering import RenderError, compile_tex, generate_cover_letter_tex, generate_tex
from applicient_api.models.documents import Document
from applicient_api.models.enums import DocumentType
from applicient_api.models.profile import Persona, Profile
from applicient_api.object_storage import get_object, put_object
from applicient_api.tailoring_engine import TailoringOutput, retrieve_full_evidence_bank


def get_document_tex(
    session_factory: sessionmaker, *, document_id: uuid.UUID, user_id: uuid.UUID, template_id: str
) -> tuple[str, bool]:
    """Returns (tex_source, is_edited) — the user's saved override for
    this template if one exists, else a fresh generation from the
    current json_delta."""

    with session_factory() as db:
        document = db.query(Document).filter_by(id=document_id, user_id=user_id).one_or_none()
        if document is None:
            raise RenderError(f"document {document_id} not found")

        override = (document.tex_overrides or {}).get(template_id)
        if override is not None:
            return override, True

        persona = db.get(Persona, document.persona_id)
        profile = db.get(Profile, persona.profile_id)
        header = profile.parsed_profile or {}

        if document.doc_type == DocumentType.COVER_LETTER.value:
            letter_delta = CoverLetterOutput.model_validate(document.json_delta)
            tex = generate_cover_letter_tex(template_id, delta=letter_delta, header=header)
        else:
            evidence_items = retrieve_full_evidence_bank(db, profile_id=profile.id)
            cv_delta = TailoringOutput.model_validate(document.json_delta)
            tex = generate_tex(template_id, delta=cv_delta, evidence_items=evidence_items, header=header)
        return tex, False


def save_document_tex_override(
    session_factory: sessionmaker, *, document_id: uuid.UUID, user_id: uuid.UUID, template_id: str, tex: str
) -> Document:
    with session_factory() as db:
        document = db.query(Document).filter_by(id=document_id, user_id=user_id).one_or_none()
        if document is None:
            raise RenderError(f"document {document_id} not found")
        overrides = dict(document.tex_overrides or {})
        overrides[template_id] = tex
        document.tex_overrides = overrides
        db.commit()
        db.refresh(document)
        return document


def clear_document_tex_override(
    session_factory: sessionmaker, *, document_id: uuid.UUID, user_id: uuid.UUID, template_id: str
) -> Document:
    """"Reset to AI draft" — discards the hand edit for this template."""

    with session_factory() as db:
        document = db.query(Document).filter_by(id=document_id, user_id=user_id).one_or_none()
        if document is None:
            raise RenderError(f"document {document_id} not found")
        overrides = dict(document.tex_overrides or {})
        overrides.pop(template_id, None)
        document.tex_overrides = overrides
        db.commit()
        db.refresh(document)
        return document


def get_rendered_pdf(
    session_factory: sessionmaker, *, document_id: uuid.UUID, user_id: uuid.UUID, template_id: str
) -> bytes | None:
    """The already-rendered PDF for this document/template, if one
    exists — no compile, just an object-storage fetch. What the
    Composer loads automatically on selecting a document, instead of
    the previous behavior of showing a blank "click Preview" pane
    after every page reload even though a real render already existed
    (raised by Adrian: "every time I refresh the page I have to click
    preview again"). Returns None if nothing's been rendered yet for
    this exact template, rather than raising — a document that's
    simply never been previewed isn't an error."""

    with session_factory() as db:
        document = db.query(Document).filter_by(id=document_id, user_id=user_id).one_or_none()
        if document is None:
            raise RenderError(f"document {document_id} not found")
        key = (document.rendered_keys or {}).get(template_id)
        if key is None:
            return None
        return get_object(key)


def render_document(
    session_factory: sessionmaker, *, document_id: uuid.UUID, user_id: uuid.UUID, template_id: str
) -> tuple[Document, bytes]:
    tex_source, _is_edited = get_document_tex(
        session_factory, document_id=document_id, user_id=user_id, template_id=template_id
    )
    result = compile_tex(tex_source)

    with session_factory() as db:
        document = db.query(Document).filter_by(id=document_id, user_id=user_id).one_or_none()
        if document is None:
            raise RenderError(f"document {document_id} not found")

        key = f"documents/{document.id}/{template_id}.pdf"
        put_object(key, result.pdf_bytes, "application/pdf")

        rendered_keys = dict(document.rendered_keys or {})
        rendered_keys[template_id] = key
        document.rendered_keys = rendered_keys
        document.template = template_id
        db.commit()
        db.refresh(document)
        return document, result.pdf_bytes
