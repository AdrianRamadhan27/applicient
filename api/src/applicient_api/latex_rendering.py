"""M3 §3/F5.2/F5.11 — LaTeX→PDF rendering, the primary renderer, via
Tectonic (confirmed installed and working: /opt/homebrew/bin/tectonic
0.16.9 — a single XeTeX-based engine, not pdfTeX/LuaTeX; there is no
engine choice to make here, Tectonic only has the one).

Template assets live in renderers/latex_templates/<template_id>/
(sibling to api/, web/, sources/ at the repo root), each a real .tex
skeleton using this template's own macros. Filling one in is
template-specific — a different template's macros differ, so this is
a small per-template Python function registry (TEMPLATES below), not a
generic templating language; adding a template means adding one
function + a metadata entry, not touching the shared render/compile
path (`render_pdf`).

A pdfTeX-only primitive (`\\pdfgentounicode`/`glyphtounicode.tex`) was
in the first template received from Adrian and does not exist under
Tectonic's XeTeX engine — removed from the template source (confirmed
live: without it, the compiled PDF's text layer is still real and
ATS-parseable via pypetextractextraction, since XeTeX's own embedded
OpenType font handling already produces correct ToUnicode mappings;
that pdfTeX-era hack was never actually needed here).

Every field written into `.tex` source is escaped (`latex_escape`) —
these come from LLM-generated tailoring output and user-entered
profile data, both untrusted as far as LaTeX special characters go;
an unescaped `%`, `&`, or `\\` from either would corrupt or, in the
worst case, let untrusted text inject LaTeX commands.
"""

from __future__ import annotations

import subprocess
import tempfile
import uuid
from dataclasses import dataclass
from datetime import date
from pathlib import Path

from applicient_api.cover_letter_engine import CoverLetterOutput
from applicient_api.models.profile import EvidenceItem
from applicient_api.tailoring_engine import TailoringOutput

TEMPLATES_DIR = Path(__file__).resolve().parents[3] / "renderers" / "latex_templates"

_LATEX_ESCAPE_MAP = {
    "\\": r"\textbackslash{}",
    "&": r"\&",
    "%": r"\%",
    "$": r"\$",
    "#": r"\#",
    "_": r"\_",
    "{": r"\{",
    "}": r"\}",
    "~": r"\textasciitilde{}",
    "^": r"\textasciicircum{}",
}


def latex_escape(text: str | None) -> str:
    if not text:
        return ""
    return "".join(_LATEX_ESCAPE_MAP.get(ch, ch) for ch in text)


def _format_date(d: date | None) -> str:
    return d.strftime("%b %Y") if d else ""


def _format_date_range(start: date | None, end: date | None) -> str:
    if start and end:
        return f"{_format_date(start)} -- {_format_date(end)}"
    if start and not end:
        return f"{_format_date(start)} -- Present"
    return ""


class RenderError(Exception):
    pass


@dataclass
class RenderResult:
    pdf_bytes: bytes
    log: str


def _render_category_block(
    title: str, *, delta: TailoringOutput, evidence_by_id: dict[uuid.UUID, EvidenceItem], categories: set[str]
) -> str:
    """One `\\section{...}` block for every delta section whose cited
    evidence item falls in `categories` — same generic
    `\\resumeSubheading` + bullet-list shape for every category
    (experience, education, achievement, certification, project) — a
    stated simplification (not the template's own more specific
    `\\projectSubheading`/`\\certItem` macros), but a real one: every
    category is now actually driven by the tailoring delta rather than
    only Experience being dynamic and the rest silently discarded.
    EvidenceItem has no location field, so that slot is always blank.
    Returns "" (no heading at all) when nothing in the delta matches —
    an empty `\\section{}` with nothing under it looks broken, not
    just sparse."""

    entries = []
    for section in delta.sections:
        item = evidence_by_id.get(section.evidence_id)
        if item is None or item.category not in categories:
            continue
        entry_title = latex_escape(item.title or item.employer or "")
        employer = latex_escape(item.employer or "")
        dates = latex_escape(_format_date_range(item.date_start, item.date_end))
        bullets = "\n".join(f"    \\item\\small{{{latex_escape(b.text)}}}" for b in section.bullets)
        entries.append(
            "  \\resumeSubheading\n"
            f"    {{{entry_title}}}{{{dates}}}\n"
            f"    {{{employer}}}{{}}\n"
            "  \\resumeBulletList\n"
            f"{bullets}\n"
            "  \\resumeBulletListEnd\n"
        )
    if not entries:
        return ""
    return f"\\section{{{title}}}\n\\resumeSubHeadingList\n" + "\n".join(entries) + "\n\\resumeSubHeadingListEnd\n"


