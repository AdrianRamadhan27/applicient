import {
  Bell,
  Bot,
  CalendarDays,
  Cpu,
  CreditCard,
  type LucideIcon,
  DollarSign,
  FileText,
  Inbox,
  KeyRound,
  Layers,
  Mail,
  Radar,
  Terminal,
  UserCircle,
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
// to get built in — Profile Studio first since nothing downstream
// means anything without it, raised directly by Adrian after the
// original build-order left it buried in the middle of the list.
export const NAV_ITEMS: NavItem[] = [
  { href: "/profile", label: "Profile Studio", icon: UserCircle, section: "Work" },
  { href: "/assistant", label: "Assistant", icon: Bot, section: "Work" },
  { href: "/radar", label: "Job Search", icon: Radar, section: "Work" },
  { href: "/inbox", label: "Job Inbox", icon: Inbox, section: "Work" },
  { href: "/composer", label: "CV Composer", icon: FileText, section: "Work" },
  { href: "/pipeline", label: "Application Pipeline", icon: Workflow, section: "Work" },
  { href: "/events", label: "Events", icon: CalendarDays, section: "Work" },
  { href: "/email-review", label: "Email Review", icon: Mail, section: "Work" },

  // Account-level connections/settings, not a step in the job-search
  // pipeline itself.
  // Credentials was previously (incorrectly) marked adminOnly, which
  // hid it from every regular user — routers/credentials.py is
  // current_user_id scoped throughout, nothing admin-specific about
  // it, so that flag was a real bug (it made Gmail connection
  // unreachable for anyone but an admin), not a deliberate
  // restriction. Fixed here.
  { href: "/credentials", label: "Credentials", icon: KeyRound, section: "System" },
  { href: "/billing", label: "Billing", icon: CreditCard, section: "System" },
  { href: "/notifications", label: "Notifications", icon: Bell, section: "System" },

  // SaaS pivot — the operator configures which LLM providers/models
  // power the whole deployment and is the only one who sees raw cost
  // internals; regular users never did and now structurally can't
  // (routers/providers.py, model_profiles.py, cost.py all require
  // current_admin_user). Run Console moved here on request — every
  // signed-in user could reach it before (routers/streaming.py is
  // current_user_id scoped, not actually admin-gated server-side),
  // this is a deliberate UI-only restriction, not a bug fix like
  // Credentials above.
  { href: "/models", label: "Models", icon: Cpu, section: "Admin", adminOnly: true },
  { href: "/cost", label: "Cost", icon: DollarSign, section: "Admin", adminOnly: true },
  { href: "/run-console", label: "Run Console", icon: Terminal, section: "Admin", adminOnly: true },
  { href: "/admin/users", label: "Users", icon: Users, section: "Admin", adminOnly: true },
  { href: "/admin/plans", label: "Plans", icon: Layers, section: "Admin", adminOnly: true },
];
