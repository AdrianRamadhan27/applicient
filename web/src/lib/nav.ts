import {
  Bell,
  BotMessageSquare,
  CalendarDays,
  Cpu,
  CreditCard,
  type LucideIcon,
  DollarSign,
  FileText,
  Image,
  Inbox,
  KeyRound,
  Layers,
  LayoutDashboard,
  Mail,
  Mic,
  Radar,
  Settings,
  Terminal,
  Users,
  Workflow,
} from "lucide-react";

export type NavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
  section: "Work" | "System" | "Admin";
  // SaaS pivot — only rendered for a signed-in user whose role is
  // "admin" (app-shell.tsx filters NAV_ITEMS against useAuth().user).
  // The backend enforces this independently (current_admin_user, real
  // 403s) — this flag is UX, not the security boundary.
  adminOnly?: boolean;
};

// Ordered to mirror the actual work sequence (build a profile -> find
// jobs -> tailor -> apply -> track), not the order features happened
// to get built in — Dashboard first since nothing downstream means
// anything without a profile, raised directly by Adrian after the
// original build-order left it buried in the middle of the list.
// Phase 14 (v2 plan) — every authenticated page lives under /console/*
// now (app-shell.tsx's own AUTHENTICATED_HOME is the same /console
// page this Dashboard item points at, not a separate page). Profile
// Studio was later merged straight into this Dashboard as its own
// tabs (Preferences/Profile/Experience) alongside a new Overview tab
// — also raised directly by Adrian — so this one entry now covers
// what used to be two separate nav items.
export const NAV_ITEMS: NavItem[] = [
  { href: "/console", label: "Dashboard", icon: LayoutDashboard, section: "Work" },
  { href: "/console/assistant", label: "Assistant", icon: BotMessageSquare, section: "Work" },
  { href: "/console/radar", label: "Job Search", icon: Radar, section: "Work" },
  { href: "/console/inbox", label: "Job Inbox", icon: Inbox, section: "Work" },
  { href: "/console/composer", label: "CV Composer", icon: FileText, section: "Work" },
  { href: "/console/pipeline", label: "Application Pipeline", icon: Workflow, section: "Work" },
  // Phase 11 (v2 plan) — placed right after Pipeline: you practice
  // once you're actually in the running for a role.
  { href: "/console/interview-practice", label: "Interview Practice", icon: Mic, section: "Work" },
  { href: "/console/calendar", label: "Calendar", icon: CalendarDays, section: "Work" },
  { href: "/console/email-review", label: "Email Review", icon: Mail, section: "Work" },

  // Account-level connections/settings, not a step in the job-search
  // pipeline itself.
  // Credentials was previously (incorrectly) marked adminOnly, which
  // hid it from every regular user — routers/credentials.py is
  // current_user_id scoped throughout, nothing admin-specific about
  // it, so that flag was a real bug (it made Gmail connection
  // unreachable for anyone but an admin), not a deliberate
  // restriction. Fixed here.
  { href: "/console/credentials", label: "Credentials", icon: KeyRound, section: "System" },
  { href: "/console/billing", label: "Billing", icon: CreditCard, section: "System" },
  { href: "/console/notifications", label: "Notifications", icon: Bell, section: "System" },
  // Account identity (email, password) — deliberately NOT the same
  // thing as the CV/Persona "Profile Studio" tab inside Dashboard
  // (?tab=profile), which is job-search material, not account
  // security. Named "Settings" rather than "Profile" specifically to
  // avoid that collision.
  { href: "/console/settings", label: "Settings", icon: Settings, section: "System" },

  // SaaS pivot — the operator configures which LLM providers/models
  // power the whole deployment and is the only one who sees raw cost
  // internals; regular users never did and now structurally can't
  // (routers/providers.py, model_profiles.py, cost.py all require
  // current_admin_user). Run Console moved here on request — every
  // signed-in user could reach it before (routers/streaming.py is
  // current_user_id scoped, not actually admin-gated server-side),
  // this is a deliberate UI-only restriction, not a bug fix like
  // Credentials above.
  { href: "/console/models", label: "Models", icon: Cpu, section: "Admin", adminOnly: true },
  { href: "/console/cost", label: "Cost", icon: DollarSign, section: "Admin", adminOnly: true },
  { href: "/console/run-console", label: "Run Console", icon: Terminal, section: "Admin", adminOnly: true },
  { href: "/console/admin/users", label: "Users", icon: Users, section: "Admin", adminOnly: true },
  { href: "/console/admin/plans", label: "Plans", icon: Layers, section: "Admin", adminOnly: true },
  // Landing-page CMS (Adrian, direct: media only — demo video + each
  // screenshot slot, no admin extensibility beyond that scope).
  { href: "/console/admin/site-content", label: "Landing Page", icon: Image, section: "Admin", adminOnly: true },
];