def _render_jakes_resume_adrian(
    *, delta: TailoringOutput, evidence_by_id: dict[uuid.UUID, EvidenceItem], header: dict
) -> str:
    """Fills renderers/latex_templates/jakes-resume-adrian/resume.tex's
    macros from a TailoringOutput. Every evidence category the delta
    can cite (experience, education, achievement, certification,
    project — everything except skill, which has no bullet-worthy
    prose of its own) gets its own dynamically-generated section now;
    previously only Experience was — Education/Achievements/
    Certifications/Projects were the *template's own* hand-authored
    content (Adrian's real resume, unconditionally, for every user)
    and anything the tailoring model selected from those categories
    was silently dropped. Fixed here: the skeleton file itself carries
    no real personal data any more (see its own header comment), and
    every section below is populated from the actual evidence bank."""

    template_path = TEMPLATES_DIR / "jakes-resume-adrian" / "resume.tex"
    skeleton = template_path.read_text()

    experience_block = _render_category_block(
        "Experience", delta=delta, evidence_by_id=evidence_by_id, categories={"experience", "other"}
    )
    education_block = _render_category_block(
        "Education", delta=delta, evidence_by_id=evidence_by_id, categories={"education"}
    )
    achievements_block = _render_category_block(
        "Achievements", delta=delta, evidence_by_id=evidence_by_id, categories={"achievement"}
    )
    certifications_block = _render_category_block(
        "Certifications \\& Licenses", delta=delta, evidence_by_id=evidence_by_id, categories={"certification"}
    )
    projects_block = _render_category_block(
        "Projects", delta=delta, evidence_by_id=evidence_by_id, categories={"project"}
    )

    skills_block = ""
    if delta.skills_highlight:
        skills_line = ", ".join(latex_escape(s) for s in delta.skills_highlight)
        skills_block = (
            "\\section{Skills}\n\\resumeSubHeadingList\n"
            f"  \\resumeItem{{\\textbf{{Core skills:}} {skills_line}}}\n"
            "\\resumeSubHeadingListEnd\n"
        )

    # `\cvlink`/`\href`'s FIRST argument (the actual URL target) must
    # stay raw, not latex_escape'd — hyperref parses it in its own
    # URL-safe mode where `%`/`&`/`#`/`_` are already handled
    # correctly, and running it through latex_escape would literally
    # corrupt the link (e.g. a real "%" in a query string becoming the
    # two characters "\%"). Only the visible label (second argument)
    # goes through latex_escape, same as any other displayed text.
    links = " \\quad$|$\\quad ".join(
        f"\\cvlink{{{link}}}{{{latex_escape(link)}}}" for link in header.get("links", [])
    )
    contact_line_parts = [p for p in [header.get("location"), header.get("phone")] if p]
    contact_line = " \\quad$|$\\quad ".join(latex_escape(p) for p in contact_line_parts)
    if header.get("email"):
        raw_email = header["email"]
        contact_line += f" \\quad$|$\\quad \\cvlink{{mailto:{raw_email}}}{{{latex_escape(raw_email)}}}"

    header_block = (
        "\\begin{center}\n"
        f"  {{\\LARGE\\bfseries {latex_escape(header.get('full_name') or '')}}} \\\\[4pt]\n"
        "  \\large\n"
        f"  \\textbf{{{latex_escape(header.get('headline') or '')}}} \\\\[4pt]\n"
        "  \\small\n"
        f"  {contact_line} \\\\[2pt]\n"
        f"  {links}\n"
        "\\end{center}\n"
    )

    summary_block = f"\\section{{Summary}}\n{latex_escape(delta.summary)}\n"

    # Every section between the skeleton's own banner markers is
    # replaced wholesale — the skeleton carries no real content of its
    # own any more (see its header comment), just the banner fences
    # `_replace_between` splices against.
    doc = skeleton
    doc = _replace_between(doc, "%  HEADER", "%  SUMMARY", header_block)
    doc = _replace_between(doc, "%  SUMMARY", "%  EXPERIENCE", summary_block)
    doc = _replace_between(doc, "%  EXPERIENCE", "%  EDUCATION", experience_block)
    doc = _replace_between(doc, "%  SKILLS", "%  LANGUAGES", skills_block)
    doc = _replace_between(doc, "%  EDUCATION", "%  ACHIEVEMENTS", education_block)
    doc = _replace_between(doc, "%  ACHIEVEMENTS", "%  CERTIFICATIONS", achievements_block)
    doc = _replace_between(doc, "%  CERTIFICATIONS", "%  PROJECTS", certifications_block)
    doc = _replace_between(doc, "%  PROJECTS", "%  END", projects_block)
    return doc


