"use client";

import * as React from "react";
import Link from "next/link";
import { toast } from "sonner";
import {
  Target,
  X,
  ShieldCheck,
  Search,
  FileCheck2,
  MousePointerClick,
  KanbanSquare,
  BotMessageSquare,
  Mic,
  PlayCircle,
  ChevronDown,
  ArrowRight,
  FileText,
  Check,
  Building2,
  Mail,
  Hand,
  ChevronLeft,
  ChevronRight,
  Plus,
} from "lucide-react";
import { api, type Plan } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { TierLabel } from "@/lib/plan-tiers";
import { cn } from "@/lib/utils";
import { ParticleField } from "@/components/particle-field";

// Structure follows the saas-ui-nextjs-landing-page template's own
// section order (announcement banner -> header -> hero -> logos ->
// features -> highlights -> pricing -> faq -> footer), requested
// directly. The visual language does not port from it — this app has
// its own real design system ("Terminal Ledger": zero border-radius,
// IBM Plex Sans/Mono, semantic ok/warn/crit tokens, see globals.css's
// own header comment) already used consistently across every other
// screen, and a landing page that looked like generic default Chakra
// would read as a different, less finished product bolted onto this
// one rather than its front door.

const FEATURES = [
  {
    icon: Search,
    title: "AI job search across every board",
    body: "Search Greenhouse, Lever, Ashby, Workable and more from one plain list of target roles — AI-ranked and deduplicated across sources automatically.",
  },
  {
    icon: ShieldCheck,
    title: "Honest, legible AI scoring",
    body: "Every posting AI-scored dimension by dimension against your real profile, with the exact reasoning and evidence spans shown — never a bare number.",
  },
  {
    icon: FileCheck2,
    title: "Zero-fabrication AI CV tailoring",
    body: "An adversarial AI verifier checks every generated claim against your evidence bank before anything is shown to you. Unsupported claims block export.",
  },
  {
    icon: MousePointerClick,
    title: "Guided AI auto-apply",
    body: "Applicient's AI agent fills the form and stops at the submit button for your review. A captcha or login wall hands the live browser back to you.",
  },
  {
    icon: KanbanSquare,
    title: "Pipeline that tracks itself",
    body: "Application status updates automatically from interview invites, rejections and assessments detected in your inbox.",
  },
  {
    icon: Mic,
    title: "Practice interviews with AI",
    body: "A real spoken back-and-forth with an AI interviewer — or a full group discussion round — scored with structured feedback right after every session.",
  },
];

const FAQ = [
  {
    q: "Is my CV and application data safe?",
    a: "Your CV, evidence bank and email content are only ever used to do the work you asked for — never sold or used for anything else. Passwords, provider credentials and OAuth tokens are encrypted at rest.",
  },
  {
    q: "Is there a free plan?",
    a: "Yes — the Free plan lets you try the full pipeline within a monthly usage cap, no credit card required.",
  },
  {
    q: "Will it submit applications without asking me?",
    a: "No. By default the agent fills a form and stops before the submit button for a full review — every field, every attachment, a screenshot. You decide when something actually gets sent.",
  },
  {
    q: "Is my payment information secure?",
    a: "Payments are handled by Dodo Payments' own embedded checkout — Applicient never sees or stores your card or e-wallet details directly.",
  },
  {
    q: "What happens if I hit my plan's usage limit?",
    a: "New radar runs, applications and document generation pause until your next billing period, or until you upgrade — nothing is ever throttled silently or billed unexpectedly.",
  },
];

// A real product screenshot, framed in this app's own mock-browser
// chrome (same three-dot bar language ApplyDiagram already draws in
// pure CSS) so a real PNG reads as "a window onto the actual app"
// rather than a bare image dropped onto the page. Used for the hero's
// dashboard shot and, smaller, above each carousel slide's own
// animated diagram — one component, two sizes, not two copies of the
// frame markup. Plain `<img>` (not next/image) — this codebase has
// never used the Next image optimizer (would need `sharp` added to
// the Docker image for zero benefit here, since every screenshot is
// already pre-resized to its real display width before being checked
// in, see web/public/screenshots/ — nothing left for a runtime
// optimizer to do).
function ScreenshotFrame({
  src,
  alt,
  width,
  height,
  priority = false,
  className,
}: {
  src: string;
  alt: string;
  width: number;
  height: number;
  priority?: boolean;
  className?: string;
}) {
  return (
    <div className={cn("overflow-hidden border border-border bg-card", className)}>
      <div className="flex items-center gap-1 border-b border-border px-2.5 py-2">
        <span className="size-1.5 shrink-0 bg-border" />
        <span className="size-1.5 shrink-0 bg-border" />
        <span className="size-1.5 shrink-0 bg-border" />
      </div>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={alt}
        width={width}
        height={height}
        loading={priority ? "eager" : "lazy"}
        fetchPriority={priority ? "high" : "auto"}
        className="block h-auto w-full"
      />
    </div>
  );
}

