""""Fix my CV" — general evidence-bank wording improvement, NOT
tailored to any specific job group, but informed by the persona's own
preferences (target roles/seniority) for emphasis/word choice.
Rewrites each weak evidence item's own `text` field for clarity/impact;
never touches title/employer/dates/metrics/skills (those are facts,
not wording) and never invents a new fact, number, or skill the
original text didn't already support — confirmed directly with
Adrian: "wording only... never invents facts/metrics".

Distinct from tailoring_engine.py: tailoring SELECTS a subset of
evidence and rewords it for a specific job group, producing a
Document a user can discard/regenerate freely. This rewrites the
master evidence bank itself, in place (cv_review_service.py applies
the returned revisions as real EvidenceItem.text updates) — a
standing improvement every future tailored CV builds on, not a
per-document draft. Same reason it costs credits (confirmed directly
— unlike cv_score_engine.py's free scoring pass): a real, lasting
change to the evidence bank is worth more than a one-off preview."""

from __future__ import annotations

import uuid

from langchain_core.language_models.chat_models import BaseChatModel
from pydantic import BaseModel, Field

from applicient_api.llm_retry import invoke_structured_with_retry


class CvFixItem(BaseModel):
    evidence_id: uuid.UUID = Field(description="Must be a real id from the evidence bank given to you.")
    revised_text: str = Field(
        description="The improved standalone sentence(s) — same facts/numbers/skills as the original, just reworded for clarity/impact."
    )


class CvFixOutput(BaseModel):
    items: list[CvFixItem] = Field(
        description=(
            "One entry per evidence item that genuinely needed improvement — omit items that are "
            "already strong as written. Do not rewrite for the sake of rewriting; an empty list is a "
            "valid, honest answer for an already-strong evidence bank."
        )
    )
    notes: str = Field(description="One short paragraph summarizing what kinds of changes were made overall, or why none were needed.")


_SYSTEM_PROMPT = """You improve the WORDING of a candidate's evidence bank entries — never their facts.

For each entry that's weak (vague, passive voice, missing clear impact framing, awkward or redundant phrasing), rewrite ONLY its `text` into a clearer, more impactful standalone sentence — active voice, concrete, professional, past tense (present only if explicitly ongoing).

Hard rules:
- NEVER invent a number, metric, employer, title, date, or skill that isn't already stated in the original text. If the original has no quantified impact, do not add a fabricated one — improve the framing/clarity instead.
- NEVER change what actually happened, who it was for, or when — only how it's phrased.
- Skip entries that are already clear and well-written — only include entries you're genuinely improving, in `items`. Rewriting something that's already good just to have output is a failure, not thoroughness.
- If preferences/target roles are given below, let them guide which ANGLE to foreground in your phrasing (e.g. lead with the ML angle of a project for an ML-track candidate) — never invent content to better match a target role, only choose which true detail to lead with."""


def run_cv_fix(model: BaseChatModel, *, profile_summary: str, evidence_bank_summary: str) -> CvFixOutput:
    # method="function_calling" — same real fix cv_parsing.py's own
    # comment documents in detail: the default (strict json_schema)
    # structured-output path made the deployed model reason heavily
    # before answering, live-confirmed to make a real evidence bank
    # (30+ items) exceed a 120s timeout with no output at all;
    # function_calling sidesteps that reasoning path entirely.
    # max_tokens bumped for the same reason tailoring_engine.py's own
    # run_tailoring binds it — a full evidence-bank-wide rewrite is
    # long enough to exceed a provider's default output budget.
    structured = model.bind(max_tokens=8000).with_structured_output(CvFixOutput, method="function_calling")
    prompt = f"CANDIDATE:\n{profile_summary}\n\nEVIDENCE BANK (cite evidence_id exactly as shown):\n{evidence_bank_summary}"
    result = invoke_structured_with_retry(structured, [("system", _SYSTEM_PROMPT), ("user", prompt)])
    if not isinstance(result, CvFixOutput):
        raise RuntimeError(f"cv fix structured output call returned unexpected type: {type(result)}")
    return result
