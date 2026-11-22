"use client";

/** In-app methodology and demo script (also summarised in README.md). */

import Link from "next/link";
import { BookOpen, Bug, Cpu, GitBranch, ShieldCheck, Sparkles } from "lucide-react";
import { Badge, PageHeader, Panel, PanelHeader } from "@/components/ui";

const DEMO = [
  {
    title: "1 · Open the twin",
    body: "Sign in as the City Operator. The dashboard shows the live health index. Open Interactive city, select PS-01 and note its dependants.",
    href: "/twin",
  },
  {
    title: "2 · Run the cascade",
    body: "Failure lab → select PS-01 → total failure → threshold 0.35 → depth 6. Run it. Twelve of 23 assets fail at depth 2 and roughly 18,400 residents are affected.",
    href: "/simulation",
  },
  {
    title: "3 · Optimise recovery",
    body: "Derive resource demand from that run, then solve. The hospital and water pump are covered; the commercial facility is explicitly reported unserved with a reason.",
    href: "/optimization",
  },
  {
    title: "4 · Prove infeasibility",
    body: "Enable “Force infeasible” and solve again. The solver proves the model has no solution; the API refuses approval with 409.",
    href: "/optimization",
  },
  {
    title: "5 · Approve and dispatch",
    body: "Approve the feasible plan. Capacity is reserved in one transaction and repair tasks are dispatched to field engineers.",
    href: "/tasks",
  },
  {
    title: "6 · Break the workflow",
    body: "Recovery workflows → start with a fault at resources_reserved. The first hold commits, the second fails, compensation releases the first, and the workflow is left failed.",
    href: "/workflows",
  },
  {
    title: "7 · Retry safely",
    body: "Retry the failed workflow. Reservations are idempotent, so no capacity is double-booked and the ledger shows the full attempt history.",
    href: "/workflows",
  },
  {
    title: "8 · Close the loop",
    body: "Engineer accepts and completes tasks; the operator verifies them; resolution is then permitted and the asset returns to operational.",
    href: "/my-tasks",
  },
];