// Illustrates the exact claim-verifier flow the text beside it
// describes — a CV claim goes into the verifier, and only comes out
// SUPPORTED or UNSUPPORTED, reusing the same two badge colors/labels
// already shown in that text column instead of inventing new ones.
function VerifierDiagram() {
  return (
    <div className="flex flex-col items-center gap-4">
      <div className="flex items-center gap-3">
        <div className="flex flex-col items-center gap-1.5 border border-border bg-card px-4 py-3">
          <FileText className="size-5 text-muted-foreground" strokeWidth={1.5} />
          <span className="font-mono text-[9px] text-muted-foreground">CV claim</span>
        </div>
        <ArrowRight className="anim-flow size-4 shrink-0 text-muted-foreground" strokeWidth={1.5} />
        <div className="flex flex-col items-center gap-1.5 border border-primary bg-card px-4 py-3">
          <ShieldCheck className="anim-pop size-5 text-primary" strokeWidth={1.5} />
          <span className="font-mono text-[9px] text-primary">Verifier</span>
        </div>
      </div>
      <div className="h-4 w-px bg-border" />
      <div className="flex flex-wrap items-center justify-center gap-2">
        <div className="anim-fade-cycle flex items-center gap-1.5 border border-ok bg-ok-bg px-3 py-1.5">
          <Check className="size-3.5 shrink-0 text-ok" strokeWidth={1.5} />
          <span className="font-mono text-[9px] text-ok">SUPPORTED</span>
        </div>
        <div className="anim-fade-cycle flex items-center gap-1.5 border border-crit bg-crit-bg px-3 py-1.5" style={{ animationDelay: "1.2s" }}>
          <X className="size-3.5 shrink-0 text-crit" strokeWidth={1.5} />
          <span className="font-mono text-[9px] text-crit">UNSUPPORTED</span>
        </div>
      </div>
    </div>
  );
}

// Sources feeding the scorer, output as a ranked list — three bars of
// decreasing width/color (ok -> warn -> muted) standing in for
// strong_apply/apply/lower-ranked results, same rank colors used on
// every real Job Inbox card.
function DiscoveryDiagram() {
  return (
    <div className="flex flex-col items-center gap-4">
      <div className="flex items-center gap-3">
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-1.5 border border-border bg-card px-3 py-1.5">
            <Search className="size-3.5 shrink-0 text-muted-foreground" strokeWidth={1.5} />
            <span className="font-mono text-[9px] text-muted-foreground">Job boards</span>
          </div>
          <div className="flex items-center gap-1.5 border border-border bg-card px-3 py-1.5">
            <Building2 className="size-3.5 shrink-0 text-muted-foreground" strokeWidth={1.5} />
            <span className="font-mono text-[9px] text-muted-foreground">ATS sites</span>
          </div>
        </div>
        <ArrowRight className="anim-flow size-4 shrink-0 text-muted-foreground" strokeWidth={1.5} />
        <div className="flex flex-col items-center gap-1.5 border border-primary bg-card px-4 py-3">
          <ShieldCheck className="anim-pop size-5 text-primary" strokeWidth={1.5} />
          <span className="font-mono text-[9px] text-primary">Score</span>
        </div>
      </div>
      <div className="h-4 w-px bg-border" />
      <div className="flex w-40 flex-col gap-1.5">
        <div className="anim-fade-cycle h-2 w-full bg-ok" />
        <div className="anim-fade-cycle h-2 w-4/5 bg-warn" style={{ animationDelay: "0.3s" }} />
        <div className="anim-fade-cycle h-2 w-3/5 bg-muted" style={{ animationDelay: "0.6s" }} />
      </div>
    </div>
  );
}

// A mock browser window, filled fields, stopped right at Submit — the
// literal "agent fills the form and stops before the submit button"
// promise, not just described in text.
function ApplyDiagram() {
  return (
    <div className="flex w-48 flex-col border border-border bg-card">
      <div className="flex items-center gap-1 border-b border-border px-2 py-1.5">
        <span className="size-1.5 shrink-0 bg-border" />
        <span className="size-1.5 shrink-0 bg-border" />
        <span className="size-1.5 shrink-0 bg-border" />
      </div>
      <div className="flex flex-col gap-1.5 p-3">
        <div className="h-2 w-full bg-secondary" />
        <div className="h-2 w-4/5 bg-secondary" />
        <div className="h-2 w-3/5 bg-secondary" />
        <div className="mt-1.5 flex items-center justify-between">
          <span className="anim-press border border-primary px-2 py-1 font-mono text-[9px] text-primary">Submit</span>
          <Hand className="anim-hand-stop size-4 shrink-0 text-warn" strokeWidth={1.5} />
        </div>
      </div>
      <div className="flex items-center justify-center gap-1.5 border-t border-warn bg-warn-bg px-2 py-1.5">
        <span className="font-mono text-[9px] text-warn">waiting for your review</span>
      </div>
    </div>
  );
}

