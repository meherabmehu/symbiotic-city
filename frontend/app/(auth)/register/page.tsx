"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ArrowRight, UserPlus } from "lucide-react";
import { AuthShell } from "@/components/layout/auth-shell";
import { Alert, Button, Field, Input, Select } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";

const ROLE_OPTIONS = [
  { value: "city_operator", label: "City Operator — run incidents and dispatch" },
  { value: "city_analyst", label: "City Analyst — simulate and optimise" },
  { value: "field_engineer", label: "Field Engineer — execute repair tasks" },
];

export default function RegisterPage() {
  const { refresh } = useAuth();
  const router = useRouter();
  const [form, setForm] = useState({
    full_name: "",
    email: "",
    password: "",
    confirm: "",
    role: "city_operator",
    job_title: "",
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function update(key: string, value: string) {
    setForm((prev) => ({ ...prev, [key]: value }));
    setErrors((prev) => ({ ...prev, [key]: "" }));
  }

  function validate(): boolean {
    const next: Record<string, string> = {};
    if (form.full_name.trim().length < 2) next.full_name = "Enter your full name.";
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(form.email)) next.email = "Enter a valid email address.";
    if (form.password.length < 8 || !/[A-Za-z]/.test(form.password) || !/\d/.test(form.password))
      next.password = "At least 8 characters with both letters and numbers.";
    if (form.password !== form.confirm) next.confirm = "Passwords do not match.";
    setErrors(next);
    return Object.keys(next).length === 0;
  }

  async function submit() {
    if (!validate()) return;
    setBusy(true);
    setMessage(null);
    try {
      await api.raw("/auth/register", {
        method: "POST",
        body: {
          full_name: form.full_name.trim(),
          email: form.email.trim(),
          password: form.password,
          role: form.role,
          job_title: form.job_title || null,
        },
      });
      await refresh();
      router.replace("/dashboard");
    } catch (err) {
      const apiError = err as { fieldErrors?: Record<string, string> };
      setErrors(apiError?.fieldErrors ?? {});
      setMessage(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell
      title="Create your account"
      subtitle="Register for operational access. Super Admin accounts can only be issued by an administrator."
      footer={
        <span>
          Already registered?{" "}
          <Link href="/login" className="link inline-flex items-center gap-1">
            Sign in <ArrowRight className="h-3 w-3" aria-hidden />
          </Link>
        </span>
      }
    >
      <form
        className="space-y-4"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {message ? (
          <Alert tone="danger" title="Could not create the account">
            {message}
          </Alert>
        ) : null}

        <Field label="Full name" htmlFor="full_name" error={errors.full_name} required>
          <Input
            id="full_name"
            name="full_name"
            autoComplete="name"
            value={form.full_name}
            invalid={Boolean(errors.full_name)}
            onChange={(event) => update("full_name", event.target.value)}
            placeholder="Nadia Rahman"
          />
        </Field>

        <Field label="Work email" htmlFor="email" error={errors.email} required>
          <Input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            value={form.email}
            invalid={Boolean(errors.email)}
            onChange={(event) => update("email", event.target.value)}
            placeholder="you@organisation.gov"
          />
        </Field>

        <Field label="Role" htmlFor="role" hint="Permissions are enforced on the server." required>
          <Select id="role" value={form.role} onChange={(event) => update("role", event.target.value)}>
            {ROLE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="Job title" htmlFor="job_title" hint="Optional — shown on your profile.">
          <Input
            id="job_title"
            name="job_title"
            value={form.job_title}
            onChange={(event) => update("job_title", event.target.value)}
            placeholder="Watch Commander"
          />
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Password"
            htmlFor="password"
            error={errors.password}
            hint="8+ characters, letters and numbers."
            required
          >
            <Input
              id="password"
              name="password"
              type="password"
              autoComplete="new-password"
              value={form.password}
              invalid={Boolean(errors.password)}
              onChange={(event) => update("password", event.target.value)}
            />
          </Field>
          <Field label="Confirm password" htmlFor="confirm" error={errors.confirm} required>
            <Input
              id="confirm"
              name="confirm"
              type="password"
              autoComplete="new-password"
              value={form.confirm}
              invalid={Boolean(errors.confirm)}
              onChange={(event) => update("confirm", event.target.value)}
            />
          </Field>
        </div>

        <Button type="submit" className="w-full" loading={busy}>
          <UserPlus className="h-4 w-4" aria-hidden /> Create account
        </Button>
      </form>
    </AuthShell>
  );
}
