import * as React from "react";
import Link from "next/link";
import { Target } from "lucide-react";
import { ParticleField } from "@/components/particle-field";

// Full-page split layout for /login and /signup — replaces the old
// "small card centered on an empty page" version (raised directly by
// Adrian, reference: a hero panel on one side, the form on the other,
// full height, same drifting-particle effect as the landing page's
// own hero). The form here sits on the left (the reference image had
// it on the right — mirrored per Adrian's own description of what he
// wanted) and takes a narrower share of the width than the hero, per
// "half/third... the rest is like welcome."
export function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen w-full flex-col lg:flex-row">
      <div className="flex w-full flex-1 flex-col justify-center px-6 py-10 sm:px-12 lg:w-[42%] lg:flex-none lg:px-16 lg:py-16">
        <Link href="/" className="mb-10 flex items-center gap-2">
          <Target className="size-4 text-primary" strokeWidth={1.5} />
          <span className="font-mono text-sm font-semibold tracking-tight">applicient</span>
        </Link>
        <div className="mx-auto w-full max-w-sm">{children}</div>
      </div>

      {/* Hidden below lg — squeezing both a form and a full hero panel
          into a phone-height viewport reads as cramped, not welcoming;
          the form alone is the right call there, same as most split
          auth layouts this pattern is drawn from. */}
      <div className="relative hidden flex-1 flex-col justify-between overflow-hidden bg-primary px-12 py-12 text-primary-foreground lg:flex">
        <ParticleField inverted />
        <div className="relative z-10 flex items-center gap-2">
          <Target className="size-5" strokeWidth={1.5} />
          <span className="font-mono text-base font-semibold tracking-tight">applicient</span>
        </div>
        <div className="relative z-10 max-w-md">
          <h1 className="text-4xl font-semibold tracking-tight text-balance sm:text-5xl">
            Welcome to Applicient
          </h1>
          <p className="mt-4 text-base text-primary-foreground/80">
            Discover the right jobs, apply with proof instead of padding, and keep your whole
            pipeline moving forward — automatically.
          </p>
        </div>
        <span className="relative z-10 text-xs text-primary-foreground/60">
          © {new Date().getFullYear()} Applicient. All rights reserved.
        </span>
      </div>
    </div>
  );
}