// Inbox -> pipeline, with the two most common real detections shown —
// same ok/crit coloring the Application Pipeline board itself uses.
function EmailDiagram() {
  return (
    <div className="flex flex-col items-center gap-4">
      <div className="flex items-center gap-3">
        <div className="flex flex-col items-center gap-1.5 border border-border bg-card px-4 py-3">
          <Mail className="size-5 text-muted-foreground" strokeWidth={1.5} />
          <span className="font-mono text-[9px] text-muted-foreground">Inbox</span>
        </div>
        <ArrowRight className="anim-flow size-4 shrink-0 text-muted-foreground" strokeWidth={1.5} />
        <div className="flex flex-col items-center gap-1.5 border border-primary bg-card px-4 py-3">
          <KanbanSquare className="anim-pop size-5 text-primary" strokeWidth={1.5} />
          <span className="font-mono text-[9px] text-primary">Pipeline</span>
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-center gap-2">
        <div className="anim-fade-cycle border border-ok bg-ok-bg px-3 py-1.5">
          <span className="font-mono text-[9px] text-ok">Interview detected</span>
        </div>
        <div className="anim-fade-cycle border border-crit bg-crit-bg px-3 py-1.5" style={{ animationDelay: "1.2s" }}>
          <span className="font-mono text-[9px] text-crit">Rejection detected</span>
        </div>
      </div>
    </div>
  );
}

// A spoken exchange (mic in, agent voice out), ending in real scored
// feedback — same bordered-box-plus-icon language and anim-* classes
// as every other panel here, not a new visual idiom.
function InterviewPracticeDiagram() {
  return (
    <div className="flex flex-col items-center gap-4">
      <div className="flex items-center gap-3">
        <div className="flex flex-col items-center gap-1.5 border border-primary bg-card px-4 py-3">
          <Mic className="anim-pop size-5 text-primary" strokeWidth={1.5} />
          <span className="font-mono text-[9px] text-primary">You, out loud</span>
        </div>
        <ArrowRight className="anim-flow size-4 shrink-0 text-muted-foreground" strokeWidth={1.5} />
        <div className="flex flex-col items-center gap-1.5 border border-border bg-card px-4 py-3">
          <BotMessageSquare className="size-5 text-muted-foreground" strokeWidth={1.5} />
          <span className="font-mono text-[9px] text-muted-foreground">AI interviewer</span>
        </div>
      </div>
      <div className="h-4 w-px bg-border" />
      <div className="anim-fade-cycle border border-ok bg-ok-bg px-3 py-1.5">
        <span className="font-mono text-[9px] text-ok">Scored feedback</span>
      </div>
    </div>
  );
}

// One panel per major stage of the loop, not just the claim verifier —
// raised directly by Adrian after the verifier panel shipped alone;
// scrolls sideways (scroll-snap, no carousel library — same "no new
// dependency" call already made for the rest of this page) rather than
// stacking four of these tall panels vertically.
const HIGHLIGHTS = [
  {
    eyebrow: "AI job search",
    title: "Every board, one honest AI score",
    body: "Search Greenhouse, Lever, Ashby, Workable and more from one plain list of target roles — deduplicated across sources automatically. Every posting found gets AI-ranked dimension by dimension against your real profile, with the exact reasoning shown, never a bare number.",
    // The Job Search page mid-run alongside the Assistant chat that
    // kicked it off — one real screenshot standing in for two of the
    // pages this whole highlight strip previously had no shot of.
    screenshot: { src: "/screenshots/job-search.png", width: 1400, height: 694 },
    diagram: <DiscoveryDiagram />,
    badges: null as React.ReactNode,
  },
  {
    eyebrow: "The hard guarantee",
    title: "Zero fabricated claims — enforced technically, not just promised",
    body: "Every AI-tailored bullet point is generated with a link back to a real, atomic piece of your evidence bank. A separate, adversarial AI verifier agent then checks each claim — and it never sees the job description, so it can't rationalize inflating something to fit what a role wants. Anything unsupported or inflated blocks export until it's fixed.",
    // CV Composer's real "What changed" diff view — the literal
    // struck-through/inserted text the verifier's pass produces.
    screenshot: { src: "/screenshots/cv-compose.png", width: 1400, height: 645 },
    diagram: <VerifierDiagram />,
    badges: (
      <>
        <Badge variant="secondary" className="font-mono text-[10px]">SUPPORTED</Badge>
        <Badge variant="secondary" className="font-mono text-[10px]">REFRAMED_OK</Badge>
        <Badge variant="secondary" className="bg-crit-bg font-mono text-[10px] text-crit">UNSUPPORTED</Badge>
        <Badge variant="secondary" className="bg-crit-bg font-mono text-[10px] text-crit">INFLATED</Badge>
      </>
    ) as React.ReactNode,
  },
  {
    eyebrow: "AI auto-apply",
    title: "The AI agent applies. You approve the submit.",
    body: "Applicient's AI agent opens the real application form and fills every field — resume, cover letter, screening questions — then stops right before the submit button for your review. A captcha or login wall hands the live browser back to you directly, mid-run.",
    screenshot: { src: "/screenshots/pipeline.png", width: 1400, height: 695 },
    diagram: <ApplyDiagram />,
    badges: null as React.ReactNode,
  },
  {
    eyebrow: "Email analyze",
    title: "Your pipeline updates itself",
    body: "Interview invites, rejections and assessment requests are detected straight from your inbox and reflected on the pipeline board automatically — no manual status updates after you hit apply.",
    screenshot: { src: "/screenshots/track-status.png", width: 1400, height: 745 },
    diagram: <EmailDiagram />,
    badges: null as React.ReactNode,
  },
  {
    eyebrow: "AI interview practice",
    title: "A real spoken AI interview, not a script",
    body: "Practice out loud with an AI interviewer grounded in the actual role and your real experience — or a full group discussion where it plays every other participant. Every session ends with structured, scored feedback.",
    screenshot: { src: "/screenshots/interview.png", width: 1400, height: 770 },
    diagram: <InterviewPracticeDiagram />,
    badges: null as React.ReactNode,
  },
];

