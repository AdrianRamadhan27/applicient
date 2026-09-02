import type { Metadata } from "next";
import { IBM_Plex_Mono, IBM_Plex_Sans } from "next/font/google";
import { ThemeProvider } from "@/components/theme-provider";
import { AuthProvider } from "@/lib/auth";
import { PersonaProvider } from "@/components/persona-provider";
import { AppShell } from "@/components/app-shell";
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
const DESCRIPTION =
  "Applicient discovers job openings across boards and ATS sites, scores them honestly against your real experience, drafts a tailored CV it can prove is truthful, fills the application, and keeps your pipeline updated from your inbox.";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: "Applicient — Make your job applications efficient",
    template: "%s · Applicient",
  },
  description: DESCRIPTION,
  keywords: [
    "job application agent",
    "AI job search",
    "CV tailoring",
    "job board aggregator",
    "ATS application tracker",
    "resume verification",
  ],
  openGraph: {
    type: "website",
    url: "/",
    siteName: "Applicient",
    title: "Applicient — Make your job applications efficient",
    description: DESCRIPTION,
  },
  twitter: {
    card: "summary_large_image",
    title: "Applicient — Make your job applications efficient",
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
              <AppShell>{children}</AppShell>
              <Toaster />
            </PersonaProvider>
          </AuthProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
