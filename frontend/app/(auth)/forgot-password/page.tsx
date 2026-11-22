"use client";

import Link from "next/link";
import { useState } from "react";
import { ArrowRight, MailCheck, Send } from "lucide-react";
import { AuthShell } from "@/components/layout/auth-shell";
import { Alert, Button, Field, Input } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";

export default function ForgotPasswordPage() {
  const [step, setStep] = useState<"request" | "reset" | "done">("request");
  const [email, setEmail] = useState("");
  const [token, setToken] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function requestReset() {
    setBusy(true);
    setError(null);
    try {
      const data = await api.post<{ message: string; reset_token: string | null }>(
        "/auth/forgot-password",
        { email },
      );
      setMessage(data.message);
      if (data.reset_token) {
        setToken(data.reset_token);
        setStep("reset");
      } else {
        setStep("done");
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function submitReset() {
    if (password !== confirm) {
      setError("The two passwords do not match.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.post("/auth/reset-password", { token, password });
      setStep("done");
      setMessage("Password updated. You can now sign in with the new password.");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell
      title={step === "done" ? "Password reset" : "Reset your password"}
      subtitle={
        step === "done"
          ? "Your credentials have been updated."
          : "We will issue a single-use reset token for the account email."
      }
      footer={
        <Link href="/login" className="link inline-flex items-center gap-1">
          Back to sign in <ArrowRight className="h-3 w-3" aria-hidden />
        </Link>
      }
    >
      {step === "done" ? (
        <div className="space-y-4">
          <Alert tone="success" title="All set">
            {message ?? "If an account exists for that address, a reset link has been issued."}
          </Alert>
          <Link href="/login" className="btn-primary w-full">
            Continue to sign in
          </Link>
        </div>
      ) : (
        <form
          className="space-y-4"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void (step === "request" ? requestReset() : submitReset());
          }}
        >
          {error ? (
            <Alert tone="danger" title="Request failed">
              {error}
            </Alert>
          ) : null}
          {message ? <Alert tone="info">{message}</Alert> : null}

          {step === "request" ? (
            <>
              <Field label="Account email" htmlFor="email" required>
                <Input
                  id="email"
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="operator@symbiotic.city"
                />
              </Field>
              <Button type="submit" className="w-full" loading={busy}>
                <Send className="h-4 w-4" aria-hidden /> Issue reset token
              </Button>
              <p className="text-[11px] leading-relaxed text-ink-500">
                Demonstration note: this deployment has no SMTP relay, so outside production the single-use token is
                returned here instead of being emailed. In production the token is only delivered by email.
              </p>
            </>
          ) : (
            <>
              <Alert tone="info" title="Reset token issued">
                Single-use and expires in 30 minutes. It has been filled in below for this demonstration.
              </Alert>
              <Field label="Reset token" htmlFor="token" required>
                <Input id="token" value={token} onChange={(event) => setToken(event.target.value)} />
              </Field>
              <Field label="New password" htmlFor="password" required>
                <Input
                  id="password"
                  type="password"
                  autoComplete="new-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </Field>
              <Field label="Confirm new password" htmlFor="confirm" required>
                <Input
                  id="confirm"
                  type="password"
                  autoComplete="new-password"
                  value={confirm}
                  onChange={(event) => setConfirm(event.target.value)}
                />
              </Field>
              <Button type="submit" className="w-full" loading={busy}>
                <MailCheck className="h-4 w-4" aria-hidden /> Update password
              </Button>
            </>
          )}
        </form>
      )}
    </AuthShell>
  );
}
