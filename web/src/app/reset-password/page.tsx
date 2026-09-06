"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { PasswordInput } from "@/components/ui/password-input";
import { AuthLayout } from "@/components/auth-layout";

// Adrian, direct: "on forgot password there must be an email to
// verify the password change" — this is where that emailed link
// (routers/auth.py's _send_password_reset_email, /reset-password?
// token=...) actually lands: a real form, not a bare redirect, since
// entering a new password needs one. A 400 here (invalid/expired/
// already-used token — auth.py's own fingerprint check) is shown
// inline rather than as a toast, since the fix ("request a new one")
// needs a real link, not just a dismissible message.
function ResetPasswordContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = searchParams.get("token") ?? "";
  const [password, setPassword] = React.useState("");
  const [confirmPassword, setConfirmPassword] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const [tokenError, setTokenError] = React.useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (password !== confirmPassword) {
      toast.error("Passwords don't match");
      return;
    }
    setTokenError(null);
    setSubmitting(true);
    try {
      await api.resetPassword(token, password);
      toast.success("Password updated — sign in with your new password.");
      router.replace("/login?reset=1");
    } catch (err) {
      setTokenError(err instanceof Error ? err.message : "Failed to reset your password");
    } finally {
      setSubmitting(false);
    }
  }

  if (!token) {
    return (
      <AuthLayout>
        <h1 className="text-2xl font-semibold tracking-tight">Invalid link</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          This page needs a reset link from your email to work.{" "}
          <Link href="/forgot-password" className="text-primary underline hover:text-primary/80">
            Request a new one
          </Link>
          .
        </p>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout>
      <h1 className="text-2xl font-semibold tracking-tight">Set a new password</h1>
      <p className="mt-1 text-sm text-muted-foreground">Choose a new password for your account.</p>

      {tokenError && (
        <div className="mt-4 flex flex-col gap-2 border border-crit bg-crit/10 p-3">
          <p className="text-sm text-crit">{tokenError}</p>
          <Link href="/forgot-password" className="self-start text-sm text-primary underline hover:text-primary/80">
            Request a new link
          </Link>
        </div>
      )}

      <form onSubmit={handleSubmit} className="mt-6 flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="password">New password</Label>
          <PasswordInput
            id="password"
            autoComplete="new-password"
            required
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="confirm-password">Confirm new password</Label>
          <PasswordInput
            id="confirm-password"
            autoComplete="new-password"
            required
            minLength={8}
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
          />
        </div>
        <Button type="submit" disabled={submitting} className="mt-1">
          {submitting ? "Updating…" : "Update password"}
        </Button>
      </form>
    </AuthLayout>
  );
}

export default function ResetPasswordPage() {
  // useSearchParams needs a Suspense boundary in the App Router — same
  // pattern verify-email-pending/page.tsx already established.
  return (
    <React.Suspense fallback={null}>
      <ResetPasswordContent />
    </React.Suspense>
  );
}
