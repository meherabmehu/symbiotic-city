"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { AlertCircle, ArrowRight, Eye, EyeOff, KeyRound, LogIn } from "lucide-react";
import { AuthShell } from "@/components/layout/auth-shell";
import { Alert, Button, Field, Input } from "@/components/ui";
import { DEMO_ACCOUNTS, useAuth } from "@/lib/auth";
import { errorMessage } from "@/lib/api";

function LoginForm() {
  const { login, user, loading } = useAuth();
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get("next");

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  async function submit(nextEmail: string, nextPassword: string) {
    setBusy(true);
    setError(null);
    setFieldErrors({});
    try {
      await login(nextEmail, nextPassword);
      router.replace(next && next.startsWith("/") ? next : "/dashboard");
    } catch (err) {
      const apiError = err as { fieldErrors?: Record<string, string> };
      setFieldErrors(apiError?.fieldErrors ?? {});
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (!loading && user) {
    router.replace("/dashboard");
  }

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        void submit(email, password);
      }}
      noValidate
    >
      {error ? (
        <Alert tone="danger" title="Sign-in failed">
          {error}
        </Alert>
      ) : null}

      <Field label="Email address" htmlFor="email" error={fieldErrors.email} required>
        <Input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          inputMode="email"
          required
          value={email}
          invalid={Boolean(fieldErrors.email)}
          onChange={(event) => setEmail(event.target.value)}
          placeholder="operator@symbiotic.city"
        />
      </Field>

      <Field label="Password" htmlFor="password" error={fieldErrors.password} required>
        <div className="relative">
          <Input
            id="password"
            name="password"
            type={showPassword ? "text" : "password"}
            autoComplete="current-password"
            required
            value={password}
            invalid={Boolean(fieldErrors.password)}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="••••••••"
            className="pr-11"
          />
          <button
            type="button"
            onClick={() => setShowPassword((v) => !v)}
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded-lg p-2 text-ink-400 hover:text-white"
            aria-label={showPassword ? "Hide password" : "Show password"}
            aria-pressed={showPassword}
          >
            {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </button>
        </div>
      </Field>

      <div className="flex items-center justify-between text-xs">
        <Link href="/forgot-password" className="link inline-flex items-center gap-1">
          <KeyRound className="h-3.5 w-3.5" aria-hidden /> Forgot password?
        </Link>
        <Link href="/register" className="text-ink-400 hover:text-white">
          Need an account?
        </Link>
      </div>

      <Button type="submit" className="w-full" loading={busy}>
        <LogIn className="h-4 w-4" aria-hidden /> Sign in
      </Button>

      <div className="rounded-xl border border-white/10 bg-white/[0.03] p-3">
        <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-ink-400">
          Demo accounts — one click sign in
        </p>
        <div className="grid gap-1.5 sm:grid-cols-2">
          {DEMO_ACCOUNTS.map((account) => (
            <button
              key={account.email}
              type="button"
              disabled={busy}
              onClick={() => {
                setEmail(account.email);
                setPassword(account.password);
                void submit(account.email, account.password);
              }}
              className="flex flex-col items-start rounded-lg border border-white/10 bg-white/[0.02] px-2.5 py-2 text-left text-[11px] text-ink-300 transition hover:border-accent/40 hover:bg-accent/5 hover:text-white disabled:opacity-50"
            >
              <span className="font-semibold text-white">{account.label}</span>
              <span className="text-ink-500">{account.email}</span>
            </button>
          ))}
        </div>
      </div>
      <p className="flex items-center gap-1.5 text-[11px] text-ink-500">
        <AlertCircle className="h-3.5 w-3.5" aria-hidden />
        Demo credentials are seeded accounts for the fictional city of Aurora Vale.
      </p>
    </form>
  );
}

export default function LoginPage() {
  return (
    <AuthShell
      title="Sign in"
      subtitle="Access the Aurora Vale command layer with your operator credentials."
      footer={
        <span>
          New to the platform?{" "}
          <Link href="/register" className="link inline-flex items-center gap-1">
            Create an account <ArrowRight className="h-3 w-3" aria-hidden />
          </Link>
        </span>
      }
    >
      <Suspense fallback={<div className="skeleton h-64 w-full" />}>
        <LoginForm />
      </Suspense>
    </AuthShell>
  );
}
