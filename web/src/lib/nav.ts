export type NavItem = {
  href: string;
  label: string;
  section: "Work" | "System";
};

// Matches the rail nav in design/Main.dc.html, plus /profile — Profile
// Studio wasn't in the original mockup's rail but step 6 built it as a
// real screen, so it earns a nav entry now. Settings is still missing
// (PRD §6) — added when it actually gets built.
export const NAV_ITEMS: NavItem[] = [
  { href: "/profile", label: "Profile Studio", section: "Work" },
  { href: "/radar", label: "Radar", section: "Work" },
  { href: "/inbox", label: "Job Inbox", section: "Work" },
  { href: "/composer", label: "Composer", section: "Work" },
  { href: "/pipeline", label: "Pipeline", section: "Work" },
  { href: "/run-console", label: "Run Console", section: "System" },
  { href: "/events", label: "Events", section: "System" },
  { href: "/models", label: "Models", section: "System" },
  { href: "/cost", label: "Cost", section: "System" },
];
