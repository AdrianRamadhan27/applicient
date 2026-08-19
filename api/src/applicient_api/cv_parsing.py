"""F1.1/F1.2 — CV ingest → structured evidence bank.

Deliberately NOT a deepagents agent: extracting a bounded list of
accomplishments from a fixed document is a single well-defined
transformation, not an open-ended task needing planning or tool use.
Step 4 already showed deepagents' own middleware adds real token
overhead (~2.5k tokens before the actual prompt) — worth paying for
genuinely agentic work, not for one structured-output call. This is a
direct `deep`-tier LLM call with a Pydantic output schema instead.
"""

from __future__ import annotations

import io
from datetime import date, datetime

import pypdf
from dateutil import parser as dateutil_parser
from docx import Document as DocxDocument
from langchain_core.language_models.chat_models import BaseChatModel
from pydantic import BaseModel, Field

# dateutil fills in missing day/month from this default when the
# source only gave e.g. "Jan 2024" — pins day=1 so a month-only date
# doesn't silently inherit today's day-of-month.
_DATE_PARSE_DEFAULT = datetime(2000, 1, 1)


class ExtractionError(Exception):
    pass


def extract_text(filename: str, content: bytes) -> str:
    lower = filename.lower()
    if lower.endswith(".pdf"):
        reader = pypdf.PdfReader(io.BytesIO(content))
        return "\n\n".join(page.extract_text() or "" for page in reader.pages)
    if lower.endswith(".docx"):
        doc = DocxDocument(io.BytesIO(content))
        return "\n".join(p.text for p in doc.paragraphs if p.text.strip())
    raise ExtractionError(f"unsupported file type: {filename!r} — only .pdf and .docx are supported")


class ExtractedEvidenceItem(BaseModel):
    """One atomic, citable accomplishment (PRD F1.2) — the unit the
    tailoring agent will later select from and the claim verifier will
    check claims against (F5.3/F5.4). Rewritten as a clean standalone
    statement, not copied verbatim if the source phrasing is fragmented
    bullet-point shorthand."""

    category: str = Field(
        description="One of: experience, education, certification, project, achievement, skill, other."
    )
    text: str = Field(description="One clear, standalone sentence describing a single accomplishment.")
    skills: list[str] = Field(default_factory=list, description="Technologies, languages, tools actually named or clearly implied.")
    employer: str | None = Field(default=None, description="Employer, school, or organization this happened at, if stated.")
    date_start: str | None = Field(default=None, description="ISO date (YYYY-MM-DD) or None if not determinable. Use the 1st of the month if only month/year is given.")
    date_end: str | None = Field(default=None, description="ISO date, or None if ongoing/current.")
    metrics: dict[str, str] = Field(default_factory=dict, description="Any concrete numbers mentioned, e.g. {\"queries_per_day\": \"2000\"}.")


class ExtractedProfile(BaseModel):
    """The candidate-level fields that are useful before an evidence item
    is selected for a persona or tailored document.

    All fields are optional because a CV can omit contact details or a
    summary. Lists stay structured so the Profile Studio can edit them later
    without reparsing the source document.
    """

    full_name: str | None = Field(default=None, description="Candidate's name exactly as stated in the CV.")
    headline: str | None = Field(default=None, description="Professional headline or current role, if stated.")
    email: str | None = Field(default=None, description="Email address exactly as stated, if present.")
    phone: str | None = Field(default=None, description="Phone number exactly as stated, if present.")
    location: str | None = Field(default=None, description="Candidate location exactly as stated, if present.")
    links: list[str] = Field(default_factory=list, description="Portfolio, LinkedIn, GitHub, or other URLs stated in the CV.")
    summary: str | None = Field(default=None, description="Professional summary, rewritten only for clear grammar and without new claims.")
    skills: list[str] = Field(default_factory=list, description="Distinct named technologies, tools, languages, and methods from the CV.")


class ExtractedCV(BaseModel):
    profile: ExtractedProfile = Field(default_factory=ExtractedProfile)
    evidence_items: list[ExtractedEvidenceItem]


_SYSTEM_PROMPT = """You extract a structured candidate profile and atomic, individually-citable accomplishment records from a CV/resume.

First populate `profile` from explicit candidate-level information. Keep names,
contact details, locations, and URLs faithful to the source. Leave a field null
or empty when the source does not contain it. Do not infer a location from a
phone prefix or an email domain.

Every item gets a category: experience, education, certification, project, achievement, skill, or other.

How granular to be — this is the part that most often goes wrong, so read it carefully:
- One item per DISTINCT, SUBSTANTIVE accomplishment — not one item per bullet point or per sentence in the source. If the source has three bullets under one role that are really describing the same underlying piece of work from slightly different angles (e.g. "built X", "X served 2000 users/day", "X was containerized for deployment"), that is most often ONE accomplishment with several details — merge it into ONE item, and put every detail from all those bullets into that single item's text and metrics. Only split into separate items when the source genuinely describes separate, independent pieces of work.
- Before finalizing, check your own output: if two items share the same employer/project and their `text` fields would look repetitive or like restatements of each other to a human reader, merge them. Near-duplicate items are a failure, not thoroughness.
- experience: one item per substantive accomplishment within a role (typically 1-4 per role, not one per bullet).
- education: one item per degree/program — combine institution, degree, field, and dates into that single item. Do not create a separate item per course or transcript line.
- certification: one item per certificate/credential.
- project: one item per project, unless a project has multiple genuinely distinct, independently-describable achievements.
- skill: at most one or two items summarizing tooling/technology breadth as a whole — never one item per individual skill/tool (those belong in the `skills` list field on relevant experience/project items instead).
- achievement: awards, publications, competitions — one item each.

Other rules:
- Never invent facts, numbers, dates, or skills not present in the source text. If a date isn't stated, leave it null rather than guessing.
- Rewrite each item as a clear, standalone sentence in past tense (present tense only if explicitly ongoing) — do not copy sentence fragments verbatim if the source is telegraphic bullet-point shorthand, but never add claims the source doesn't support.
- Skills should be concrete named technologies/tools/languages, not vague soft-skill words."""


def parse_cv_text(model: BaseChatModel, cv_text: str) -> ExtractedCV:
    structured_model = model.with_structured_output(ExtractedCV)
    result = structured_model.invoke(
        [
            ("system", _SYSTEM_PROMPT),
            ("user", cv_text),
        ]
    )
    if not isinstance(result, ExtractedCV):
        raise ExtractionError(f"structured output call returned unexpected type: {type(result)}")
    return result


def parse_loose_date(value: str | None) -> date | None:
    """LLM structured output does not reliably honor "use ISO format"
    field instructions — a live run against the deep-tier model
    returned "Jan 2024" instead of "2024-01-01" despite the schema
    description asking for ISO. Trusting the model to identify that a
    date exists and roughly what it is, not to format it exactly, is
    the boundary that actually holds. Never raises: an unparseable
    date becomes None rather than failing the whole CV parse."""

    if not value:
        return None
    try:
        return dateutil_parser.parse(value, default=_DATE_PARSE_DEFAULT).date()
    except (ValueError, OverflowError):
        return None
