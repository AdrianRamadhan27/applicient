"""Chat-driven LaTeX editing for a rendered CV, replacing the removed
manual "Edit LaTeX" textarea in Composer (raised by Adrian — the
Assistant should do this per a plain-English instruction instead of
requiring the user to hand-edit LaTeX themselves).

A single structured-output LLM call over the current .tex source and
a natural-language instruction, not a diff/patch — simpler and more
reliable for a document this size (a few hundred lines), and it's
exactly the shape `save_document_tex_override` already expects: a
full replacement source, the same as a manual hand-edit would have
produced.
"""

from __future__ import annotations

from langchain_core.language_models.chat_models import BaseChatModel
from pydantic import BaseModel, Field

from applicient_api.llm_retry import invoke_structured_with_retry


class LatexEditOutput(BaseModel):
    tex: str = Field(
        description="The complete, revised .tex document source — the whole file, never a diff or just the changed lines."
    )


_SYSTEM_PROMPT = """You edit a candidate's LaTeX CV/resume source per a specific instruction from the candidate.

Rules:
- Return the COMPLETE, revised .tex document — never a diff, snippet, or just the changed lines.
- Keep every LaTeX package, macro definition, and structural element (\\documentclass, \\begin{document}/\\end{document}, existing \\newcommand macros) intact and valid — the result must still compile.
- Make only the change the instruction actually asks for (e.g. remove a section, reword a bullet, reorder entries, adjust formatting) — never invent a new fact (employer, title, date, metric, skill) that wasn't already somewhere in the source.
- Removing content the candidate asks to remove (e.g. an irrelevant role, a stale bullet) is real editorial control, not fabrication — always allowed.
- If the instruction is ambiguous, make the most reasonable literal interpretation rather than asking a follow-up question — you cannot ask one from here."""


def run_latex_edit(model: BaseChatModel, *, current_tex: str, instruction: str) -> str:
    structured = model.bind(max_tokens=8000).with_structured_output(LatexEditOutput)
    prompt = f"INSTRUCTION: {instruction}\n\nCURRENT .tex SOURCE:\n{current_tex}"
    result = invoke_structured_with_retry(structured, [("system", _SYSTEM_PROMPT), ("user", prompt)])
    if not isinstance(result, LatexEditOutput):
        raise RuntimeError(f"latex-edit structured output call returned unexpected type: {type(result)}")
    return result.tex