const AUTO_ADVANCE_MS = 2800;

// A trailing clone of slide 0, appended after the real slides —
// what makes the loop feel like it keeps going right forever instead
// of animating backward from the last slide to the first. Advancing
// onto the clone looks identical to landing on the real slide 0; once
// that scroll settles, handleScroll snaps the position back to the
// REAL slide 0 with no animation (invisible, since the clone is a
// pixel-identical copy), so the next advance can keep moving right.
const SLIDES = [...HIGHLIGHTS, HIGHLIGHTS[0]];

function HighlightCarousel() {
  const scrollerRef = React.useRef<HTMLDivElement>(null);
  const [active, setActive] = React.useState(0);
  const [paused, setPaused] = React.useState(false);
  const settleTimer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const scrollToIndex = React.useCallback((i: number, smooth = true) => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollTo({ left: i * el.clientWidth, behavior: smooth ? "smooth" : "auto" });
  }, []);

  const advance = React.useCallback(() => {
    const el = scrollerRef.current;
    if (!el || el.clientWidth === 0) return;
    scrollToIndex(Math.round(el.scrollLeft / el.clientWidth) + 1);
  }, [scrollToIndex]);

  function handleScroll() {
    const el = scrollerRef.current;
    if (!el || el.clientWidth === 0) return;
    const index = Math.round(el.scrollLeft / el.clientWidth);
    setActive(index % HIGHLIGHTS.length);

    // Debounced "has scrolling actually stopped" check (native smooth
    // scroll fires continuous scroll events for however long the glide
    // takes, so waiting for events to go quiet — not a fixed delay —
    // is what reliably detects it settled, regardless of duration).
    clearTimeout(settleTimer.current);
    settleTimer.current = setTimeout(() => {
      if (index === HIGHLIGHTS.length) scrollToIndex(0, false);
    }, 150);
  }

  React.useEffect(() => {
    if (paused) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const id = setInterval(advance, AUTO_ADVANCE_MS);
    return () => clearInterval(id);
  }, [paused, advance]);

  return (
    <div onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)}>
      <div
        ref={scrollerRef}
        onScroll={handleScroll}
        className="flex snap-x snap-mandatory overflow-x-auto scroll-smooth [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {SLIDES.map((h, i) => (
          <div key={`${h.eyebrow}-${i}`} className="w-full shrink-0 snap-center px-0.5">
            <div className="grid grid-cols-1 items-center gap-8 border border-border bg-card p-6 sm:p-10 lg:grid-cols-2">
              <div>
                <Eyebrow>{h.eyebrow}</Eyebrow>
                <h2 className="mt-2 text-2xl font-semibold tracking-tight">{h.title}</h2>
                <p className="mt-3 text-sm text-muted-foreground">{h.body}</p>
                {h.badges && <div className="mt-4 flex flex-wrap gap-2">{h.badges}</div>}
              </div>
              <div className="flex flex-col gap-3">
                <ScreenshotFrame
                  src={h.screenshot.src}
                  alt={`${h.eyebrow} in Applicient`}
                  width={h.screenshot.width}
                  height={h.screenshot.height}
                />
                <div className="flex aspect-[3/1] items-center justify-center border border-dashed border-input bg-secondary/40">
                  {h.diagram}
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>
      <div className="mt-4 flex items-center justify-center gap-4">
        <button
          onClick={() => scrollToIndex((active - 1 + HIGHLIGHTS.length) % HIGHLIGHTS.length)}
          className="border border-border p-1.5 text-muted-foreground hover:text-foreground"
          aria-label="Previous"
        >
          <ChevronLeft className="size-4" />
        </button>
        <div className="flex items-center gap-1.5">
          {HIGHLIGHTS.map((h, i) => (
            <button
              key={h.eyebrow}
              onClick={() => scrollToIndex(i)}
              className={cn("size-1.5", i === active ? "bg-primary" : "bg-border")}
              aria-label={`Go to ${h.eyebrow}`}
            />
          ))}
        </div>
        <button onClick={advance} className="border border-border p-1.5 text-muted-foreground hover:text-foreground" aria-label="Next">
          <ChevronRight className="size-4" />
        </button>
      </div>
    </div>
  );
}

