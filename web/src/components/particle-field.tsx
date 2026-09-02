import * as React from "react";
import { cn } from "@/lib/utils";

// Deterministic pseudo-scatter (no Math.random — that would render
// differently server vs. client and trip a hydration mismatch) behind
// a hero: small squares (zero radius, matching Terminal Ledger's own
// rule, not circles) drifting and fading on an infinite loop, driven
// by globals.css's `.particle`/`particle-drift` keyframe reading these
// per-element custom properties. Originally the landing page's own
// hero background (page.tsx) — extracted here so the auth pages'
// hero panel (auth-layout.tsx) can share the exact same effect
// instead of a second copy drifting out of sync with it.
const PARTICLE_COUNT = 24;

const PARTICLES = Array.from({ length: PARTICLE_COUNT }, (_, i) => ({
  left: (i * 41 + 7) % 100,
  top: (i * 67 + 13) % 100,
  size: 4 + (i % 4) * 1.5,
  duration: 3.5 + (i % 7) * 0.6,
  delay: (i % 9) * 0.4,
  driftX: ((i % 5) - 2) * 14,
  driftY: -30 - (i % 4) * 12,
  opacity: 0.3 + (i % 4) * 0.1,
  primary: i % 3 === 0,
}));

export function ParticleField({ inverted = false }: { inverted?: boolean }) {
  return (
    <div className="pointer-events-none absolute inset-0 z-0 overflow-hidden" aria-hidden="true">
      {PARTICLES.map((p, i) => (
        <span
          key={i}
          className={cn(
            "particle absolute",
            // On a solid --primary hero panel, --primary-colored dots
            // would vanish into the background — inverted uses the
            // panel's own foreground color at two opacities instead.
            inverted ? "bg-primary-foreground" : p.primary ? "bg-primary" : "bg-muted-foreground",
          )}
          style={
            {
              left: `${p.left}%`,
              top: `${p.top}%`,
              width: p.size,
              height: p.size,
              "--duration": `${p.duration}s`,
              "--delay": `${p.delay}s`,
              "--drift-x": `${p.driftX}px`,
              "--drift-y": `${p.driftY}px`,
              "--particle-opacity": inverted ? p.opacity * 0.7 : p.opacity,
            } as React.CSSProperties
          }
        />
      ))}
    </div>
  );
}
