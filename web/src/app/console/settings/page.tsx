"use client";

import * as React from "react";
import { toast } from "sonner";
import { useAuth } from "@/lib/auth";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { PasswordInput } from "@/components/ui/password-input";
import { GoogleIcon } from "@/components/icons/google-icon";
import { KeyRound, Mail } from "lucide-react";

// Adrian, direct: "actual user profile... change password in the
// profile" — account IDENTITY (email, password), deliberately separate
// from the CV/Persona "Profile Studio" tab inside Dashboard
// (?tab=profile), which is job-search material, not account security.
export default function SettingsPage() {
  const { user, refreshUser } = useAuth();
  const [currentPassword, setCurrentPassword] = React.useState("");
  const [newPassword, setNewPassword] = React.useState("");
  const [confirmPassword, setConfirmPassword] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (newPassword !== confirmPassword) {
      toast.error("Passwords don't match");
      return;
    }
    setSubmitting(true);
    try {
      await api.changePassword(user?.has_password ? currentPassword : null, newPassword);
      toast.success(user?.has_password ? "Password changed" : "Password set");
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      await refreshUser();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update your password");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex flex-col h-full">
      <header className="h-12 shrink-0 border-b border-border bg-card flex items-center gap-3 px-5">
        <span className="text-sm font-semibold">Settings</span>
      </header>

      <div className="flex-1 overflow-auto p-5">
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
          <div className="border border-border bg-card p-4 flex flex-col gap-3">
            <span className="font-mono text-[10px] tracking-wider uppercase text-muted-foreground">Account</span>
            <div className="flex items-center gap-2 text-sm">
              <Mail className="size-4 text-muted-foreground shrink-0" />
              <span>{user?.email}</span>
              {user?.role === "admin" && (
                <Badge variant="secondary" className="text-[9px] font-mono">
                  admin
                </Badge>
              )}
            </div>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              {user?.has_password ? (
                <>
                  <KeyRound className="size-3.5 shrink-0" />
                  <span>Signed in with email and password</span>
                </>
              ) : (
                <>
                  <GoogleIcon className="size-3.5 shrink-0" />
                  <span>Signed in with Google</span>
                </>
              )}
            </div>
          </div>

          <div className="border border-border bg-card p-4 flex flex-col gap-3">
            <div>
              <span className="font-mono text-[10px] tracking-wider uppercase text-muted-foreground">
                {user?.has_password ? "Change password" : "Set a password"}
              </span>
              {!user?.has_password && (
                <p className="mt-1 text-xs text-muted-foreground">
                  Your account currently only signs in with Google. Set a password to also be able to sign in with
                  your email directly.
                </p>
              )}
            </div>
            <form onSubmit={handleSubmit} className="flex flex-col gap-3">
              {user?.has_password && (
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="current-password">Current password</Label>
                  <PasswordInput
                    id="current-password"
                    autoComplete="current-password"
                    required
                    value={currentPassword}
                    onChange={(e) => setCurrentPassword(e.target.value)}
                  />
                </div>
              )}
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="new-password">New password</Label>
                <PasswordInput
                  id="new-password"
                  autoComplete="new-password"
                  required
                  minLength={8}
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="confirm-new-password">Confirm new password</Label>
                <PasswordInput
                  id="confirm-new-password"
                  autoComplete="new-password"
                  required
                  minLength={8}
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                />
              </div>
              <Button type="submit" disabled={submitting} className="mt-1 self-start">
                {submitting ? "Saving…" : user?.has_password ? "Change password" : "Set password"}
              </Button>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
}
