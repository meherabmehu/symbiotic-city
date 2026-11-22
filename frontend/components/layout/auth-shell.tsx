"use client";

import Link from "next/link";
import { ArrowLeft, ShieldCheck } from "lucide-react";
import { LiveTwinPill, Logo } from "@/components/ui/logo";

/** Split layout used by login / register / forgot-password screens. */
export function AuthShell({
  title,
  subtitle,
  children,
  footer,
  aside,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  aside?: React.ReactNode;
}) {
  return (
    <div className="relative flex min-h-screen flex-col">
      <div className="pointer-events-none absolute inset-0 bg-hero-glow" aria-hidden />
      <header className="relative z-10 mx-auto flex w-full max-w-7xl items-center justify-between px-6 py-5">
        <Logo />
        <div className="flex items-center gap-3">
          <LiveTwinPill />
          <Link href="/" className="btn-ghost btn-sm">
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> Back
          </Link>
        </div>
      </header>

      <main id="main" className="relative z-10 mx-auto grid w-full max-w-6xl flex-1 items-center gap-10 px-6 py-8 lg:grid-cols-[1.05fr_1fr]">
        <section className="hidden lg:block">
          <div className="glass relative overflow-hidden p-8">
            <div
              className="absolute inset-0 opacity-40"
              style={{
                backgroundImage:
                  "linear-gradient(rgba(69,216,245,0.08) 1px, transparent 1px), linear-gradient(90deg, rgba(69,216,245,0.08) 1px, transparent 1px)",
                backgroundSize: "44px 44px",
              }}
              aria-hidden
            />
            <div className="relative">
              <p className="font-display text-[11px] font-semibold uppercase tracking-[0.24em] text-accent">
                Command access
              </p>
              <h2 className="mt-3 text-balance font-display text-3xl font-semibold leading-tight text-white">
                Every failure chain, mapped before the first crew is dispatched.
              </h2>
              <p className="mt-3 text-sm leading-relaxed text-ink-300">
                SYMBIOTIC CITY joins infrastructure dependencies, cascading failure simulation, constrained recovery
                optimisation and field execution into one audited workflow.
              </p>
              <div className="mt-6 space-y-3">
                {[
                  "Deterministic cascade engine (NetworkX)",
                  "CP-SAT allocations with infeasibility proofs",
                  "Role + object level authorisation",
                ].map((line) => (
                  <p key={line} className="flex items-center gap-2 text-sm text-ink-200">
                    <ShieldCheck className="h-4 w-4 text-mint" aria-hidden /> {line}
                  </p>
                ))}
              </div>
              {aside}
            </div>
          </div>
        </section>

        <section className="mx-auto w-full max-w-md">
          <div className="glass p-6 sm:p-8">
            <h1 className="font-display text-2xl font-semibold text-white">{title}</h1>
            <p className="mt-1.5 text-sm text-ink-400">{subtitle}</p>
            <div className="mt-6">{children}</div>
            {footer ? <div className="mt-6 border-t border-white/10 pt-4 text-sm text-ink-400">{footer}</div> : null}
          </div>
          <p className="mt-4 text-center text-xs text-ink-500">
            Aurora Vale is synthetic demonstration data. No real infrastructure is connected.
          </p>
        </section>
      </main>
    </div>
  );
}
