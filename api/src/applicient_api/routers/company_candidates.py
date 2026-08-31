"""M2 §5 — F2.10 discovery review/approval surface.

`GET`/`POST .../discover` are nested under the persona (a candidate
list only makes sense in the context of one persona's preferences);
`PATCH` is flat by candidate id, same reasoning as `routers/sources.py`
— the id alone already identifies the row uniquely, no need to thread
persona_id through the approval path too.

Approval never auto-creates or edits a `SavedSearch` — it only gets
the resolved identifier into the right scan-list `Source`. Binding
that source into an actual saved search stays the existing manual step
in the radar UI, same as any hand-added source today; wiring that up
automatically would be scope beyond what discovery itself is for.
"""

from __future__ import annotations

import asyncio
import re
import unicodedata
import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session, sessionmaker

from applicient_api import schemas
from applicient_api.company_discovery import classify_apply_url, propose_candidates, resolve_company_ats
from applicient_api.deps import current_user_id, get_db, get_session_factory
from applicient_api.models.discovery import CompanyCandidate, Job, Source
from applicient_api.models.enums import SourceTier
from applicient_api.models.profile import Persona, Preference
from applicient_api.tier_resolution import resolve_tier
from applicient_sources import get_adapter

router = APIRouter(prefix="/personas/{persona_id}/company-candidates", tags=["company-candidates"])
candidate_router = APIRouter(prefix="/company-candidates", tags=["company-candidates"])

_WS_RE = re.compile(r"\s+")

# Only the six ATS adapters have a company_identifiers scan-list
# concept at all (M2 §4/§6) — Tier 2/3 sources (JobSpy/SocialFetch/
# RemoteOK) are untouched by this feature, so a candidate resolving to
# one of THOSE (not possible today — classify_apply_url only knows
# about the six ATS patterns) would have nothing here to map to.
# needs_generic_scraping (M4 §9) is the seventh: a real adapter now
# exists for it (generic_scraper.py), but its scan-list is keyed by
# URL, not a company_identifiers slug — handled as its own branch in
# update_company_candidate below rather than forced into that shape.
_ADAPTER_KEY_BY_STATUS = {
    "resolved_greenhouse": "greenhouse",
    "resolved_lever": "lever",
    "resolved_workable": "workable",
    "resolved_ashby": "ashby",
    "resolved_smartrecruiters": "smartrecruiters",
    "resolved_recruitee": "recruitee",
    "needs_generic_scraping": "generic_scraper",
}


def _normalize_company_name(value: str) -> str:
    """Mirrors normalization.py's own `_normalize_for_key` (comparison
    only — `CompanyCandidate.company_name` itself keeps the original
    display casing, same discipline as `Job.canonical_key`). Not
    imported directly since that helper is private to normalization.py
    and this is a small, self-contained three-line transform."""

    value = unicodedata.normalize("NFKC", value).casefold().strip()
    return _WS_RE.sub(" ", value)


def _owned_persona(db: Session, persona_id: uuid.UUID, user_id: uuid.UUID) -> Persona:
    persona = db.query(Persona).filter_by(id=persona_id, user_id=user_id).one_or_none()
    if persona is None:
        raise HTTPException(404, "persona not found")
    return persona


@router.get("", response_model=list[schemas.CompanyCandidateOut])
def list_company_candidates(
    persona_id: uuid.UUID, db: Session = Depends(get_db), user_id: uuid.UUID = Depends(current_user_id)
):
    _owned_persona(db, persona_id, user_id)
    return (
        db.query(CompanyCandidate)
        .filter_by(persona_id=persona_id, user_id=user_id)
        .order_by(CompanyCandidate.created_at.desc())
        .all()
    )


