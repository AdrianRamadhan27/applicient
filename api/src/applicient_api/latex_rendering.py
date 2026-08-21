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


def _render_jakes_resume_adrian(
    *, delta: TailoringOutput, evidence_by_id: dict[uuid.UUID, EvidenceItem], header: dict
) -> str:
    """Fills renderers/latex_templates/jakes-resume-adrian/resume.tex's
    macros from a TailoringOutput. Every non-skill evidence category
    (experience/education/certification/project/achievement) is
    rendered through the template's generic `\\resumeSubheading` +
    bullet-list shape rather than the template's own more specific
    `\\projectSubheading`/`\\certItem` macros — a stated simplification
    for this first working version, not a claim of pixel-perfect
    fidelity to the hand-authored original. EvidenceItem has no
    location field, so the location slot is always left blank."""

    template_path = TEMPLATES_DIR / "jakes-resume-adrian" / "resume.tex"
    skeleton = template_path.read_text()

    # The received template already has its own authored Education/
    # Achievements/Certifications sections (real data, left untouched
    # below) — routing every delta section into "Experience"
    # regardless of the evidence item's real category would mislabel
    # an education/achievement entry under an "Experience" heading, so
    # only experience/project/other-categorized evidence lands here.
    # Regenerating Education/Achievements/Certifications from the
    # delta too is a real, stated gap for a later pass, not built here.
    EXPERIENCE_LIKE_CATEGORIES = {"experience", "project", "other"}

    sections_tex = []
    for section in delta.sections:
        item = evidence_by_id.get(section.evidence_id)
        if item is None or item.category not in EXPERIENCE_LIKE_CATEGORIES:
            continue
        title = latex_escape(item.title or item.employer or "")
        employer = latex_escape(item.employer or "")
        dates = latex_escape(_format_date_range(item.date_start, item.date_end))
        bullets = "\n".join(f"    \\item\\small{{{latex_escape(b.text)}}}" for b in section.bullets)
        sections_tex.append(
            "  \\resumeSubheading\n"
            f"    {{{title}}}{{{dates}}}\n"
            f"    {{{employer}}}{{}}\n"
            "  \\resumeBulletList\n"
            f"{bullets}\n"
            "  \\resumeBulletListEnd\n"
        )
    experience_block = (
        "\\section{Experience}\n\\resumeSubHeadingList\n" + "\n".join(sections_tex) + "\n\\resumeSubHeadingListEnd\n"
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

    # The skeleton's own header/summary/experience/skills sections are
    # replaced wholesale (everything between the fixed HEADER/SUMMARY/
    # EXPERIENCE/SKILLS markers the received template already has as
    # plain comments) rather than the education/achievements/
    # certifications/projects sections below them, which stay as
    # authored — this delta only ever regenerates the tailored parts,
    # never invents unrelated CV sections.
    doc = skeleton
    doc = _replace_between(doc, "%  HEADER", "%  SUMMARY", header_block)
    doc = _replace_between(doc, "%  SUMMARY", "%  EXPERIENCE", summary_block)
    doc = _replace_between(doc, "%  EXPERIENCE", "%  EDUCATION", experience_block)
    doc = _replace_between(doc, "%  SKILLS", "%  LANGUAGES", skills_block)
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
    "jakes-resume-adrian": {
        "name": "Jake's Resume (Adrian)",
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
        proc = subprocess.run(
            ["tectonic", "--outdir", tmp, str(tex_path)],
            capture_output=True,
            text=True,
            timeout=120,
        )
        if proc.returncode != 0:
            raise RenderError(f"tectonic compile failed:\n{proc.stderr[-4000:]}")
        pdf_path = Path(tmp) / "document.pdf"
        if not pdf_path.exists():
            raise RenderError(f"tectonic reported success but produced no PDF:\n{proc.stderr[-2000:]}")
        return RenderResult(pdf_bytes=pdf_path.read_bytes(), log=proc.stderr)
