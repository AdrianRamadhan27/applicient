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
  Coins,
  PlayCircle,
  ChevronDown,
} from "lucide-react";
import { api, type Plan } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

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
    title: "Discovery across every board",
    body: "Search Greenhouse, Lever, Ashby, Workable and more from one plain list of target roles — deduplicated across sources automatically.",
  },
  {
    icon: ShieldCheck,
    title: "Honest, legible scoring",
    body: "Every posting ranked dimension by dimension against your real profile, with the exact reasoning and evidence spans shown — never a bare number.",
  },
  {
    icon: FileCheck2,
    title: "Zero-fabrication CVs",
    body: "An adversarial verifier checks every generated claim against your evidence bank before anything is shown to you. Unsupported claims block export.",
  },
  {
    icon: MousePointerClick,
    title: "Guided execution",
    body: "The agent fills the form and stops at the submit button for your review. A captcha or login wall hands the live browser back to you.",
  },
  {
    icon: KanbanSquare,
    title: "Pipeline that tracks itself",
    body: "Application status updates automatically from interview invites, rejections and assessments detected in your inbox.",
  },
  {
    icon: Coins,
    title: "Cost you can see",
    body: "Every LLM call is metered and priced. Know exactly what a radar run or a tailored CV costs, before and after it runs.",
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
    a: "Payments are handled by Xendit's own hosted checkout page — Applicient never sees or stores your card or e-wallet details directly.",
  },
  {
    q: "What happens if I hit my plan's usage limit?",
    a: "New radar runs, applications and document generation pause until your next billing period, or until you upgrade — nothing is ever throttled silently or billed unexpectedly.",
  },
];

function Section({ id, className, children }: { id?: string; className?: string; children: React.ReactNode }) {
  return (
    <section id={id} className={cn("mx-auto w-full max-w-5xl px-5 py-16 sm:py-20", className)}>
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

  const primaryHref = user ? "/assistant" : "/signup";
  const primaryLabel = user ? "Go to app" : "Get started free";

  return (
    <div className="min-h-screen bg-background text-foreground">
      {!bannerDismissed && (
        <div className="flex items-center justify-center gap-2 bg-primary px-4 py-1.5 text-center text-xs text-primary-foreground">
          <span>Applicient is in early access — pricing and features may still change.</span>
          <button onClick={() => setBannerDismissed(true)} className="shrink-0 opacity-80 hover:opacity-100" aria-label="Dismiss">
            <X className="size-3.5" />
          </button>
        </div>
      )}

      <header className="sticky top-0 z-10 border-b border-border bg-background/95 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-5xl items-center gap-6 px-5">
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
                <Link href="/assistant">Go to app</Link>
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

      {/* Hero */}
      <Section className="flex flex-col items-center gap-6 pt-20 pb-16 text-center sm:pt-28">
        <Badge variant="secondary" className="font-mono text-[10px] tracking-wide uppercase">
          Honest scoring · Verified CVs · Human in control
        </Badge>
        <h1 className="max-w-2xl text-4xl font-semibold tracking-tight text-balance sm:text-5xl">
          Find the right jobs.<br />Apply with proof, not padding.
        </h1>
        <p className="max-w-xl text-base text-muted-foreground sm:text-lg">
          Applicient discovers openings across job boards and ATS sites, scores them honestly against
          your real experience, drafts a tailored CV it can prove is truthful, fills the application,
          and keeps your pipeline updated from your inbox.
        </p>
        <div className="flex flex-wrap items-center justify-center gap-3">
          <Button asChild size="lg">
            <Link href={primaryHref}>{primaryLabel}</Link>
          </Button>
          <Button asChild variant="outline" size="lg">
            <a href="#demo">See how it works</a>
          </Button>
        </div>
        <span className="text-xs text-muted-foreground">No credit card required for the Free plan.</span>
      </Section>

      {/* Features */}
      <Section id="features">
        <Eyebrow>What it does</Eyebrow>
        <h2 className="mt-2 text-2xl font-semibold tracking-tight sm:text-3xl">
          The whole loop, agent-driven
        </h2>
        <div className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((f) => (
            <div key={f.title} className="border border-border bg-card p-5">
              <f.icon className="size-5 text-primary" strokeWidth={1.5} />
              <h3 className="mt-3 text-sm font-semibold">{f.title}</h3>
              <p className="mt-1.5 text-sm text-muted-foreground">{f.body}</p>
            </div>
          ))}
        </div>
      </Section>

      {/* Highlight: claim verifier */}
      <Section>
        <div className="grid grid-cols-1 items-center gap-8 border border-border bg-card p-6 sm:p-10 lg:grid-cols-2">
          <div>
            <Eyebrow>The hard guarantee</Eyebrow>
            <h2 className="mt-2 text-2xl font-semibold tracking-tight">
              Zero fabricated claims — enforced technically, not just promised
            </h2>
            <p className="mt-3 text-sm text-muted-foreground">
              Every tailored bullet point is generated with a link back to a real, atomic piece of
              your evidence bank. A separate, adversarial verifier agent then checks each claim —
              and it never sees the job description, so it can&apos;t rationalize inflating something to
              fit what a role wants. Anything unsupported or inflated blocks export until it&apos;s fixed.
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              <Badge variant="secondary" className="font-mono text-[10px]">SUPPORTED</Badge>
              <Badge variant="secondary" className="font-mono text-[10px]">REFRAMED_OK</Badge>
              <Badge variant="secondary" className="bg-crit-bg font-mono text-[10px] text-crit">UNSUPPORTED</Badge>
              <Badge variant="secondary" className="bg-crit-bg font-mono text-[10px] text-crit">INFLATED</Badge>
            </div>
          </div>
          <div className="flex aspect-square items-center justify-center border border-dashed border-input bg-secondary/40">
            <ShieldCheck className="size-16 text-muted-foreground" strokeWidth={1} />
          </div>
        </div>
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
          Every plan includes a hardcoded monthly usage cap you can always see — never a bill that
          shows up bigger than you expected.
        </p>
        {plansLoading ? (
          <div className="mt-8 text-sm text-muted-foreground font-mono">loading…</div>
        ) : (
          <div className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-3">
            {plans.map((p) => (
              <div key={p.id} className="flex flex-col gap-4 border border-border bg-card p-6">
                <div>
                  <span className="text-sm font-medium">{p.name}</span>
                  <div className="mt-1 text-2xl font-semibold tracking-tight">
                    {p.price_idr === 0 ? "Free" : `Rp ${p.price_idr.toLocaleString("id-ID")}`}
                    {p.price_idr > 0 && <span className="text-sm font-normal text-muted-foreground">/mo</span>}
                  </div>
                  <span className="mt-1 block text-xs text-muted-foreground font-mono">
                    ${p.monthly_usage_cap_usd.toFixed(2)} usage cap / mo
                  </span>
                </div>
                <Button asChild className="mt-auto">
                  <Link href={user ? "/billing" : "/signup"}>{user ? "Manage plan" : "Get started"}</Link>
                </Button>
              </div>
            ))}
          </div>
        )}
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

      <footer className="border-t border-border">
        <div className="mx-auto flex max-w-5xl flex-col gap-4 px-5 py-10 sm:flex-row sm:items-center sm:justify-between">
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
