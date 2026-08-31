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

export const metadata: Metadata = {
  title: "Applicient",
  description: "An agentic job-application system.",
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
