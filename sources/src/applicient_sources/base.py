"""M1 §1/§2 — the source-adapter contract. Every discovery source
(Greenhouse today, a browser-driven portal or a social-lead extractor
later) implements the same two operations and declares the same
metadata; normalization, dedup, scoring and the UI never know or care
which adapter produced a posting (PRD §2.1, mirrors the provider
adapter pattern in api/src/applicient_api/providers/).

Adapter output is validated with Pydantic (RawPosting) before it ever
reaches persistence — a malformed field from a flaky API fails loud
here, not as a mysterious downstream constraint violation.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from pydantic import BaseModel, Field, field_validator


class RawPosting(BaseModel):
    """One posting as an adapter reports it — pre-normalization,
    pre-dedup. `raw_payload` is the untouched provider response,
    stored on JobSighting for audit/reprocessing; every typed field
    above it is the adapter's best-effort extraction, never invented
    when the source doesn't say (F3.1a: salary stays null rather than
    estimated, same discipline applies to every other optional field
    here)."""

    source_url: str
    external_requisition_id: str | None = None

    title: str
    company_name: str
    location: str | None = None
    remote_policy: str | None = None
    seniority: str | None = None
    employment_type: str | None = None

    salary_min: float | None = None
    salary_max: float | None = None
    salary_currency: str | None = None

    posted_at: datetime | None = None
    requirements: str | None = None
    responsibilities: str | None = None
    benefits: str | None = None
    apply_url: str | None = None

    raw_payload: dict[str, Any] = Field(default_factory=dict)

    @field_validator("salary_currency")
    @classmethod
    def _currency_upper(cls, v: str | None) -> str | None:
        return v.upper() if v else v


class ConnectionTestResult(BaseModel):
    ok: bool
    status: str  # "ok" / "auth_failed" / "unreachable"
    error: str | None = None


class SourceAdapter:
    """One adapter per source. `adapter_key` is the stable identifier
    stored on the Source row (Source.adapter_key) — renaming a class
    or module must never change it, since existing Source/SourceRun
    rows reference it by string."""

    adapter_key: str
    display_name: str
    # F2.1/F11.2 — declared here so the shared HTTP policy (M1 §2) can
    # apply the right limits without the adapter re-implementing them.
    requires_auth: bool = True
    default_rate_limit_per_minute: int = 30
    # Declared here, same reasoning as requires_auth/default_rate_limit:
    # the radar orchestrator needs to know before it calls search() at
    # all, not find out from a billing surprise. A credit-metered
    # source charges real money per search call, independent of how
    # many jobs it returns or whether the call even succeeds — found
    # live with SocialFetch, whose query-expansion-generated variants
    # burned real credits per variant. True here means the caller
    # skips query expansion for this source and searches only the
    # literal role title, one real call per title per run.
    credit_metered: bool = False

    async def test_connection(self, config: dict[str, Any]) -> ConnectionTestResult:
        raise NotImplementedError

    async def search(self, query: str, filters: dict[str, Any], config: dict[str, Any]) -> list[RawPosting]:
        raise NotImplementedError

    async def fetch_detail(self, url: str, config: dict[str, Any]) -> RawPosting:
        raise NotImplementedError
