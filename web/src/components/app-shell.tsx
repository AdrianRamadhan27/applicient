"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Target } from "lucide-react";
import { NAV_ITEMS } from "@/lib/nav";
import { cn } from "@/lib/utils";

const SECTIONS = ["Work", "System"] as const;

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  return (
    <div className="flex h-screen">
      <aside className="w-[196px] shrink-0 border-r border-border bg-card flex flex-col">
        <div className="h-12 flex items-center gap-2 px-4 border-b border-border">
          <Target className="size-4 text-primary" strokeWidth={1.5} />
          <span className="font-mono text-sm font-semibold tracking-tight">
            applicient
          </span>
        </div>

        <nav className="flex flex-col py-2">
          {SECTIONS.map((section) => (
            <div key={section}>
              <div className="px-4 pt-3.5 pb-1 font-mono text-[10px] tracking-wider uppercase text-muted-foreground">
                {section}
              </div>
              {NAV_ITEMS.filter((item) => item.section === section).map(
                (item) => {
                  const active = pathname.startsWith(item.href);
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      className={cn(
                        "flex items-center px-4 py-1.5 text-sm border-l-2 border-transparent",
                        active
                          ? "bg-accent text-accent-foreground font-medium border-l-primary"
                          : "text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {item.label}
                    </Link>
                  );
                },
              )}
            </div>
          ))}
        </nav>
      </aside>

      <main className="flex-1 min-w-0 flex flex-col overflow-hidden">
        {children}
      </main>
    </div>
  );
}
