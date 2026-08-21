"""M3 §4/F5.4 — the adversarial claim verifier (hard gate).

Deliberately receives only the master profile's full evidence bank and
the generated CV delta's own text — never the job posting or the
JobGroup it was tailored for, so it cannot be argued into a claim by
what the role wants. Classifies every claim as SUPPORTED / REFRAMED_OK
/ UNSUPPORTED / INFLATED (models/enums.py ClaimVerdict).

Judged against the WHOLE evidence bank, not just what the tailoring
step happened to cite — a bullet citing the wrong evidence_id for
something that's still genuinely true elsewhere in the bank is a
provenance bug worth catching on its own, but this verifier's actual
question is narrower and stricter: is this claim, as written, true of
this candidate at all. That's what "adversarial" means here — it
doesn't get to assume the tailoring step's own citations were correct.
"""

from __future__ import annotations

from typing import Literal

from langchain_core.language_models.chat_models import BaseChatModel
from pydantic import BaseModel, Field

from applicient_api.llm_retry import invoke_structured_with_retry
from applicient_api.models.profile import EvidenceItem
from applicient_api.tailoring_engine import evidence_bank_summary

_VERIFIER_SYSTEM_PROMPT = """You are an adversarial fact-checker reviewing a candidate's tailored CV against their own evidence bank. You do NOT see the job posting this CV was written for — you cannot be persuaded by what a role wants; your only question is whether the candidate's own evidence bank actually supports every claim in this CV.

For each claim (the summary, and every bullet), classify:
- supported: directly and clearly backed by the evidence bank.
- reframed_ok: a true fact from the evidence bank, reworded/reframed for emphasis or relevance, without inventing anything new.
- unsupported: not backed by anything in the evidence bank at all — the evidence bank never states this.
- inflated: has a real basis in the evidence bank but overstates it — bigger scope, higher seniority, a different/larger metric, a skill only adjacent to what's actually shown, etc.

Be adversarial: your job is to catch anything that isn't real, not to be generous or assume good faith. Quote the exact claim text you're judging. Cite which evidence_id(s), if any, actually back it — omit evidence_ids entirely for unsupported claims."""


class ClaimVerdictItem(BaseModel):
    claim_text: str = Field(description="The exact claim text being judged — the summary sentence(s), or one bullet.")
    verdict: Literal["supported", "reframed_ok", "unsupported", "inflated"]
    evidence_ids: list[str] = Field(default_factory=list, description="Evidence item ids (as given in the bank) that actually back this claim, if any.")
    rationale: str = Field(description="One sentence: why this verdict.")


class ClaimVerificationOutput(BaseModel):
    claims: list[ClaimVerdictItem]


def run_claim_verification(
    model: BaseChatModel, *, claims_text: str, evidence_items: list[EvidenceItem]
) -> ClaimVerificationOutput:
    """`claims_text` is pre-formatted by the caller — `tailoring_engine.
    tailoring_claims_text` for a CV, `cover_letter_engine.cover_letter_claims_text`
    for a cover letter — so this verifier stays doc-type-agnostic; its
    only job is judging whatever claims it's handed against the
    evidence bank, never caring what kind of document they came from.

    Same truncation risk as tailoring_engine.run_tailoring — one claim
    per bullet/paragraph plus its rationale adds up fast on a document
    with several sections.
    """

    structured = model.bind(max_tokens=8000).with_structured_output(ClaimVerificationOutput)
    prompt = (
        f"CANDIDATE'S FULL EVIDENCE BANK:\n{evidence_bank_summary(evidence_items)}\n\n"
        f"GENERATED DOCUMENT CLAIMS TO VERIFY:\n{claims_text}"
    )
    result = invoke_structured_with_retry(structured, [("system", _VERIFIER_SYSTEM_PROMPT), ("user", prompt)])
    if not isinstance(result, ClaimVerificationOutput):
        raise RuntimeError(f"claim verification structured output call returned unexpected type: {type(result)}")
    return result


def all_claims_clean(output: ClaimVerificationOutput) -> bool:
    return all(c.verdict in ("supported", "reframed_ok") for c in output.claims)
