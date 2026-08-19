"""Pydantic DTOs for the provider/model-catalog layer (F12). Thin for
now — just what the connection service and the eventual API routes
need; the API routes keep the transport layer separate from these DTOs.
"""

from __future__ import annotations

import uuid
from datetime import date, datetime

from pydantic import BaseModel, ConfigDict, Field


class ProviderConnectionCreate(BaseModel):
    provider: str
    api_key: str
    base_url: str | None = None
    label: str | None = None


class ProviderConnectionOut(BaseModel):
    """Never includes the raw or encrypted key — api_key_hint only
    (F12.6)."""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    provider: str
    label: str | None
    api_key_hint: str | None
    base_url: str | None
    status: str
    last_verified_at: datetime | None
    last_error: str | None


class ModelCatalogEntryOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    model_id: str
    display_name: str | None
    context_window: int | None
    max_output: int | None
    capabilities: list[str]
    input_price_per_mtok: float | None
    output_price_per_mtok: float | None
    cache_read_price_per_mtok: float | None
    cache_write_price_per_mtok: float | None
    pricing_version: str | None
    pricing_known: bool
    fetched_at: datetime


# --- F1 Profile / EvidenceItem (step 4 CRUD stubs) ---


class ParsedProfile(BaseModel):
    """Schema-validated candidate-level data produced by CV ingest."""

    full_name: str | None = None
    headline: str | None = None
    email: str | None = None
    phone: str | None = None
    location: str | None = None
    links: list[str] = Field(default_factory=list)
    summary: str | None = None
    skills: list[str] = Field(default_factory=list)


class ProfileOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    user_id: uuid.UUID
    revision: int
    confirmed: bool
    parsed_profile: ParsedProfile
    parsed_at: datetime | None
    visa_status: str | None
    notice_period_days: int | None


class ProfileUpdate(BaseModel):
    confirmed: bool | None = None
    parsed_profile: ParsedProfile | None = None
    visa_status: str | None = None
    notice_period_days: int | None = None


class EvidenceItemCreate(BaseModel):
    category: str = "other"  # EvidenceCategory
    text: str
    skills: list[str] = Field(default_factory=list)
    metrics: dict = Field(default_factory=dict)
    employer: str | None = None
    date_start: str | None = None  # ISO date string; parsed at the route boundary
    date_end: str | None = None


class EvidenceItemOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    profile_id: uuid.UUID
    category: str
    text: str
    skills: list[str]
    metrics: dict
    employer: str | None
    date_start: date | None
    date_end: date | None
    verified: bool
    embedded: bool


class CVParseResult(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    agent_run_id: uuid.UUID
    profile: ProfileOut
    evidence_items: list[EvidenceItemOut]
    cost_usd: float


class EvidenceItemUpdate(BaseModel):
    category: str | None = None
    text: str | None = None
    skills: list[str] | None = None
    metrics: dict | None = None
    employer: str | None = None
    date_start: str | None = None
    date_end: str | None = None
    verified: bool | None = None


# --- F12 model routing (minimal GUI-managed preset) ---


class ModelProfileOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str
    is_active: bool
    tier_bindings: dict[str, str]
    stage_overrides: dict[str, str]


class ModelProfileUpdate(BaseModel):
    name: str = "openrouter-budget"
    tier_bindings: dict[str, uuid.UUID]
    stage_overrides: dict[str, uuid.UUID] = Field(default_factory=dict)


# --- F13 Cost & Usage (minimal, step 7) ---


class LlmCallOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    agent_run_id: uuid.UUID | None
    stage: str | None
    subagent_name: str | None
    provider: str
    model_id: str
    tier: str | None
    input_tokens: int
    output_tokens: int
    cache_read_tokens: int
    cache_write_tokens: int
    cost_usd: float
    cost_known: bool
    status: str
    latency_ms: int | None
    created_at: datetime


class CostSummary(BaseModel):
    total_cost_usd: float
    total_calls: int
    unknown_cost_calls: int
    by_stage: dict[str, float]
    recent_calls: list[LlmCallOut]
