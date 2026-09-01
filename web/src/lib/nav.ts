export type NavItem = {
  href: string;
  label: string;
  section: "Work" | "System" | "Admin";
  // SaaS pivot — only rendered for a signed-in user whose role is
  // "admin" (app-shell.tsx filters NAV_ITEMS against useAuth().user).
  // The backend enforces this independently (current_admin_user, real
  // 403s) — this flag is UX, not the security boundary.
  adminOnly?: boolean;
};

// Matches the rail nav in design/Main.dc.html, plus /profile — Profile
// Studio wasn't in the original mockup's rail but step 6 built it as a
// real screen, so it earns a nav entry now. Settings is still missing
// (PRD §6) — added when it actually gets built.
export const NAV_ITEMS: NavItem[] = [
  // M7 — the conversational orchestrator; first in "Work" since it's
  // now the primary entry point that drives the other four.
  { href: "/assistant", label: "Assistant", section: "Work" },
  { href: "/notifications", label: "Notifications", section: "Work" },
  { href: "/email-review", label: "Email Review", section: "Work" },
  { href: "/profile", label: "Profile Studio", section: "Work" },
  { href: "/radar", label: "Radar", section: "Work" },
  { href: "/inbox", label: "Job Inbox", section: "Work" },
  { href: "/composer", label: "Composer", section: "Work" },
  { href: "/pipeline", label: "Pipeline", section: "Work" },
  { href: "/billing", label: "Billing", section: "Work" },
  { href: "/run-console", label: "Run Console", section: "System" },
  { href: "/events", label: "Events", section: "System" },
  // SaaS pivot — moved from "System" (visible to every signed-in user)
  // to "Admin" (adminOnly): the operator configures which LLM
  // providers/models power the whole deployment and is the only one
  // who sees raw cost internals; regular users never did and now
  // structurally can't (routers/providers.py, model_profiles.py,
  // cost.py all require current_admin_user).
  { href: "/models", label: "Models", section: "Admin", adminOnly: true },
  { href: "/credentials", label: "Credentials", section: "Admin", adminOnly: true },
  { href: "/cost", label: "Cost", section: "Admin", adminOnly: true },
  { href: "/admin/users", label: "Users", section: "Admin", adminOnly: true },
  { href: "/admin/plans", label: "Plans", section: "Admin", adminOnly: true },
];
