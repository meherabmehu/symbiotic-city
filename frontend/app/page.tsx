"use client";

/**
 * Landing page (screen 01).
 *
 * Reproduces the reference composition: top navigation (About, Features,
 * Support, Contact), the green LIVE DIGITAL TWIN • SYNCED pill, the "Welcome to
 * / SYMBIOTIC CITY" hero over a subtle city grid, the mission line, the
 * Login / Register calls to action and the footer.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
  ArrowRight,
  Building2,
  CircuitBoard,
  Compass,
  Cpu,
  Gauge,
  Layers,
  LifeBuoy,
  Mail,
  Network,
  ShieldCheck,
  Sparkles,
  Workflow,
} from "lucide-react";
import { LiveTwinPill, Logo } from "@/components/ui/logo";
import { useAuth } from "@/lib/auth";

const FEATURES = [
  {
    icon: Network,
    title: "Dependency-aware digital twin",
    body: "23 assets and 25 modelled dependencies across five zones, rendered live from the database.",
  },
  {
    icon: Sparkles,
    title: "Cascading failure simulation",
    body: "Deterministic breadth-first propagation with redundancy envelopes and severity scoring.",
  },
  {
    icon: Cpu,
    title: "OR-Tools recovery optimisation",
    body: "Constrained allocation with explainable trade-offs and explicit infeasibility detection.",
  },
  {
    icon: Workflow,
    title: "Automated recovery workflow",
    body: "Ten-step orchestration with compensating actions, idempotent retries and a full event ledger.",
  },
  {
    icon: ShieldCheck,
    title: "Four-role authorisation",
    body: "Backend-enforced permissions plus object-level checks on every repair task.",
  },
  {
    icon: Gauge,
    title: "Operational analytics",
    body: "Health index, MTTR, utilisation and trend reporting computed from stored records.",
  },
];

const STEPS = [
  {
    icon: Compass,
    title: "Detect",
    body: "Operators select an asset and inject a controlled failure. The twin highlights the originating fault instantly.",
  },
  {
    icon: Layers,
    title: "Propagate",
    body: "The cascade engine walks dependency edges, scoring deficit against each asset’s redundancy.",
  },
  {
    icon: CircuitBoard,
    title: "Allocate",
    body: "Analysts submit demand; CP-SAT returns a fully explained recovery plan or proves it infeasible.",
  },
  {
    icon: Workflow,
    title: "Restore",
    body: "Approval reserves resources transactionally, dispatches tasks and tracks field progress to resolution.",
  },
];

export default function LandingPage() {
  const { user, loading } = useAuth();
  const router = useRouter();
  const [year] = useState(() => new Date().getFullYear());

  useEffect(() => {
    if (!loading && user) router.replace("/dashboard");
  }, [loading, user, router]);

  return (
    <div className="relative min-h-screen overflow-hidden">
      {/* city grid backdrop */}
      <div
        className="pointer-events-none absolute inset-0 opacity-[0.35]"
        style={{
          backgroundImage:
            "linear-gradient(rgba(69,216,245,0.07) 1px, transparent 1px), linear-gradient(90deg, rgba(69,216,245,0.07) 1px, transparent 1px)",
          backgroundSize: "56px 56px",
          maskImage: "radial-gradient(ellipse at 50% 30%, black 20%, transparent 78%)",
          WebkitMaskImage: "radial-gradient(ellipse at 50% 30%, black 20%, transparent 78%)",
        }}
        aria-hidden
      />
      <div className="pointer-events-none absolute inset-x-0 top-0 h-[520px] bg-hero-glow" aria-hidden />

      <header className="relative z-10 mx-auto flex max-w-7xl items-center justify-between px-6 py-5">
        <Logo href={null} />
        <nav aria-label="Primary" className="hidden items-center gap-7 md:flex">
          {[
            { label: "About", href: "#about" },
            { label: "Features", href: "#features" },
            { label: "Support", href: "#support" },
            { label: "Contact", href: "#contact" },
          ].map((item) => (
            <a
              key={item.label}
              href={item.href}
              className="text-sm font-medium text-ink-300 underline-offset-4 transition hover:text-white hover:underline"
            >
              {item.label}
            </a>
          ))}
        </nav>
        <div className="flex items-center gap-2">
          <Link href="/login" className="btn-ghost btn-sm">
            Login
          </Link>
          <Link href="/register" className="btn-primary btn-sm">
            Register
          </Link>
        </div>
      </header>

      <main id="main" className="relative z-10">
        <section className="mx-auto max-w-7xl px-6 pb-16 pt-10 lg:pt-20">
          <div className="mx-auto max-w-3xl text-center">
            <div className="flex justify-center">
              <LiveTwinPill />
            </div>
            <p className="mt-8 text-sm font-medium uppercase tracking-[0.34em] text-ink-300">Welcome to</p>
            <h1 className="mt-3 text-balance font-display text-5xl font-semibold leading-[1.05] tracking-tight text-white sm:text-6xl lg:text-7xl">
              SYMBIOTIC
              <span className="block bg-gradient-to-r from-accent via-accent-soft to-mint bg-clip-text text-transparent">
                CITY
              </span>
            </h1>
            <p className="mx-auto mt-6 max-w-xl text-balance text-lg text-ink-300">
              A unified command layer for the resilient, responsive city.
            </p>
            <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
              <Link href="/login" className="btn-primary">
                Login <ArrowRight className="h-4 w-4" aria-hidden />
              </Link>
              <Link href="/register" className="btn-secondary">
                Register
              </Link>
            </div>
            <p className="mt-4 text-xs text-ink-500">
              Aurora Vale is a synthetic demonstration city. Every asset, incident and resident count is fictional.
            </p>
          </div>

          {/* twin preview strip */}
          <div className="relative mx-auto mt-14 max-w-5xl">
            <div className="glass relative overflow-hidden p-1.5">
              <div className="relative overflow-hidden rounded-xl bg-navy-950/80">
                <div
                  className="absolute inset-0 opacity-60"
                  style={{
                    backgroundImage:
                      "linear-gradient(rgba(69,216,245,0.08) 1px, transparent 1px), linear-gradient(90deg, rgba(69,216,245,0.08) 1px, transparent 1px)",
                    backgroundSize: "40px 40px",
                  }}
                  aria-hidden
                />
                <div className="relative grid gap-3 p-4 sm:grid-cols-4">
                  {[
                    { label: "Assets modelled", value: "23" },
                    { label: "Dependency links", value: "25" },
                    { label: "Simulation depth", value: "6 hops" },
                    { label: "Recovery steps", value: "10" },
                  ].map((stat) => (
                    <div
                      key={stat.label}
                      className="rounded-lg border border-white/10 bg-white/[0.03] px-3 py-3 text-center"
                    >
                      <p className="font-display text-xl font-semibold text-white">{stat.value}</p>
                      <p className="mt-0.5 text-[10px] uppercase tracking-[0.16em] text-ink-400">{stat.label}</p>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </section>

        <section id="about" className="mx-auto max-w-7xl scroll-mt-20 px-6 py-16">
          <div className="grid gap-10 lg:grid-cols-[1.1fr_0.9fr] lg:items-center">
            <div>
              <p className="font-display text-[11px] font-semibold uppercase tracking-[0.24em] text-accent">About</p>
              <h2 className="mt-3 text-balance font-display text-3xl font-semibold text-white sm:text-4xl">
                Infrastructure fails in chains. Recovery should be planned that way.
              </h2>
              <p className="mt-4 text-ink-300">
                A substation trip is never only a substation trip — it is a hospital losing secondary feed, a water
                intake pump stopping, and sixteen thousand residents waiting. SYMBIOTIC CITY models those chains as a
                directed graph, then answers the two questions every control room asks: <em>how far does it spread</em>,
                and <em>what do we fix first with what we have</em>.
              </p>
              <p className="mt-3 text-sm text-ink-500">
                Built for the World Problem Solver track — smart city resilience, AI-assisted decision support and
                resource optimisation. All modelling assumptions are documented and every result is reproducible.
              </p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              {STEPS.map((step, index) => (
                <div key={step.title} className="glass-tight p-4">
                  <div className="flex items-center gap-2">
                    <span className="grid h-8 w-8 place-items-center rounded-lg border border-accent/30 bg-accent/10 text-accent">
                      <step.icon className="h-4 w-4" aria-hidden />
                    </span>
                    <span className="text-[10px] font-semibold uppercase tracking-[0.2em] text-ink-500">
                      0{index + 1}
                    </span>
                  </div>
                  <p className="mt-3 font-display text-sm font-semibold text-white">{step.title}</p>
                  <p className="mt-1 text-xs leading-relaxed text-ink-400">{step.body}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section id="features" className="mx-auto max-w-7xl scroll-mt-20 px-6 py-16">
          <div className="mb-10 max-w-2xl">
            <p className="font-display text-[11px] font-semibold uppercase tracking-[0.24em] text-accent">Features</p>
            <h2 className="mt-3 font-display text-3xl font-semibold text-white sm:text-4xl">
              Six systems, one command surface
            </h2>
          </div>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map((feature) => (
              <article key={feature.title} className="glass group p-5 transition hover:border-accent/30">
                <span className="grid h-10 w-10 place-items-center rounded-xl border border-white/10 bg-white/5 text-accent transition group-hover:border-accent/40 group-hover:bg-accent/10">
                  <feature.icon className="h-5 w-5" aria-hidden />
                </span>
                <h3 className="mt-4 font-display text-base font-semibold text-white">{feature.title}</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-ink-400">{feature.body}</p>
              </article>
            ))}
          </div>
        </section>

        <section id="support" className="mx-auto max-w-7xl scroll-mt-20 px-6 py-16">
          <div className="glass grid gap-8 p-8 lg:grid-cols-[1fr_1fr] lg:p-10">
            <div>
              <p className="font-display text-[11px] font-semibold uppercase tracking-[0.24em] text-accent">Support</p>
              <h2 className="mt-3 font-display text-3xl font-semibold text-white">
                Four roles, each with a clear lane
              </h2>
              <p className="mt-3 text-sm text-ink-300">
                Permissions are enforced on the server for every request. Object-level checks stop an engineer touching
                another engineer's task, and the audit trail records who did what, when and with what outcome.
              </p>
              <div className="mt-5 flex flex-wrap gap-2">
                {["Super Admin", "City Operator", "Field Engineer", "City Analyst"].map((role) => (
                  <span key={role} className="chip">
                    {role}
                  </span>
                ))}
              </div>
            </div>
            <div className="grid gap-3">
              {[
                {
                  icon: LifeBuoy,
                  title: "Guided demo accounts",
                  body: "One click sign-in per role on the login screen — no credentials to type while judging.",
                },
                {
                  icon: Building2,
                  title: "Deterministic dataset",
                  body: "Seeded Aurora Vale data can be reproduced exactly from scripts/seed_demo.py.",
                },
                {
                  icon: ShieldCheck,
                  title: "Documented limits",
                  body: "The propagation model is a screening tool, not a validated electrical solver — stated in the UI.",
                },
              ].map((item) => (
                <div key={item.title} className="flex gap-3 rounded-xl border border-white/10 bg-white/[0.03] p-4">
                  <item.icon className="mt-0.5 h-4 w-4 shrink-0 text-accent" aria-hidden />
                  <div>
                    <p className="text-sm font-semibold text-white">{item.title}</p>
                    <p className="mt-0.5 text-xs text-ink-400">{item.body}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section id="contact" className="mx-auto max-w-7xl scroll-mt-20 px-6 pb-20 pt-8">
          <div className="glass flex flex-col items-start justify-between gap-6 p-8 sm:flex-row sm:items-center">
            <div>
              <p className="font-display text-[11px] font-semibold uppercase tracking-[0.24em] text-accent">Contact</p>
              <h2 className="mt-2 font-display text-2xl font-semibold text-white">Ready to walk the demonstration?</h2>
              <p className="mt-1.5 text-sm text-ink-400">
                Sign in as the City Operator and open the digital twin to begin the critical recovery workflow.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Link href="/login" className="btn-primary">
                Login <ArrowRight className="h-4 w-4" aria-hidden />
              </Link>
              <a href="mailto:operations@symbiotic.city" className="btn-secondary">
                <Mail className="h-4 w-4" aria-hidden /> Contact operations
              </a>
            </div>
          </div>
        </section>
      </main>

      <footer className="relative z-10 border-t border-white/10 bg-navy-950/60">
        <div className="mx-auto flex max-w-7xl flex-col items-center justify-between gap-3 px-6 py-6 text-xs text-ink-500 sm:flex-row">
          <div className="flex items-center gap-4">
            <span>© {year} SYMBIOTIC CITY</span>
            <a href="#about" className="hover:text-ink-200">
              Privacy
            </a>
            <a href="#about" className="hover:text-ink-200">
              Terms
            </a>
          </div>
          <p>Synthetic demonstration data · fictional city of Aurora Vale</p>
        </div>
      </footer>
    </div>
  );
}
