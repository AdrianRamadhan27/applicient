"use client";

import * as React from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { MailCheck } from "lucide-react";
import { AuthLayout } from "@/components/auth-layout";
import { ResendVerificationButton } from "@/components/resend-verification-button";

// Adrian, direct: signup can no longer sign the caller in — the
// account exists but stays locked out of login until its email is
// verified (routers/auth.py's login() now rejects an unverified
// account outright). This is where signup/page.tsx sends someone
// right after creating that account, and where login/page.tsx's own
// "please verify" error links back to as well.
function VerifyEmailPendingContent() {
  const searchParams = useSearchParams();
  const email = searchParams.get("email") ?? "";

  return (
    <AuthLayout>
      <div className="flex flex-col items-center text-center sm:items-start sm:text-left">
        <div className="flex size-12 items-center justify-center border border-primary bg-primary/10">
          <MailCheck className="size-6 text-primary" strokeWidth={1.5} />
        </div>
        <h1 className="mt-5 text-2xl font-semibold tracking-tight">Check your email</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {email ? (
            <>
              We sent a verification link to <span className="font-medium text-foreground">{email}</span>.
            </>
          ) : (
            "We sent a verification link to your email."
          )}{" "}
          Click it to activate your account — you can&apos;t sign in until it&apos;s verified.
        </p>

        <div className="mt-6 flex w-full flex-col items-center gap-3 sm:items-start">
          <ResendVerificationButton email={email} />
          <Link href="/login" className="text-sm text-primary underline hover:text-primary/80">
            Back to log in
          </Link>
        </div>
      </div>
    </AuthLayout>
  );
}

export default function VerifyEmailPendingPage() {
  // useSearchParams needs a Suspense boundary in the App Router — same
  // reason pipeline/live/page.tsx reads window.location.search
  // directly instead; this page has no other reason to avoid
  // useSearchParams, so the boundary is the simpler fix here.
  return (
    <React.Suspense fallback={null}>
      <VerifyEmailPendingContent />
    </React.Suspense>
  );
}
