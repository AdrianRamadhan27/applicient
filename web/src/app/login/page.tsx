"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { useAuth } from "@/lib/auth";
import { api, ApiError } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PasswordInput } from "@/components/ui/password-input";
import { AuthLayout } from "@/components/auth-layout";
import { GoogleIcon } from "@/components/icons/google-icon";
import { ResendVerificationButton } from "@/components/resend-verification-button";

export default function LoginPage() {
  const { login } = useAuth();
  const router = useRouter();
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  // Set only when login rejects specifically because the account
  // isn't verified yet (routers/auth.py's login(), a 403) — matched by
  // message text rather than a dedicated status/error code, same
  // "one distinctive backend string, matched on the frontend" pattern
  // radar/page.tsx already uses for its own profile-confirmation link.
  const [unverifiedEmail, setUnverifiedEmail] = React.useState<string | null>(null);

  React.useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("verified") === "1") {
      toast.success("Email verified — you can log in now.");
    }
    if (params.get("reset") === "1") {
      toast.success("Password updated — sign in with your new password.");
    }
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setUnverifiedEmail(null);
    try {
      await login(email.trim(), password);
      router.replace("/console");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Login failed";
      if (err instanceof ApiError && err.status === 403 && message.toLowerCase().includes("verify your email")) {
        setUnverifiedEmail(email.trim());
      } else {
        toast.error(message);
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthLayout>
      <h1 className="text-2xl font-semibold tracking-tight">Welcome back!</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Don&apos;t have an account?{" "}
        <Link href="/signup" className="text-primary underline hover:text-primary/80">
          Create one now
        </Link>
        , it&apos;s free.
      </p>

      {unverifiedEmail && (
        <div className="mt-6 flex flex-col gap-2 border border-warn bg-warn/10 p-3">
          <p className="text-sm text-warn">
            Please verify your email before signing in — check your inbox for the verification link.
          </p>
          <ResendVerificationButton email={unverifiedEmail} className="self-start" />
        </div>
      )}

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
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <Label htmlFor="password">Password</Label>
            <Link href="/forgot-password" className="text-xs text-primary underline hover:text-primary/80">
              Forgot password?
            </Link>
          </div>
          <PasswordInput
            id="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        <Button type="submit" disabled={submitting} className="mt-1">
          {submitting ? "Logging in…" : "Log in"}
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
    </AuthLayout>
  );
}