// ParticleField (the hero's drifting-square background) now lives in
// components/particle-field.tsx — shared with the auth pages' own
// hero panel (auth-layout.tsx), not redefined here.

// Below the hero — deliberately a different mark (small "+" crosses,
// not the hero's solid squares) so the two fields read as distinct
// layers, not one animation continuing past its own section. Spread
// across the FULL height of the Features->final-CTA wrapper via `top`
// percentages (that wrapper is whatever tall its own content makes
// it, not one viewport), then the whole layer is nudged upward by a
// fraction of the page's own scroll position — real parallax, not
// just another idle drift: scrolling down visibly moves this layer
// up relative to the content passing over it, exactly because it
// moves slower than the page itself does.
const SCROLL_PARTICLE_COUNT = 64;

const SCROLL_PARTICLES = Array.from({ length: SCROLL_PARTICLE_COUNT }, (_, i) => ({
  left: (i * 37 + 5) % 100,
  top: (i * 29 + 9) % 100,
  size: 12 + (i % 3) * 5,
  fadeDuration: 3 + (i % 5) * 0.6,
  fadeDelay: (i % 11) * 0.4,
  // Muted-foreground reads as near-invisible at low opacity in light
  // mode (raised directly after shipping — it genuinely wasn't
  // visible there) — pushed well up, and most particles are primary
  // now rather than a 1-in-4 minority, since a saturated color holds
  // up in both themes at these sizes/opacities in a way a gray tint
  // doesn't.
  opacity: 0.35 + (i % 3) * 0.15,
  primary: i % 3 !== 0,
}));

// Real inertia, not just a lagged readout of scrollY — every scroll
// event adds to a velocity (proportional to how far you just
// scrolled), and a continuously-running rAF loop applies
// `position += velocity` then decays velocity by FRICTION every
// frame. That decay is the entire effect: stop scrolling and the
// layer keeps coasting for a few frames before settling, instead of
// stopping the instant you do. The loop itself only runs while
// velocity is still large enough to matter — no idle rAF burning
// cycles once everything's settled — and restarts on the next scroll.
const SCROLL_GAIN = 0.15; // how much of each scroll delta becomes velocity
const SCROLL_FRICTION = 0.95; // velocity kept per frame — higher coasts longer
const SCROLL_SETTLE_THRESHOLD = 0.02; // px/frame below which the loop stops
// Without a bound, `position` just kept accumulating over the whole
// page's scroll history — after enough scrolling it had drifted the
// entire layer far enough that most of its 64 particles (spread across
// the full Features->CTA height) ended up translated out of the
// overflow-hidden wrapper's box entirely, which is why they visibly
// vanished a section or two down rather than actually settling
// anywhere. Bouncing off a small fixed range instead means the layer
// can never drift more than SCROLL_BOUND from its base alignment —
// "bounded... bounces on screen" was the actual ask, not unbounded
// parallax drift.
const SCROLL_BOUND = 50; // px, max distance from center before it bounces
const SCROLL_BOUNCE_DAMPING = 0.55; // velocity kept (reflected) on each bounce