def _replace_between(doc: str, start_marker: str, end_marker: str, replacement: str) -> str:
    """Each section is fenced by a 3-line banner
    (`% ───\n%  NAME\n% ───`). Replaces everything strictly between the
    close of `start_marker`'s banner and the open of `end_marker`'s
    banner, keeping both banners themselves — and everything in the
    document after `end_marker`'s banner — intact."""

    marker_pos = doc.index(start_marker)
    content_start = doc.index("\n", marker_pos) + 1  # end of the marker's own line
    content_start = doc.index("\n", content_start) + 1  # end of the banner-close line below it

    end_marker_pos = doc.index(end_marker, content_start)
    content_end = doc.rindex("% ─", content_start, end_marker_pos)  # start of the next banner-open line

    return doc[:content_start] + replacement + "\n" + doc[content_end:]


TEMPLATES = {
    # The dict key/directory name (renderers/latex_templates/jakes-resume-adrian/)
    # stays as-is — it's an internal id only, persisted on existing
    # Document.template rows; renaming it would need a data migration
    # for zero user-facing benefit. "name" below is the only thing a
    # user ever sees (composer/page.tsx's template <Select> renders
    # `t.name`, never `t.id`).
    "jakes-resume-adrian": {
        "name": "ATS 1",
        "description": "A clean, ATS-safe single-column LaTeX resume template.",
        "render": _render_jakes_resume_adrian,
    },
}


def _render_simple_letter(*, delta: CoverLetterOutput, header: dict) -> str:
    """A cover letter isn't shaped like a CV (no sections/evidence
    entries) and doesn't need the resume template's macro system — a
    standard business-letter layout, generated inline rather than as
    a separate on-disk skeleton, since there's nothing here complex
    enough to warrant one."""

    name = latex_escape(header.get("full_name") or "")
    contact_parts = [p for p in [header.get("email"), header.get("phone"), header.get("location")] if p]
    contact_line = " \\quad$|$\\quad ".join(latex_escape(p) for p in contact_parts)
    body_paragraphs = "\n\n".join(latex_escape(p.text) for p in delta.paragraphs)
    greeting = latex_escape(delta.greeting)
    closing = latex_escape(delta.closing).replace("\n", r" \\" + "\n")

    return (
        # 10pt + `fullpage` (not 11pt + `geometry`/`parskip`) —
        # deliberately reuses only packages the resume template's own
        # compile already proved are cached (size10.clo, fullpage.sty).
        # Found live: this sandbox currently can't reach Tectonic's
        # bundle relay at all (curl itself gets "couldn't resolve
        # host" for the exact URL Tectonic's own error named), so any
        # not-yet-cached package fails outright — this isn't a
        # cosmetic preference. `\parindent`/`\parskip` are core TeX
        # primitives, not a package, so blank-line-separated
        # paragraphs get sensible spacing with zero new dependencies.
        "\\documentclass[10pt]{article}\n"
        "\\usepackage[empty]{fullpage}\n"
        "\\parindent 0pt\n"
        "\\parskip 1em\n"
        "\\pagestyle{empty}\n"
        "\\begin{document}\n\n"
        f"{{\\large\\bfseries {name}}}\\\\\n"
        f"{contact_line}\n\n"
        "\\vspace{1em}\n\n"
        f"{greeting}\n\n"
        f"{body_paragraphs}\n\n"
        f"{closing}\n\n"
        "\\end{document}\n"
    )