@router.post("/discover", response_model=list[schemas.CompanyCandidateOut], status_code=201)
def discover_company_candidates(
    persona_id: uuid.UUID,
    db: Session = Depends(get_db),
    user_id: uuid.UUID = Depends(current_user_id),
    session_factory: sessionmaker = Depends(get_session_factory),
):
    """Two origins, both landing in the same review list (M2 §5):
    LLM-proposed candidates from the persona's stated `Preference`, and
    apply-link classification against every job already sighted
    through any other source. Synchronous, not SSE-streamed like radar
    runs — this is one LLM call plus a bounded number of live HTTP
    probes, not a multi-minute pipeline; revisit if candidate volume
    ever makes that untrue."""

    persona = _owned_persona(db, persona_id, user_id)
    preference = db.query(Preference).filter_by(persona_id=persona_id, user_id=user_id).one_or_none()
    if preference is None:
        raise HTTPException(409, "set preferences for this persona before running discovery")

    model = resolve_tier(
        db,
        user_id=user_id,
        tier="balanced",
        stage="company-discovery",
        session_factory=session_factory,
    )
    proposals = propose_candidates(model, preference=preference)

    existing_normalized = {
        _normalize_company_name(row[0])
        for row in db.query(CompanyCandidate.company_name).filter_by(persona_id=persona_id, user_id=user_id)
    }

    new_candidates: list[CompanyCandidate] = []
    for proposal in proposals:
        normalized = _normalize_company_name(proposal.company_name)
        if normalized in existing_normalized:
            continue
        resolution = asyncio.run(resolve_company_ats(proposal.company_name))
        candidate = CompanyCandidate(
            user_id=user_id,
            persona_id=persona_id,
            company_name=proposal.company_name,
            origin="preference_discovery",
            rationale=proposal.rationale,
            status=resolution.status,
            resolved_identifier=resolution.identifier,
            discovered_url=resolution.url,
        )
        db.add(candidate)
        new_candidates.append(candidate)
        existing_normalized.add(normalized)

    existing_job_ids = {
        row[0]
        for row in db.query(CompanyCandidate.origin_job_id).filter(
            CompanyCandidate.persona_id == persona_id, CompanyCandidate.origin_job_id.isnot(None)
        )
    }
    jobs_with_apply_url = (
        db.query(Job).filter(Job.user_id == user_id, Job.apply_url.isnot(None)).all()
    )
    for job in jobs_with_apply_url:
        if job.id in existing_job_ids:
            continue
        resolution = classify_apply_url(job.apply_url)
        # A non-ATS HTTP(S) URL is still actionable evidence: preserve it as
        # a generic-scraper candidate for M4. Workable's bare-shortcode link
        # is different — it is a known ATS with no recoverable account slug,
        # so it cannot be enrolled in an M2 scan list.
        if resolution is None or (
            resolution.status != "needs_generic_scraping" and resolution.identifier is None
        ):
            continue
        normalized = _normalize_company_name(job.company_name_raw)
        if normalized in existing_normalized:
            continue
        candidate = CompanyCandidate(
            user_id=user_id,
            persona_id=persona_id,
            company_name=job.company_name_raw,
            origin="apply_link",
            rationale=None,
            status=resolution.status,
            resolved_identifier=resolution.identifier,
            discovered_url=resolution.url,
            origin_job_id=job.id,
        )
        db.add(candidate)
        new_candidates.append(candidate)
        existing_normalized.add(normalized)

    db.commit()
    for candidate in new_candidates:
        db.refresh(candidate)
    return new_candidates


def _owned_candidate(db: Session, candidate_id: uuid.UUID, user_id: uuid.UUID) -> CompanyCandidate:
    candidate = db.query(CompanyCandidate).filter_by(id=candidate_id, user_id=user_id).one_or_none()
    if candidate is None:
        raise HTTPException(404, "company candidate not found")
    return candidate


def _find_or_create_scan_source(db: Session, *, user_id: uuid.UUID, persona: Persona, adapter_key: str) -> Source:
    """One shared scan-list Source per (persona, ATS type) — named
    deterministically rather than adding a real `Source.persona_id`
    column, since `Source` is otherwise persona-agnostic (a persona's
    actual binding to a source happens via `SavedSearch.source_ids`,
    same as any manually-added source). A real column would be the
    cleaner long-term shape; this avoids a migration for something the
    name-based lookup already achieves correctly."""

    display_name = get_adapter(adapter_key).display_name
    name = f"{display_name} (discovered — {persona.name})"
    source = db.query(Source).filter_by(user_id=user_id, adapter_key=adapter_key, name=name).one_or_none()
    if source is None:
        # generic_scraper is not a stable JSON API (SourceTier.TIER1_API
        # would be misleading) and its config has no "company slug" to
        # scan for — a bespoke career page has nothing to key off but
        # its own URL, hence the different config shape.
        is_generic = adapter_key == "generic_scraper"
        source = Source(
            user_id=user_id,
            name=name,
            tier=SourceTier.TIER2_PORTAL.value if is_generic else SourceTier.TIER1_API.value,
            adapter_key=adapter_key,
            config={"career_sites": []} if is_generic else {"company_identifiers": []},
            status="untested",
        )
        db.add(source)
        db.flush()
    return source


@candidate_router.patch("/{candidate_id}", response_model=schemas.CompanyCandidateOut)
def update_company_candidate(
    candidate_id: uuid.UUID,
    body: schemas.CompanyCandidateUpdate,
    db: Session = Depends(get_db),
    user_id: uuid.UUID = Depends(current_user_id),
):
    candidate = _owned_candidate(db, candidate_id, user_id)
    candidate.approved = body.approved

    if body.approved and candidate.status in _ADAPTER_KEY_BY_STATUS:
        adapter_key = _ADAPTER_KEY_BY_STATUS[candidate.status]
        persona = db.get(Persona, candidate.persona_id)

        if adapter_key == "generic_scraper":
            # M4 §9 — closes the loop M2 left open: resolved_identifier
            # is always None for needs_generic_scraping (there's no ATS
            # slug to have resolved), so the entry it enrolls is the
            # candidate's own discovered_url instead, deduped by URL.
            if candidate.discovered_url:
                source = _find_or_create_scan_source(db, user_id=user_id, persona=persona, adapter_key=adapter_key)
                sites = list(source.config.get("career_sites", []))
                if not any(site.get("url") == candidate.discovered_url for site in sites):
                    sites.append({"url": candidate.discovered_url, "company_name": candidate.company_name})
                    source.config = {**source.config, "career_sites": sites}
                    source.status = "untested"
        elif candidate.resolved_identifier:
            source = _find_or_create_scan_source(db, user_id=user_id, persona=persona, adapter_key=adapter_key)
            identifiers = list(source.config.get("company_identifiers", []))
            if candidate.resolved_identifier not in identifiers:
                identifiers.append(candidate.resolved_identifier)
                # New identifier added — same "config changed = untested
                # again" discipline as routers/sources.py's update_source.
                source.config = {**source.config, "company_identifiers": identifiers}
                source.status = "untested"

    db.commit()
    db.refresh(candidate)
    return candidate