function ScrollParticleField() {
  const ref = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    let position = 0;
    let velocity = 0;
    let lastScrollY = window.scrollY;
    let rafId: number | undefined;

    function tick() {
      position += velocity;
      if (position > SCROLL_BOUND) {
        position = SCROLL_BOUND;
        velocity = -Math.abs(velocity) * SCROLL_BOUNCE_DAMPING;
      } else if (position < -SCROLL_BOUND) {
        position = -SCROLL_BOUND;
        velocity = Math.abs(velocity) * SCROLL_BOUNCE_DAMPING;
      }
      velocity *= SCROLL_FRICTION;

      const el = ref.current;
      if (el) el.style.transform = `translateY(${position}px)`;

      if (Math.abs(velocity) > SCROLL_SETTLE_THRESHOLD) {
        rafId = requestAnimationFrame(tick);
      } else {
        rafId = undefined;
      }
    }

    function onScroll() {
      const current = window.scrollY;
      // Scrolling down (positive delta) pushes velocity negative, so
      // the layer drifts UP relative to the content — same direction
      // the plain parallax version had, momentum layered on top of it.
      velocity -= (current - lastScrollY) * SCROLL_GAIN;
      lastScrollY = current;
      if (rafId === undefined) rafId = requestAnimationFrame(tick);
    }

    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (rafId !== undefined) cancelAnimationFrame(rafId);
    };
  }, []);

  return (
    <div ref={ref} className="pointer-events-none absolute inset-0 will-change-transform" aria-hidden="true">
      {SCROLL_PARTICLES.map((p, i) => (
        <Plus
          key={i}
          className={cn("anim-fade-cycle absolute", p.primary ? "text-primary" : "text-muted-foreground")}
          style={
            {
              left: `${p.left}%`,
              top: `${p.top}%`,
              width: p.size,
              height: p.size,
              animationDuration: `${p.fadeDuration}s`,
              animationDelay: `${p.fadeDelay}s`,
              "--fade-peak": p.opacity,
            } as React.CSSProperties
          }
          strokeWidth={2}
        />
      ))}
    </div>
  );
}

function Section({ id, className, children }: { id?: string; className?: string; children: React.ReactNode }) {
  return (
    <section id={id} className={cn("mx-auto w-full max-w-7xl px-5 py-16 sm:py-20", className)}>
      {children}
    </section>
  );
}

function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <span className="font-mono text-[11px] tracking-wider uppercase text-primary">{children}</span>
  );
}

