"use client";

import * as React from "react";
import { useTheme } from "next-themes";
import { Moon, Sun } from "lucide-react";
import { cn } from "@/lib/utils";

/** Cycles light -> dark -> system on each click, one icon button — no
 * dropdown/menu, matching this app's existing dense, minimal icon-button
 * style (e.g. app-shell.tsx's logout button). `next-themes`'s own
 * `resolvedTheme` (not `theme`) drives which icon shows, so "system"
 * displays whichever of light/dark it's currently resolving to rather
 * than a third, ambiguous icon. Not rendered until mounted — next-themes
 * can't know the real theme during SSR, and rendering a guess would
 * mismatch on hydration (same suppressHydrationWarning reasoning
 * layout.tsx already documents for next-themes generally). */
export function ThemeToggle({ className }: { className?: string }) {
  const { theme, resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => {
    (() => setMounted(true))();
  }, []);

  function cycle() {
    if (theme === "light") setTheme("dark");
    else if (theme === "dark") setTheme("system");
    else setTheme("light");
  }

  if (!mounted) return <div className={cn("size-4", className)} />;

  const label = theme === "system" ? `system (${resolvedTheme})` : theme;

  return (
    <button
      onClick={cycle}
      className="shrink-0 text-muted-foreground hover:text-foreground"
      title={`Theme: ${label} — click to change`}
    >
      {resolvedTheme === "dark" ? (
        <Moon className={cn("size-4", className)} />
      ) : (
        <Sun className={cn("size-4", className)} />
      )}
    </button>
  );
}
