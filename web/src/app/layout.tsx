import type { Metadata } from "next";
import { IBM_Plex_Mono, IBM_Plex_Sans } from "next/font/google";
import { ThemeProvider } from "@/components/theme-provider";
import { AuthProvider } from "@/lib/auth";
import { PersonaProvider } from "@/components/persona-provider";
import { ConversationProvider } from "@/lib/conversation-provider";
import { AppShell } from "@/components/app-shell";
import { InsufficientCreditsProvider } from "@/components/insufficient-credits-provider";
import { Toaster } from "@/components/ui/sonner";
import "./globals.css";

const ibmPlexSans = IBM_Plex_Sans({
  variable: "--font-sans",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});

const ibmPlexMono = IBM_Plex_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});

const SITE_URL = process.env.SITE_URL ?? "https://applicient.my.id";
// Front-loads the exact keyword clusters Adrian wants findable (AI job
// search, AI CV tailoring, AI interview practice, auto-apply) within
// Google's ~155-char SERP snippet window, while staying strictly
// accurate to what the product does — no overclaiming beyond what the
// real pipeline (discovery -> score -> tailor -> apply -> track ->
// interview practice) actually delivers. Shared across meta
// description/OG/Twitter/JSON-LD (single source of truth) — a longer
// tail after the keyword-dense opening is fine for those surfaces,
// which don't truncate as aggressively as a Google snippet does.
const DESCRIPTION =
  "AI-powered job search, honest scoring, verified CV tailoring, guided auto-apply, and realistic AI interview practice — everything grounded in your real experience, never fabricated. Applicient discovers openings across job boards and ATS sites, drafts a tailored CV it can prove is truthful, fills the application, and keeps your pipeline updated from your inbox.";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: "Applicient — AI Job Search, CV Tailoring & Auto-Apply Agent",
    template: "%s · Applicient",
  },
  description: DESCRIPTION,
  keywords: [
    "AI job search",
    "AI job apply",
    "job application agent",
    "AI CV tailoring",
    "CV tailoring",
    "AI resume builder",
    "AI interview practice",
    "interview AI",
    "auto apply jobs AI",
    "job board aggregator",
    "ATS application tracker",
    "resume verification",
  ],
  alternates: {
    canonical: "/",
  },
  openGraph: {
    type: "website",
    url: "/",
    siteName: "Applicient",
    title: "Applicient — AI Job Search, CV Tailoring & Auto-Apply Agent",
    description: DESCRIPTION,
  },
  twitter: {
    card: "summary_large_image",
    title: "Applicient — AI Job Search, CV Tailoring & Auto-Apply Agent",
    description: DESCRIPTION,
  },
  robots: { index: true, follow: true },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${ibmPlexSans.variable} ${ibmPlexMono.variable} h-full antialiased`}
    >
      {/* Some browser security extensions (Bitdefender/Avast-family
          "web protection" scanners are the common case) inject
          bis_skin_checked/bis_register/__processed_*__ attributes into
          the DOM right after SSR paint but before React hydrates —
          suppressHydrationWarning on body stops React from flagging
          that specific, harmless mismatch, matching the same pattern
          already used on <html> above for next-themes. */}
      <body className="min-h-full" suppressHydrationWarning>
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
          <AuthProvider>
            <PersonaProvider>
              <ConversationProvider>
                <AppShell>{children}</AppShell>
                <InsufficientCreditsProvider />
                <Toaster />
              </ConversationProvider>
            </PersonaProvider>
          </AuthProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
