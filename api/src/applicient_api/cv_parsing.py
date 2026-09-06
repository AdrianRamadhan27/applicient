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

from applicient_api.llm_retry import invoke_structured_with_retry

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
    title: str | None = Field(
        default=None,
        description=(
            "The specific role, degree, certificate, or project name — e.g. "
            "'Machine Learning Engineer Intern', 'B.Sc. Computer Science', "
            "'AWS Certified Solutions Architect'. NEVER the organization "
            "name — that belongs in `employer` below, even when the source "
            "writes them together like 'Bangkit Academy — Machine Learning "
            "Cohort' (employer='Bangkit Academy', title='Machine Learning "
            "Cohort', not the whole string jammed into employer)."
        ),
    )
    text: str = Field(description="One clear, standalone sentence describing a single accomplishment.")
    skills: list[str] = Field(default_factory=list, description="Technologies, languages, tools actually named or clearly implied.")
    employer: str | None = Field(default=None, description="Employer, school, or organization this happened at, if stated — the organization only, never combined with the role/degree/program name (see `title`).")
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
    headline: str | None = Field(
        default=None,
        description=(
            "A SHORT professional headline or current role/title ONLY — e.g. 'Senior Data "
            "Scientist' or 'Machine Learning Engineer at Bank Mega'. A few words, at most one "
            "short phrase. NEVER a multi-sentence description of skills/experience — that's what "
            "`summary` below is for; confirmed live as a real bug otherwise (a full paragraph "
            "landed here and rendered as a wall of text right under the candidate's name)."
        ),
    )
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

How granular to be:
- One item per DISTINCT, SUBSTANTIVE accomplishment — not one item per bullet point or per sentence in the source.
- experience: one item per substantive accomplishment within a role (typically 1-4 per role, not one per bullet).
- education: one item per degree/program — combine institution, degree, field, and dates into that single item. Do not create a separate item per course or transcript line.
- certification: one item per certificate/credential.
- project: one item per project, unless a project has multiple genuinely distinct, independently-describable achievements.
- skill: at most one or two items summarizing tooling/technology breadth as a whole — never one item per individual skill/tool (those belong in the `skills` list field on relevant experience/project items instead).
- achievement: awards, publications, competitions — one item each.