export default function LandingPage() {
  const { user } = useAuth();
  const [bannerDismissed, setBannerDismissed] = React.useState(false);
  const [plans, setPlans] = React.useState<Plan[]>([]);
  const [plansLoading, setPlansLoading] = React.useState(true);
  const [openFaq, setOpenFaq] = React.useState<number | null>(0);

  React.useEffect(() => {
    (async () => {
      try {
        setPlans(await api.listBillingPlans());
      } catch (e) {
        toast.error(String(e));
      } finally {
        setPlansLoading(false);
      }
    })();
  }, []);

  const primaryHref = user ? "/console" : "/signup";
  const primaryLabel = user ? "Go to app" : "Get started free";

  return (
    <div className="min-h-screen bg-background text-foreground">
      <script
        type="application/ld+json"
        // Real offers once plans have loaded; omitted (not fabricated)
        // while still loading — same "never invent, leave it out"
        // discipline this codebase applies to real data everywhere
        // else. priceCurrency stays IDR (what price_idr actually is,
        // per models/billing.py) rather than converting to USD with an
        // invented exchange rate.
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({
            "@context": "https://schema.org",
            "@type": "SoftwareApplication",
            name: "Applicient",
            applicationCategory: "BusinessApplication",
            operatingSystem: "Web",
            description:
              "AI-powered job search, honest scoring, verified CV tailoring, guided auto-apply, and realistic AI interview practice — everything grounded in your real experience, never fabricated. Applicient discovers openings across job boards and ATS sites, drafts a tailored CV it can prove is truthful, fills the application, and keeps your pipeline updated from your inbox.",
            ...(plans.length > 0
              ? {
                  offers: plans.map((p) => ({
                    "@type": "Offer",
                    name: p.name,
                    price: String(p.price_idr),
                    priceCurrency: "IDR",
                  })),
                }
              : {}),
          }),
        }}
      />
      {!bannerDismissed && (
        <div className="flex items-center justify-center gap-2 bg-primary px-4 py-1.5 text-center text-xs text-primary-foreground">
          <span>Applicient is in early access — pricing and features may still change.</span>
          <button onClick={() => setBannerDismissed(true)} className="shrink-0 opacity-80 hover:opacity-100" aria-label="Dismiss">
            <X className="size-3.5" />
          </button>
        </div>
      )}

      <header className="sticky top-0 z-10 border-b border-border bg-background/95 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-7xl items-center gap-6 px-5">
          <Link href="/" className="flex items-center gap-2">
            <Target className="size-4 text-primary" strokeWidth={1.5} />
            <span className="font-mono text-sm font-semibold tracking-tight">applicient</span>
          </Link>
          <nav className="hidden items-center gap-5 text-sm text-muted-foreground sm:flex">
            <a href="#features" className="hover:text-foreground">Features</a>
            <a href="#demo" className="hover:text-foreground">Demo</a>
            <a href="#pricing" className="hover:text-foreground">Pricing</a>
            <a href="#faq" className="hover:text-foreground">FAQ</a>
          </nav>
          <div className="ml-auto flex items-center gap-3">
            <ThemeToggle />
            {user ? (
              <Button asChild size="sm">
                <Link href="/console">Go to app</Link>
              </Button>
            ) : (
              <>
                <Button asChild variant="ghost" size="sm">
                  <Link href="/login">Log in</Link>
                </Button>
                <Button asChild size="sm">
                  <Link href="/signup">Sign up</Link>
                </Button>
              </>
            )}
          </div>
        </div>
      </header>

      {/* Hero — text stacks above the dashboard screenshot on small
          screens (plain DOM order, no classes needed); at `lg` it
          becomes a real two-column layout with the screenshot on the
          left and the text on the right (`lg:order-*` swap), raised
          directly by Adrian so the app's actual UI is the very first
          thing a visitor sees instead of a centered wall of text. */}
      <Section className="relative z-0 overflow-hidden pt-20 pb-16 sm:pt-28">
        <ParticleField />
        {/* Explicit position+z-index on BOTH this wrapper and
            ParticleField, as direct siblings under Section — Section's
            own `relative` alone doesn't establish a real stacking
            context (no z-index on it), so ParticleField's old `-z-10`
            had no reliable local scope to sink "just below this hero's
            own text" and could end up painted behind something else
            entirely, several ancestors up. Two siblings with their own
            explicit z-index (0 vs 10) stack correctly against each
            other regardless of that ambiguity. */}
        <div className="relative z-10 grid grid-cols-1 items-center gap-10 lg:grid-cols-2 lg:gap-14">
          <div className="flex flex-col items-center gap-6 text-center lg:order-2 lg:items-start lg:text-left">
            <Badge variant="secondary" className="font-mono text-[10px] tracking-wide uppercase">
              Honest scoring · Verified CVs · Human in control
            </Badge>
            <p className="text-base font-medium sm:text-lg">
              Make your job <span className="text-primary">appli</span>cations effi<span className="text-primary">cient</span>.
            </p>
            <h1 className="text-4xl font-semibold tracking-tight text-balance sm:text-5xl">
              Find the right jobs with AI.<br />Apply with proof, not padding.
            </h1>
            <p className="text-base text-muted-foreground sm:text-lg">
              Applicient&apos;s AI agent discovers openings across job boards and ATS sites, scores them honestly
              against your real experience, drafts a tailored CV it can prove is truthful, fills the
              application, and keeps your pipeline updated from your inbox — plus realistic AI interview
              practice once you land one.
            </p>
            <div className="flex flex-wrap items-center justify-center gap-3 lg:justify-start">
              <Button asChild size="lg">
                <Link href={primaryHref}>{primaryLabel}</Link>
              </Button>
              <Button asChild variant="outline" size="lg">
                <a href="#demo">See how it works</a>
              </Button>
            </div>
            <span className="text-xs text-muted-foreground">No credit card required for the Free plan.</span>
          </div>
          <div className="lg:order-1">
            <ScreenshotFrame
              src="/screenshots/dashboard.png"
              alt="The Applicient dashboard — jobs discovered, applications tracked, and your base CV in one view"
              width={1400}
              height={673}
              priority
            />
          </div>
        </div>
      </Section>

      {/* Everything below the hero shares one scroll-reactive particle
          layer — see ScrollParticleField's own comment for why it's a
          different mark than the hero's, and for the stacking-context
          reasoning (explicit z-index on both this layer and the
          content wrapper as direct siblings, same fix the hero itself
          needed) that keeps it reliably behind this content instead of
          on top of it. */}
      <div className="relative z-0 overflow-hidden">
        <ScrollParticleField />
        <div className="relative z-10">
      {/* Features */}
      <Section id="features">
        <Eyebrow>What it does</Eyebrow>
        <h2 className="mt-2 text-2xl font-semibold tracking-tight sm:text-3xl">
          The whole loop, driven by AI agents
        </h2>
        <div className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((f) => (
            // Adrian, direct: "the 'what it does' cards to be
            // interactable like moves when hovered on" — a real
            // transform (lift + slight scale), not just a color swap,
            // so it reads as physically responding to the cursor. No
            // shadow utility (Terminal Ledger's own no-shadow rule) —
            // the border switching to primary is what sells the
            // "lifted" state instead.
            <div
              key={f.title}
              className="group border border-border bg-card p-5 transition-[transform,border-color] duration-200 ease-out will-change-transform hover:-translate-y-1 hover:scale-[1.02] hover:border-primary"
            >
              <f.icon
                className="size-5 text-primary transition-transform duration-200 ease-out group-hover:scale-110"
                strokeWidth={1.5}
              />
              <h3 className="mt-3 text-sm font-semibold">{f.title}</h3>
              <p className="mt-1.5 text-sm text-muted-foreground">{f.body}</p>
            </div>
          ))}
        </div>
      </Section>

      {/* Highlights: one panel per stage, scrolls sideways */}
      <Section>
        <HighlightCarousel />
      </Section>

      {/* Demo video */}
      <Section id="demo">
        <Eyebrow>See it in action</Eyebrow>
        <h2 className="mt-2 text-2xl font-semibold tracking-tight sm:text-3xl">Watch a full run</h2>
        <div className="mt-6 flex aspect-video w-full flex-col items-center justify-center gap-2 border border-dashed border-input bg-secondary/40">
          <PlayCircle className="size-12 text-muted-foreground" strokeWidth={1} />
          <span className="text-sm text-muted-foreground">Demo video coming soon</span>
        </div>
      </Section>

      {/* Pricing */}
      <Section id="pricing">
        <Eyebrow>Pricing</Eyebrow>
        <h2 className="mt-2 text-2xl font-semibold tracking-tight sm:text-3xl">
          Flat monthly plans, no surprises
        </h2>
        <p className="mt-2 max-w-xl text-sm text-muted-foreground">
          Every plan includes a fixed monthly credit allowance you can always see — never a bill that
          shows up bigger than you expected.
        </p>
        {plansLoading ? (
          <div className="mt-8 text-sm text-muted-foreground font-mono">loading…</div>
        ) : (
          <div className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-3">
            {plans.map((p) => {
              return (
                <div key={p.id} className="flex flex-col gap-4 border border-border bg-card p-6">
                  <div>
                    <TierLabel planName={p.name} className="text-sm font-medium" iconClassName="size-4" />
                    <div className="mt-1 text-2xl font-semibold tracking-tight">
                      {p.price_idr === 0 ? "Free" : `Rp ${p.price_idr.toLocaleString("id-ID")}`}
                      {p.price_idr > 0 && <span className="text-sm font-normal text-muted-foreground">/mo</span>}
                    </div>
                    <span className="mt-1 block text-xs text-muted-foreground font-mono">
                      {p.monthly_credits.toLocaleString()} credits{p.price_idr === 0 ? " to start" : " / mo"}
                    </span>
                  </div>
                  <Button asChild className="mt-auto">
                    <Link href={user ? "/console/billing" : "/signup"}>{user ? "Manage plan" : "Get started"}</Link>
                  </Button>
                </div>
              );
            })}
          </div>
        )}
        <p className="mt-4 text-xs text-muted-foreground">
          Need a boost without a new subscription? You can also buy credits individually — see Buy more credits on
          the Billing page once you&apos;re signed in.
        </p>
      </Section>

      {/* FAQ */}
      <Section id="faq">
        <Eyebrow>FAQ</Eyebrow>
        <h2 className="mt-2 text-2xl font-semibold tracking-tight sm:text-3xl">Questions, answered</h2>
        <div className="mt-6 flex flex-col border border-border">
          {FAQ.map((item, i) => {
            const open = openFaq === i;
            return (
              <div key={item.q} className="border-b border-border last:border-b-0">
                <button
                  onClick={() => setOpenFaq(open ? null : i)}
                  className="flex w-full items-center justify-between gap-4 px-5 py-4 text-left text-sm font-medium hover:bg-secondary/40"
                  aria-expanded={open}
                >
                  {item.q}
                  <ChevronDown className={cn("size-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")} />
                </button>
                {open && <p className="px-5 pb-4 text-sm text-muted-foreground">{item.a}</p>}
              </div>
            );
          })}
        </div>
      </Section>

      {/* Final CTA */}
      <Section className="text-center">
        <div className="border border-border bg-card px-6 py-12">
          <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">
            Stop spraying identical applications.
          </h2>
          <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
            Automate the labor of applying. Keep the judgment of deciding.
          </p>
          <Button asChild size="lg" className="mt-6">
            <Link href={primaryHref}>{primaryLabel}</Link>
          </Button>
        </div>
      </Section>
        </div>
      </div>

      <footer className="border-t border-border">
        <div className="mx-auto flex max-w-7xl flex-col gap-4 px-5 py-10 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2">
            <Target className="size-4 text-primary" strokeWidth={1.5} />
            <span className="font-mono text-sm font-semibold tracking-tight">applicient</span>
          </div>
          <nav className="flex flex-wrap items-center gap-4 text-sm text-muted-foreground">
            <a href="#features" className="hover:text-foreground">Features</a>
            <a href="#pricing" className="hover:text-foreground">Pricing</a>
            <a href="#faq" className="hover:text-foreground">FAQ</a>
            <Link href="/privacy" className="hover:text-foreground">Privacy</Link>
            <Link href="/terms" className="hover:text-foreground">Terms</Link>
            <Link href="/login" className="hover:text-foreground">Log in</Link>
          </nav>
          <span className="text-xs text-muted-foreground">© {new Date().getFullYear()} Applicient</span>
        </div>
      </footer>
    </div>
  );
}
