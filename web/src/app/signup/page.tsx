"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { useAuth } from "@/lib/auth";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PasswordInput } from "@/components/ui/password-input";
import { AuthLayout } from "@/components/auth-layout";
import { GoogleIcon } from "@/components/icons/google-icon";
import { cn } from "@/lib/utils";

// Format-only (Adrian, direct: "must be an email") — deliberately not
// a strict RFC 5322 pattern, just "looks like local@domain.tld", so it
// never rejects a real address on some rare-but-valid syntax. Actually
// confirming the mailbox exists isn't done here at all: signup's own
// verification-email link (already required before login) is the real
// proof of a working address, which no client-side check can replace.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function SignupPage() {
  const { signup } = useAuth();
  const router = useRouter();
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [confirmPassword, setConfirmPassword] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);

  // Adrian, direct: "live password validation... even before user
  // click on sign up" — only once the field has something in it (an
  // untouched, empty field just shows the plain muted hint below, not
  // an error), so a blank form doesn't open already looking broken.
  const passwordTooShort = password.length > 0 && password.length < 8;
  const passwordsMismatch = confirmPassword.length > 0 && confirmPassword !== password;
  const emailInvalid = email.length > 0 && !EMAIL_PATTERN.test(email.trim());

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (emailInvalid) {
      toast.error("Enter a valid email address");
      return;
    }
    if (passwordTooShort) {
      toast.error("Password is too short — at least 8 characters");
      return;
    }
    if (passwordsMismatch) {
      toast.error("Passwords don't match");
      return;
    }
    setSubmitting(true);
    try {
      const signedUpEmail = await signup(email.trim(), password);
      router.replace(`/verify-email-pending?email=${encodeURIComponent(signedUpEmail)}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Signup failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthLayout>
      <h1 className="text-2xl font-semibold tracking-tight">Create an account</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Already have an account?{" "}
        <Link href="/login" className="text-primary underline hover:text-primary/80">
          Log in
        </Link>
        . Sets up your own personas, profile, and pipeline.
      </p>

      <form onSubmit={handleSubmit} className="mt-8 flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            type="email"
            autoComplete="email"
            required
            aria-invalid={emailInvalid}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          {emailInvalid && <span className="text-[11px] text-crit">Enter a valid email address.</span>}
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="password">Password</Label>
          <PasswordInput
            id="password"
            autoComplete="new-password"
            minLength={8}
            required
            aria-invalid={passwordTooShort}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <span className={cn("text-[11px]", passwordTooShort ? "text-crit" : "text-muted-foreground")}>
            {passwordTooShort ? "Password is too short — at least 8 characters." : "At least 8 characters."}
          </span>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="confirm-password">Confirm password</Label>
          <PasswordInput
            id="confirm-password"
            autoComplete="new-password"
            minLength={8}
            required
            aria-invalid={passwordsMismatch}
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
          />
          {passwordsMismatch && <span className="text-[11px] text-crit">Passwords don&apos;t match.</span>}
        </div>
        <Button
          type="submit"
          disabled={submitting || emailInvalid || passwordTooShort || passwordsMismatch}
          className="mt-1"
        >
          {submitting ? "Creating account…" : "Sign up"}
        </Button>
      </form>

      <div className="my-4 flex items-center gap-3">
        <div className="h-px flex-1 bg-border" />
        <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">or</span>
        <div className="h-px flex-1 bg-border" />
      </div>
      <Button
        type="button"
        variant="outline"
        className="w-full"
        onClick={() => window.location.assign(api.googleLoginUrl())}
      >
        <GoogleIcon className="size-4" />
        Continue with Google
      </Button>

      <p className="mt-4 text-center text-[11px] text-muted-foreground">
        By signing up, you agree to our{" "}
        <Link href="/terms" className="underline hover:text-foreground">
          Terms
        </Link>{" "}
        and{" "}
        <Link href="/privacy" className="underline hover:text-foreground">
          Privacy Policy
        </Link>
        .
      </p>
    </AuthLayout>
  );
}