Other rules:
- `employer` is the organization only (company, school, issuing body). `title` is the role/degree/certificate/project name only. Keep them separate even when the source writes them on one line joined by a dash or "at" — e.g. source "Bangkit Academy — Machine Learning Cohort" becomes employer="Bangkit Academy", title="Machine Learning Cohort", never employer="Bangkit Academy — Machine Learning Cohort" with title left empty.
- Never invent facts, numbers, dates, or skills not present in the source text. If a date isn't stated, leave it null rather than guessing.
- Rewrite each item as a clear, standalone sentence in past tense (present tense only if explicitly ongoing) — do not copy sentence fragments verbatim if the source is telegraphic bullet-point shorthand, but never add claims the source doesn't support.
- Skills should be concrete named technologies/tools/languages, not vague soft-skill words."""


def parse_cv_text(model: BaseChatModel, cv_text: str) -> ExtractedCV:
    # No dedup/merge pass over `result.evidence_items` here on purpose
    # — an earlier version of this function DID collapse same-role
    # items by concatenating their `text` fields into one, which
    # fixed the "5 duplicated CV entries for one role" symptom but
    # broke something worse: EvidenceItem.text is documented as ONE
    # standalone sentence, so smashing 5 sentences into one field
    # produced a single run-on paragraph with no bullet structure at
    # all — confirmed live (Adrian: "the issue is in the parser not
    # just the renderer") once the tailoring engine echoed that merged
    # blob back as one oversized bullet instead of several. The real,
    # correct fix lives at the RENDER layer instead — see
    # latex_rendering.py's `_render_category_block`, which groups
    # `TailoredSection`s by (title, employer) at render time and keeps
    # every section's own bullets as separate `\item`s under one
    # shared heading. Leaving each bullet as its OWN EvidenceItem here
    # is what makes that possible — it's also strictly better for
    # everything downstream that treats an EvidenceItem as one atomic,
    # independently citable claim (scoring, verification, tailoring
    # selection), which a pre-merged paragraph is not.
    #
    # method="function_calling" rather than the default (which
    # auto-selects strict json_schema mode for models that advertise
    # support) — the real fix for CV parsing's own reported latency.
    # Root-caused live, not guessed: against the actual deployed
    # "deep"-tier model, the default json_schema path made it reason
    # heavily before answering (one real call: 3413 of 4193 output
    # tokens were hidden reasoning, ~37s wall time) even though nothing
    # about this task benefits from chain-of-thought. Forcing
    # `reasoning: {enabled: false}` via extra_body also cut latency,
    # but repeated live runs showed it made THIS model's output
    # actively less reliable — a stray mid-generation "wait, the source
    # says…" fragment leaking straight into a structured field more
    # than once, presumably the model's own reasoning habit spilling
    # into the answer channel once the dedicated one is switched off.
    # method="function_calling" alone sidesteps the json_schema path
    # entirely: same tool-calling shape this codebase's other
    # structured-output calls already use, consistently ~5s across
    # repeated runs with reasoning_tokens=0 (confirmed via real
    # LlmCall rows) and no reasoning-channel default to fight with, so
    # nothing needed changing in tier_resolution.py at all.
    structured_model = model.with_structured_output(ExtractedCV, method="function_calling")
    messages = [
        ("system", _SYSTEM_PROMPT),
        ("user", cv_text),
    ]
    # Adrian, direct: reported intermittent — the exact same real CV
    # ("no extractable accomplishments") failed once, then parsed fine
    # (27 real evidence items) on an immediate retry with nothing else
    # changed. invoke_structured_with_retry (llm_retry.py, already used
    # by scoring/tailoring/verification for the SAME model tier) covers
    # two known-transient shapes — a reasoning model burning its whole
    # budget internally and emitting no content, and a bare network
    # blip — but neither of those raises here silently as "0 items";
    # they'd surface as a real exception instead. This is a THIRD,
    # distinct flakiness shape: the call fully succeeds and returns a
    # valid ExtractedCV, but the model itself missed the task and
    # returned an empty list. A real, non-trivial CV (already confirmed
    # non-blank by cv.py's own `if not cv_text.strip()` check before
    # any LLM call ever happens) essentially never has ZERO genuinely
    # extractable accomplishments, so an empty result on the first
    # attempt is far more likely a missed attempt than a real one —
    # worth one retry before accepting it, same "retry once, let the
    # caller decide" discipline invoke_structured_with_retry itself
    # already follows for its own two shapes.
    #
    # A second, real-world variant of the same flakiness (Adrian, direct,
    # a different account's own CV): evidence_items came back genuinely
    # populated (30 real items, saved fine) while `profile` came back
    # with EVERY field null — cv.py's own save step (`profile.
    # parsed_profile = extracted.profile.model_dump(..., exclude_none=True)`)
    # then persists a bare `{}`, discarding a name/email/phone the same
    # source text plainly contains (confirmed live: re-parsing the exact
    # same stored file moments later returned a fully populated profile).
    # `_completeness` below scores both halves independently so a retry
    # gets credit for fixing EITHER dimension, and the two attempts are
    # compared rather than blindly preferring the second — a retry that
    # regresses (e.g. gains a profile but loses the evidence items) must
    # never overwrite a first attempt that already got the harder half
    # right.
    result = invoke_structured_with_retry(structured_model, messages)
    if not isinstance(result, ExtractedCV):
        raise ExtractionError(f"structured output call returned unexpected type: {type(result)}")
    if _completeness(result) < 2:
        retried = invoke_structured_with_retry(structured_model, messages)
        if isinstance(retried, ExtractedCV) and _completeness(retried) > _completeness(result):
            return retried
    return result


def _profile_has_signal(profile: ExtractedProfile) -> bool:
    """True the moment the model extracted ANY real candidate-level
    fact. A genuine CV (already confirmed non-blank by cv.py's own
    `if not cv_text.strip()` check, before any LLM call happens) has a
    name and/or contact details essentially every time — a completely
    empty profile object is far more likely a model miss on that half
    of the task than a real absence of the information."""
    return bool(
        profile.full_name or profile.email or profile.phone or profile.headline or profile.summary or profile.location
    )


def _completeness(cv: ExtractedCV) -> int:
    """0-2: whether each independent half of the extraction (the
    evidence bank, the candidate profile) came back with real data.
    Used only to compare a first attempt against a retry — never a
    pass/fail gate on its own (a genuinely thin CV, e.g. one job and no
    stated contact info, is a real result this codebase must still
    accept, not force into looking "complete")."""
    return (1 if cv.evidence_items else 0) + (1 if _profile_has_signal(cv.profile) else 0)


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