COVER_LETTER_TEMPLATES = {
    "simple-letter": {
        "name": "Simple Letter",
        "description": "A clean, standard business-letter layout.",
        "render": _render_simple_letter,
    },
}


def generate_tex(template_id: str, *, delta: TailoringOutput, evidence_items: list[EvidenceItem], header: dict) -> str:
    """The delta→.tex step alone, split out from compiling so the
    Composer can show/let the user hand-edit the raw source before it
    ever reaches Tectonic (raised by Adrian: the AI output is a draft,
    not a final answer)."""

    entry = TEMPLATES.get(template_id)
    if entry is None:
        raise RenderError(f"unknown template {template_id!r} — known templates: {list(TEMPLATES)}")

    evidence_by_id = {item.id: item for item in evidence_items}
    return entry["render"](delta=delta, evidence_by_id=evidence_by_id, header=header)


def generate_cover_letter_tex(template_id: str, *, delta: CoverLetterOutput, header: dict) -> str:
    entry = COVER_LETTER_TEMPLATES.get(template_id)
    if entry is None:
        raise RenderError(
            f"unknown cover letter template {template_id!r} — known templates: {list(COVER_LETTER_TEMPLATES)}"
        )
    return entry["render"](delta=delta, header=header)


def compile_tex(tex_source: str) -> RenderResult:
    """Tectonic compile alone, taking raw .tex source directly — used
    both for a freshly generated delta and for a user's hand-edited
    override, so a manual edit compiles through the exact same path as
    AI-generated output rather than a separate, less-tested one."""

    with tempfile.TemporaryDirectory() as tmp:
        tex_path = Path(tmp) / "document.tex"
        tex_path.write_text(tex_source)
        try:
            proc = subprocess.run(
                ["tectonic", "--outdir", tmp, str(tex_path)],
                capture_output=True,
                text=True,
                timeout=120,
            )
        except subprocess.TimeoutExpired:
            # Most likely a cold Tectonic bundle download (see
            # docker-compose.yml's tectonic-cache volume comment) —
            # previously an unhandled exception here bypassed every
            # router's `except RenderError` and surfaced as a raw 500
            # (or, if the container got killed mid-download by a
            # restart, a connection reset the browser reports as
            # "TypeError: Failed to fetch").
            raise RenderError(
                "PDF compilation timed out after 120s — if this is the first render since a fresh "
                "deploy/restart, Tectonic may still be downloading its font/format bundle; try again "
                "in a minute."
            )
        except FileNotFoundError:
            raise RenderError("the tectonic binary is not installed/on PATH in this environment")
        if proc.returncode != 0:
            raise RenderError(f"tectonic compile failed:\n{proc.stderr[-4000:]}")
        pdf_path = Path(tmp) / "document.pdf"
        if not pdf_path.exists():
            raise RenderError(f"tectonic reported success but produced no PDF:\n{proc.stderr[-2000:]}")
        return RenderResult(pdf_bytes=pdf_path.read_bytes(), log=proc.stderr)