export default function DocsPage() {
  return (
    <>
      <PageHeader
        eyebrow="Reference"
        title="Methodology & demo script"
        description="How the simulation, optimiser and workflow actually work, plus a reproducible eight-step demonstration for judges."
      >
        <div className="mt-4 flex flex-wrap gap-2">
          <Badge tone="accent">
            <Cpu className="h-3 w-3" /> NetworkX + OR-Tools
          </Badge>
          <Badge>
            <ShieldCheck className="h-3 w-3" /> 4 roles, object-level checks
          </Badge>
          <Badge>Synthetic Aurora Vale dataset</Badge>
        </div>
      </PageHeader>

      <div className="grid gap-4 xl:grid-cols-[1fr_1fr]">
        <Panel>
          <PanelHeader title="Cascade model" subtitle="What the engine computes, and its limits" icon={<GitBranch className="h-4 w-4" />} />
          <ol className="space-y-3 text-xs leading-relaxed text-ink-400">
            <li>
              <span className="text-ink-100">1. Seed.</span> Chosen assets are marked failed at depth 0 and their
              capacity loss is set by the failure mode (total 100%, capacity loss 75%, maintenance 60%).
            </li>
            <li>
              <span className="text-ink-100">2. Propagate.</span> Breadth-first over dependency edges, up to the
              configured max depth. For each dependent the supply deficit is combined multiplicatively across its
              upstream feeds: <code className="font-mono text-[10px] text-accent">deficit = 1 − ∏(1 − w·(1 − r))</code>.
            </li>
            <li>
              <span className="text-ink-100">3. Classify.</span> Deficit ≥ 0.35 fails the asset; ≥ 0.21 degrades it;
              otherwise it is recorded as affected. Thresholds are per-run parameters, stored with the run.
            </li>
            <li>
              <span className="text-ink-100">4. Quantify.</span> Affected population is summed from the zones of
              impacted assets, weighted by capacity loss. A severity index blends failures, depth and population.
            </li>
            <li>
              <span className="text-ink-100">5. Record.</span> The run stores a SHA-256 snapshot hash of the graph plus
              the seed, so a result can be reproduced exactly.
            </li>
          </ol>
          <p className="mt-3 rounded-lg border border-amber/25 bg-amber/[0.05] px-2.5 py-2 text-[11px] text-amber">
            This is a screening model for dependency chains, not a validated power-flow solver. It deliberately ignores
            physics, protection behaviour and repair time. Every result screen states this.
          </p>
        </Panel>

        <Panel>
          <PanelHeader title="Optimiser" subtitle="CP-SAT formulation and infeasibility handling" icon={<Sparkles className="h-4 w-4" />} />
          <ol className="space-y-3 text-xs leading-relaxed text-ink-400">
            <li>
              <span className="text-ink-100">Decision variables.</span> Binary assign[d, r] plus a served[d] flag.
              All-or-nothing: a demand is served at full quantity by one resource or not at all.
            </li>
            <li>
              <span className="text-ink-100">Objective.</span> Maximise Σ priority_weight (P1 = 60 … P5 = 2) plus a
              small population term, so ties break toward larger exposed populations.
            </li>
            <li>
              <span className="text-ink-100">Capacity.</span> Each resource can be allocated at most its available
              quantity, after live reservations are deducted.
            </li>
            <li>
              <span className="text-ink-100">Hard floor.</span> If must_serve_priority is set, all demands at or above
              that priority are constrained to full coverage. If that is unsatisfiable the model is reported
              infeasible with a human-readable reason.
            </li>
            <li>
              <span className="text-ink-100">Determinism.</span> One search worker, seed 7, so the same inputs give the
              same plan — a prerequisite for a repeatable demo.
            </li>
          </ol>
          <p className="mt-3 rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-2 text-[11px] text-ink-400">
            Infeasible plans are persisted as infeasible and cannot be approved: the API returns{" "}
            <code className="font-mono text-[10px] text-coral">409 infeasible_plan</code>.
          </p>
        </Panel>

        <Panel>
          <PanelHeader title="Recovery workflow" subtitle="Ten steps, compensation, idempotent retries" icon={<Bug className="h-4 w-4" />} />
          <ul className="space-y-2 text-xs leading-relaxed text-ink-400">
            <li>
              <span className="text-ink-100">Steps.</span> incident_created → incident_validated →
              simulation_performed → recovery_plan_generated → plan_approved → resources_reserved →
              repair_tasks_assigned → engineer_accepted → repair_verified → incident_resolved.
            </li>
            <li>
              <span className="text-ink-100">Failure.</span> A step raises StepFailure. The engine runs compensating
              actions in reverse order (release reservations, cancel tasks), records the failure, and leaves the
              workflow in <code className="font-mono text-[10px]">failed</code> — it never reports success.
            </li>
            <li>
              <span className="text-ink-100">Retry.</span> The same workflow row is resumed; reservations use
              idempotency keys so a retried attempt cannot double-book capacity.
            </li>
            <li>
              <span className="text-ink-100">Guard.</span> Starting a second workflow for an incident that already has
              an active one is rejected with <code className="font-mono text-[10px]">409 workflow_exists</code>.
            </li>
          </ul>
        </Panel>

        <Panel>
          <PanelHeader title="Authorisation" subtitle="Backend-enforced, with object-level checks" icon={<ShieldCheck className="h-4 w-4" />} />
          <dl className="space-y-2 text-xs leading-relaxed text-ink-400">
            <div>
              <dt className="font-semibold text-ink-100">Super Admin</dt>
              <dd>Everything: users, settings, audit, plus all operational actions.</dd>
            </div>
            <div>
              <dt className="font-semibold text-ink-100">City Operator</dt>
              <dd>Incidents, plan approval, verification, dispatch. Cannot write resources or manage users.</dd>
            </div>
            <div>
              <dt className="font-semibold text-ink-100">Field Engineer</dt>
              <dd>
                Only their own tasks. <code className="font-mono text-[10px]">/tasks</code> is hard-scoped to the
                caller; another engineer's task returns 403, not 404-leak.
              </dd>
            </div>
            <div>
              <dt className="font-semibold text-ink-100">City Analyst</dt>
              <dd>Simulation, optimisation, analytics and exports. Read-only on operational records.</dd>
            </div>
          </dl>
          <p className="mt-3 text-[11px] text-ink-500">
            Session cookies are httpOnly + SameSite=Lax, and every mutating request must echo the CSRF cookie in{" "}
            <code className="font-mono text-[10px]">X-CSRF-Token</code> (double-submit). The client in this app does
            that automatically.
          </p>
        </Panel>
      </div>

      <Panel className="mt-4">
        <PanelHeader title="Eight-step demonstration" subtitle="Roughly seven minutes, judge-friendly" icon={<BookOpen className="h-4 w-4" />} />
        <ol className="grid gap-3 sm:grid-cols-2">
          {DEMO.map((step) => (
            <li key={step.title} className="rounded-xl border border-white/10 bg-white/[0.02] p-3">
              <Link href={step.href} className="text-sm font-medium text-white hover:text-accent">
                {step.title}
              </Link>
              <p className="mt-1 text-[11px] leading-relaxed text-ink-400">{step.body}</p>
            </li>
          ))}
        </ol>
        <p className="mt-3 text-[11px] text-ink-500">
          Full reproduction instructions, including seeding and test commands, are in the repository README and in{" "}
          <code className="font-mono text-[10px]">docs/requirements.md</code>.
        </p>
      </Panel>
    </>
  );
}
