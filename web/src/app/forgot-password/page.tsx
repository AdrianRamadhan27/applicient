"use client";

import * as React from "react";
import Link from "next/link";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AuthLayout } from "@/components/auth-layout";
import { MailCheck } from "lucide-react";

// Adrian, direct: "Need to add forgot password in sign in... on forgot
// password there must be an email to verify the password change" —
// always resolves to the same "check your email" state regardless of
// whether the address is registered/Google-only (routers/auth.py's
// forgot_password never reveals which case it was), same
// anti-enumeration discipline verify-email-pending's own page follows.
const COOLDOWN_SECONDS = 60;

export default function ForgotPasswordPage() {
  const [email, setEmail] = React.useState("");
  const [sent, setSent] = React.useState(false);
  const [sending, setSending] = React.useState(false);
  const [secondsLeft, setSecondsLeft] = React.useState(0);

  React.useEffect(() => {
    if (secondsLeft <= 0) return;
    const id = setInterval(() => setSecondsLeft((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(id);
  }, [secondsLeft]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSending(true);
    try {
      await api.forgotPassword(email.trim());
      setSent(true);
      setSecondsLeft(COOLDOWN_SECONDS);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to send the reset email");
    } finally {
      setSending(false);
    }
  }

  if (sent) {
    return (
      <AuthLayout>
        <div className="flex flex-col items-center text-center sm:items-start sm:text-left">
          <div className="flex size-12 items-center justify-center border border-primary bg-primary/10">
            <MailCheck className="size-6 text-primary" strokeWidth={1.5} />
          </div>
          <h1 className="mt-5 text-2xl font-semibold tracking-tight">Check your email</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            If an account exists for <span className="font-medium text-foreground">{email.trim()}</span>, we sent a
            password reset link to it. The link expires in 1 hour and only works once.
          </p>
          <div className="mt-6 flex w-full flex-col items-center gap-3 sm:items-start">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={sending || secondsLeft > 0}
              onClick={handleSubmit}
            >
              {sending ? "Sending…" : secondsLeft > 0 ? `Resend in ${secondsLeft}s` : "Resend email"}
            </Button>
            <Link href="/login" className="text-sm text-primary underline hover:text-primary/80">
              Back to log in
            </Link>
          </div>
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout>
      <h1 className="text-2xl font-semibold tracking-tight">Forgot your password?</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Enter your account&apos;s email and we&apos;ll send you a link to reset it.
      </p>

      <form onSubmit={handleSubmit} className="mt-8 flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        <Button type="submit" disabled={sending} className="mt-1">
          {sending ? "Sending…" : "Send reset link"}
        </Button>
      </form>

      <p className="mt-6 text-sm text-muted-foreground">
        <Link href="/login" className="text-primary underline hover:text-primary/80">
          Back to log in
        </Link>
      </p>
    </AuthLayout>
  );
}
