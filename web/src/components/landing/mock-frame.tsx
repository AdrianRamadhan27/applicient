import { cn } from "@/lib/utils";

// The same mock-browser chrome page.tsx's old ScreenshotFrame used to wrap a
// real screenshot — extracted here so it can wrap an interactive fake UI
// instead. Landing-page-only: these mocks intentionally do nothing when
// clicked (no navigation, no API calls) — they're a sandboxed facade of the
// real app, same idea as this page's *Diagram components already were, just
// closer to the real thing.
export function MockFrame({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("flex flex-col overflow-hidden border border-border bg-card", className)}>
      <div className="flex items-center gap-1 border-b border-border px-2.5 py-2">
        <span className="size-1.5 shrink-0 bg-border" />
        <span className="size-1.5 shrink-0 bg-border" />
        <span className="size-1.5 shrink-0 bg-border" />
      </div>
      {children}
    </div>
  );
}
