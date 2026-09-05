"use client";

import * as React from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";

// Adrian, direct: "please have a timer before being able to resend
// verification email" — a client-side cooldown so the button can't be
// mashed, on top of (not instead of) the server's own real
// enforcement (auth.py's check_rate_limit, also 60s/1 send — see that
// file's own comment for why the two numbers match). If the server
// ever rejects with a 429 anyway (a second tab, a stale client clock),
// the error toast still surfaces it — this timer is UX, not the real
// gate.
const COOLDOWN_SECONDS = 60;

export function ResendVerificationButton({
  email,
  className,
  variant = "outline",
}: {
  email: string;
  className?: string;
  variant?: "outline" | "ghost" | "link";
}) {
  const [secondsLeft, setSecondsLeft] = React.useState(0);
  const [sending, setSending] = React.useState(false);

  React.useEffect(() => {
    if (secondsLeft <= 0) return;
    const id = setInterval(() => setSecondsLeft((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(id);
  }, [secondsLeft]);

  async function handleResend() {
    setSending(true);
    try {
      await api.resendVerification(email);
      toast.success("Verification email sent — check your inbox.");
      setSecondsLeft(COOLDOWN_SECONDS);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to resend the verification email");
    } finally {
      setSending(false);
    }
  }

  const disabled = sending || secondsLeft > 0;

  return (
    <Button
      type="button"
      variant={variant}
      size="sm"
      className={className}
      onClick={handleResend}
      disabled={disabled}
    >
      {sending ? "Sending…" : secondsLeft > 0 ? `Resend in ${secondsLeft}s` : "Resend verification email"}
    </Button>
  );
}
