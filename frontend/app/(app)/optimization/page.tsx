"use client";

/**
 * Screen 11 — AI Optimisation.
 *
 * The A02 showcase: competing demands (hospital, water pump, commercial) for an
 * insufficient generator pool, a live CP-SAT preview, a deliberately
 * infeasible request, and a persisted, approvable plan.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowUpRight,
  Ban,
  CheckCircle2,
  Cpu,
  Gauge,
  Hospital,
  Layers,
  Play,
  ShoppingBag,
  Sparkles,
  Waves,
  Zap,
} from "lucide-react";
import { CoverageRadar } from "@/components/charts";
import {
  Alert,
  Badge,
  Button,
  DataTable,
  EmptyState,
  Field,
  Input,
  Modal,
  Panel,
  PanelHeader,
  PageHeader,
  ProgressBar,
  Select,
  Spinner,
  StatusPill,
  Tabs,
} from "@/components/ui";
import { api, errorMessage, qs } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatDateTime, formatNumber, percent, titleCase } from "@/lib/format";
import { useAsync } from "@/lib/hooks";
import type { Asset, Incident, ListResponse, OptimizationPlan, Resource, SimulationRun } from "@/lib/types";

interface Demand {
  asset_id: number;
  need: number;
  priority: number;
  service_window_minutes: number;
  estimated_hours: number;
  eligible_categories: string[];
}

interface PreviewResult {
  result: {
    status: string;
    objective_value: number;
    assignments: {
      asset_id: number;
      resource_id: number;
      quantity: number;
      priority_weight: number;
      contribution: number;
      served: boolean;
      rationale: string;
    }[];
    unserved: { asset_id: number; asset_code: string; asset_name: string; priority: number; need: number; reason: string }[];
    resource_usage: Record<string, { code: string; name: string; available: number; allocated: number; utilisation_percent: number }>;
    total_demand: number;
    covered_demand: number;
    coverage_percent: number;
    wall_ms: number;
    explanation: string[];
    infeasibility_reason: string | null;
  };
  resources: { resource_id: number; code: string; name: string; category: string; available: number }[];
  demands: { asset_id: number; asset_code: string; asset_name: string; category: string; need: number; priority: number }[];
}

const CATEGORY_ICON: Record<string, React.ComponentType<{ className?: string }>> = {
  hospital: Hospital,
  water_pump: Waves,
  water_treatment: Waves,
  commercial: ShoppingBag,
  telecom: Sparkles,
  residential: Layers,
  school: Layers,
};

export default function OptimizationPage() {
  const { can } = useAuth();
  const router = useRouter();
  const [tab, setTab] = useState<"compose" | "plans" | "engine">("compose");
  const [title, setTitle] = useState("Meridian East critical recovery");
  const [source, setSource] = useState<"simulation" | "incident" | "manual">("manual");
  const [simulationId, setSimulationId] = useState<number | null>(null);
  const [incidentId, setIncidentId] = useState<number | null>(null);
  const [demands, setDemands] = useState<Demand[]>([]);
  const [horizon, setHorizon] = useState(12);
  const [mustServe, setMustServe] = useState("1");
  const [forceInfeasible, setForceInfeasible] = useState(false);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [submitBusy, setSubmitBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [demandModal, setDemandModal] = useState(false);

  const assets = useAsync<Asset[]>(async () => (await api.list<Asset>("/infrastructure?page_size=100&sort=code")).data, []);
  const resources = useAsync<Resource[]>(async () => (await api.list<Resource>("/resources?page_size=100")).data, [refreshKey]);
  const runs = useAsync<SimulationRun[]>(async () => (await api.list<SimulationRun>("/simulations?page_size=20")).data, []);
  const incidents = useAsync<Incident[]>(async () => (await api.list<Incident>("/incidents?page_size=30&include_closed=false")).data, []);
  const plans = useAsync<{ rows: OptimizationPlan[]; total: number }>(async () => {
    const response: ListResponse<OptimizationPlan> = await api.list("/optimization/plans?page_size=20");
    return { rows: response.data, total: response.meta.total };
  }, [refreshKey]);

  useEffect(() => {
    if (!simulationId) return;
    let cancelled = false;
    api
      .get<{ demands?: unknown } | Demand[]>(`/simulations/${simulationId}/demands`)
      .then((response) => {
        if (cancelled) return;
        const list = Array.isArray(response) ? response : (response as { demands?: Demand[] }).demands ?? [];
        setDemands(
          (list as Demand[]).map((demand) => ({
            asset_id: demand.asset_id,
            need: demand.need,
            priority: demand.priority,
            service_window_minutes: demand.service_window_minutes ?? 240,
            estimated_hours: demand.estimated_hours ?? 2,
            eligible_categories: demand.eligible_categories ?? ["generator"],
          })),
        );
      })
      .catch((err) => setError(errorMessage(err)));
    return () => {
      cancelled = true;
    };
  }, [simulationId]);

  const generators = useMemo(
    () => (resources.data ?? []).filter((resource) => resource.category === "generator"),
    [resources.data],
  );
  const generatorCapacity = generators.reduce((sum, resource) => sum + resource.available_quantity, 0);
  const totalNeed = demands.reduce((sum, demand) => sum + demand.need, 0);

  function addDemand(assetId: number) {
    if (demands.some((demand) => demand.asset_id === assetId)) return;
    const asset = assets.data?.find((item) => item.id === assetId);
    const priority = Math.min(5, Math.max(1, asset?.criticality ?? 3));
    const needByCategory: Record<string, number> = {
      hospital: 55,
      water_treatment: 45,
      water_pump: 30,
      telecom: 22,
      residential: 15,
      school: 12,
      commercial: 10,
    };
    setDemands((prev) => [
      ...prev,
      {
        asset_id: assetId,
        need: needByCategory[asset?.category ?? "commercial"] ?? 10,
        priority,
        service_window_minutes: 240,
        estimated_hours: 2,
        eligible_categories: ["generator"],
      },
    ]);
  }

  function demandPayload() {
    return {
      title: title.trim() || "Recovery plan",
      simulation_run_id: source === "simulation" ? simulationId : null,
      incident_id: source === "incident" ? incidentId : null,
      objective: "maximize_critical_coverage",
      demands,
      horizon_hours: horizon,
      must_serve_priority: mustServe === "none" ? null : Number(mustServe),
      max_assignments_per_demand: 3,
      force_infeasible_demo: forceInfeasible,
    };
  }

  async function runPreview() {
    if (demands.length === 0) {
      setError("Add at least one demand before previewing.");
      return;
    }
    setPreviewBusy(true);
    setError(null);
    try {
      const data = await api.raw<PreviewResult>("/optimization/preview", {
        method: "POST",
        body: demandPayload(),
      });
      setPreview(data);
    } catch (err) {
      setError(errorMessage(err));
      setPreview(null);
    } finally {
      setPreviewBusy(false);
    }
  }

  async function submitPlan() {
    if (demands.length === 0) {
      setError("Add at least one demand before solving.");
      return;
    }
    setSubmitBusy(true);
    setError(null);
    try {
      const response = await api.raw<{ plan: OptimizationPlan }>("/optimization/requests", {
        method: "POST",
        body: demandPayload(),
      });
      setRefreshKey((k) => k + 1);
      router.push(`/optimization/plans/${response.plan.id}`);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSubmitBusy(false);
    }
  }

  const result = preview?.result;
  const radar = result
    ? Object.entries(result.resource_usage).map(([, usage]) => ({
        subject: usage.code,
        value: usage.utilisation_percent,
      }))
    : [];

  return (
    <>
      <PageHeader
        eyebrow="Decision support"
        title="AI optimisation"
        description="CP-SAT allocates scarce recovery resources across competing critical services. The solver is all-or-nothing per assignment, honours must-serve priorities, and reports infeasibility explicitly instead of inventing a plan."
        actions={
          <>
            <Badge tone="accent">
              <Cpu className="h-3 w-3" /> OR-Tools CP-SAT
            </Badge>
            <Badge>{plans.data?.total ?? 0} plans</Badge>
          </>
        }
      />

      {error ? <Alert tone="danger" title="Optimisation error">{error}</Alert> : null}
      {notice ? <Alert tone="success" action={<Button variant="ghost" size="sm" onClick={() => setNotice(null)}>Dismiss</Button>}>{notice}</Alert> : null}

      <Tabs
        value={tab}
        onChange={setTab}
        label="Optimisation sections"
        tabs={[
          { id: "compose", label: "Compose demand" },
          { id: "plans", label: "Plans", count: plans.data?.total },
          { id: "engine", label: "Engine & method" },
        ]}
      />

      {tab === "compose" ? (
        <div className="mt-4 grid gap-4 xl:grid-cols-[1fr_400px]">
          <div className="space-y-4">
            <Panel>
              <PanelHeader title="Request" subtitle="Where the demand set comes from" icon={<Sparkles className="h-4 w-4" />} />
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Plan title" htmlFor="plan-title" required>
                  <Input id="plan-title" value={title} onChange={(event) => setTitle(event.target.value)} maxLength={200} />
                </Field>
                <Field label="Demand source" htmlFor="source">
                  <Select
                    id="source"
                    value={source}
                    onChange={(event) => {
                      setSource(event.target.value as typeof source);
                      setDemands([]);
                      setSimulationId(null);
                      setIncidentId(null);
                    }}
                  >
                    <option value="manual">Manual selection</option>
                    <option value="simulation">From simulation run</option>
                    <option value="incident">From incident</option>
                  </Select>
                </Field>
                {source === "simulation" ? (
                  <Field label="Simulation run" htmlFor="sim-select" required>
                    <Select
                      id="sim-select"
                      value={simulationId ?? ""}
                      onChange={(event) => setSimulationId(Number(event.target.value) || null)}
                    >
                      <option value="">Choose a run…</option>
                      {(runs.data ?? []).map((run) => (
                        <option key={run.id} value={run.id}>
                          {run.code} — {run.name} ({run.summary.assets_failed} failed)
                        </option>
                      ))}
                    </Select>
                  </Field>
                ) : null}
                {source === "incident" ? (
                  <Field label="Incident" htmlFor="inc-select" required>
                    <Select
                      id="inc-select"
                      value={incidentId ?? ""}
                      onChange={(event) => setIncidentId(Number(event.target.value) || null)}
                    >
                      <option value="">Choose an incident…</option>
                      {(incidents.data ?? []).map((incident) => (
                        <option key={incident.id} value={incident.id}>
                          {incident.code} — {incident.title}
                        </option>
                      ))}
                    </Select>
                  </Field>
                ) : null}
              </div>

              {source === "simulation" ? (
                <p className="mt-2 text-[11px] text-ink-500">
                  Demands are derived from the failed back-up-power dependent assets of the selected run, using the
                  documented kVA conversion table.
                </p>
              ) : null}
            </Panel>

            <Panel>
              <PanelHeader
                title="Demands"
                subtitle={`${demands.length} assets · ${formatNumber(totalNeed)} kVA required · ${formatNumber(generatorCapacity)} kVA available`}
                icon={<AlertTriangle className="h-4 w-4" />}
                action={
                  <Button variant="secondary" size="sm" onClick={() => setDemandModal(true)}>
                    Add demand
                  </Button>
                }
              />
              {demands.length ? (
                <ul className="space-y-2">
                  {demands.map((demand) => {
                    const asset = assets.data?.find((item) => item.id === demand.asset_id);
                    const Icon = CATEGORY_ICON[asset?.category ?? ""] ?? Layers;
                    const starved = totalNeed > generatorCapacity;
                    return (
                      <li
                        key={demand.asset_id}
                        className="flex flex-col gap-2 rounded-xl border border-white/10 bg-white/[0.02] px-3 py-2 sm:flex-row sm:items-center sm:justify-between"
                      >
                        <div className="flex items-center gap-2">
                          <span className="grid h-8 w-8 place-items-center rounded-lg border border-white/10 bg-white/5 text-accent">
                            <Icon className="h-4 w-4" />
                          </span>
                          <div>
                            <p className="text-xs font-medium text-white">
                              {asset?.code ?? demand.asset_id} · {asset?.name ?? "Asset"}
                            </p>
                            <p className="text-[10px] text-ink-500">
                              {titleCase(asset?.category ?? "unknown")} · priority {demand.priority}
                            </p>
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <label className="flex items-center gap-1 text-[10px] text-ink-500">
                            kVA
                            <input
                              type="number"
                              min={1}
                              max={1000}
                              value={demand.need}
                              onChange={(event) =>
                                setDemands((prev) =>
                                  prev.map((item) =>
                                    item.asset_id === demand.asset_id
                                      ? { ...item, need: Number(event.target.value) }
                                      : item,
                                  ),
                                )
                              }
                              className="input w-20 py-1 text-xs"
                              aria-label={`Demand for ${asset?.code ?? demand.asset_id}`}
                            />
                          </label>
                          <label className="flex items-center gap-1 text-[10px] text-ink-500">
                            P
                            <input
                              type="number"
                              min={1}
                              max={5}
                              value={demand.priority}
                              onChange={(event) =>
                                setDemands((prev) =>
                                  prev.map((item) =>
                                    item.asset_id === demand.asset_id
                                      ? { ...item, priority: Number(event.target.value) }
                                      : item,
                                  ),
                                )
                              }
                              className="input w-14 py-1 text-xs"
                              aria-label={`Priority for ${asset?.code ?? demand.asset_id}`}
                            />
                          </label>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setDemands((prev) => prev.filter((item) => item.asset_id !== demand.asset_id))}
                            aria-label={`Remove demand ${asset?.code ?? demand.asset_id}`}
                          >
                            <Ban className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                        {starved ? <span className="text-[10px] text-amber">scarcity active</span> : null}
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <EmptyState
                  title="No demands yet"
                  description="Add competing critical services — for example a hospital, a water pump and a commercial facility — to see the solver choose."
                  icon={<Zap className="h-5 w-5" />}
                />
              )}
            </Panel>

            <Panel>
              <PanelHeader title="Constraints" subtitle="How the solver is bounded" icon={<Gauge className="h-4 w-4" />} />
              <div className="grid gap-3 sm:grid-cols-3">
                <Field label="Horizon (hours)" htmlFor="horizon">
                  <Input
                    id="horizon"
                    type="number"
                    min={1}
                    max={72}
                    value={horizon}
                    onChange={(event) => setHorizon(Number(event.target.value))}
                  />
                </Field>
                <Field label="Must serve priority" htmlFor="must-serve" hint="Hard coverage floor.">
                  <Select id="must-serve" value={mustServe} onChange={(event) => setMustServe(event.target.value)}>
                    <option value="none">No floor</option>
                    {[1, 2, 3].map((value) => (
                      <option key={value} value={value}>Priority ≤ {value}</option>
                    ))}
                  </Select>
                </Field>
                <Field label="Demo mode" htmlFor="infeasible" hint="Multiplies demand to prove infeasibility handling.">
                  <label className="flex h-[38px] items-center gap-2 rounded-lg border border-white/10 bg-white/[0.03] px-3 text-xs text-ink-300">
                    <input
                      id="infeasible"
                      type="checkbox"
                      className="h-3.5 w-3.5 accent-[#ff6b6b]"
                      checked={forceInfeasible}
                      onChange={(event) => setForceInfeasible(event.target.checked)}
                    />
                    Force infeasible
                  </label>
                </Field>
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button variant="secondary" onClick={runPreview} loading={previewBusy}>
                  <Play className="h-4 w-4" aria-hidden /> Preview solve
                </Button>
                <Button onClick={submitPlan} loading={submitBusy} disabled={!can("optimization:run")}>
                  <CheckCircle2 className="h-4 w-4" aria-hidden /> Solve & persist
                </Button>
              </div>
              {!can("optimization:run") ? (
                <p className="mt-2 text-[11px] text-amber">Your role can review plans but not run the solver.</p>
              ) : null}
            </Panel>
          </div>

          <div className="space-y-4">
            <Panel>
              <PanelHeader title="Scarcity check" subtitle="Demand vs. available generator capacity" icon={<Gauge className="h-4 w-4" />} />
              <div className="space-y-2">
                <div className="flex justify-between text-xs">
                  <span className="text-ink-400">Total demand</span>
                  <span className="text-ink-100">{formatNumber(totalNeed)} kVA</span>
                </div>
                <div className="flex justify-between text-xs">
                  <span className="text-ink-400">Available generators</span>
                  <span className="text-ink-100">{formatNumber(generatorCapacity)} kVA</span>
                </div>
                <ProgressBar
                  value={generatorCapacity ? (totalNeed / generatorCapacity) * 100 : 0}
                  tone={totalNeed > generatorCapacity ? "coral" : "mint"}
                  label="Demand to capacity ratio"
                />
                {totalNeed > generatorCapacity ? (
                  <Alert tone="warning" title="Scarcity">
                    Demand exceeds availability by {formatNumber(totalNeed - generatorCapacity)} kVA. The solver will
                    prioritise the highest-weight services and report every unserved demand with a reason.
                  </Alert>
                ) : (
                  <Alert tone="info">Capacity is sufficient for the current demand set.</Alert>
                )}
              </div>
            </Panel>

            {previewBusy ? <Panel><Spinner label="Solving…" /></Panel> : null}

            {result ? (
              <>
                <Panel>
                  <PanelHeader
                    title={result.status === "optimal" ? "Feasible plan" : titleCase(result.status)}
                    subtitle={`${result.covered_demand}/${result.total_demand} demands · objective ${formatNumber(result.objective_value)} · ${result.wall_ms} ms`}
                    icon={result.status === "optimal" ? <CheckCircle2 className="h-4 w-4" /> : <Ban className="h-4 w-4" />}
                  />
                  <div className="flex items-center justify-between">
                    <StatusPill status={result.status} />
                    <span className="text-xs text-ink-300">{percent(result.coverage_percent, 1)} coverage</span>
                  </div>
                  {result.infeasibility_reason ? (
                    <Alert tone="danger" title="No feasible allocation">
                      {result.infeasibility_reason}
                    </Alert>
                  ) : null}
                  <ul className="mt-3 space-y-1.5">
                    {result.explanation.map((line) => (
                      <li key={line} className="flex gap-1.5 text-[11px] leading-relaxed text-ink-400">
                        <ArrowUpRight className="mt-0.5 h-3 w-3 shrink-0 text-accent" />
                        {line}
                      </li>
                    ))}
                  </ul>
                </Panel>

                {result.assignments.length ? (
                  <Panel>
                    <PanelHeader title="Assignments" subtitle="Which resource goes where, and why" />
                    <ul className="space-y-2">
                      {result.assignments.map((assignment) => (
                        <li key={`${assignment.asset_id}-${assignment.resource_id}`} className="rounded-xl border border-white/10 bg-white/[0.02] px-3 py-2">
                          <div className="flex items-center justify-between text-xs">
                            <span className="font-medium text-white">
                              {preview.demands.find((demand) => demand.asset_id === assignment.asset_id)?.asset_code}{" "}
                              ← {result.resource_usage[String(assignment.resource_id)]?.code ?? assignment.resource_id}
                            </span>
                            <span className="text-ink-300">{formatNumber(assignment.quantity)} kVA</span>
                          </div>
                          <p className="mt-0.5 text-[10px] text-ink-500">{assignment.rationale}</p>
                        </li>
                      ))}
                    </ul>
                  </Panel>
                ) : null}

                {result.unserved.length ? (
                  <Panel>
                    <PanelHeader title="Unserved demands" subtitle="Explicitly reported, never silently dropped" />
                    <ul className="space-y-1.5">
                      {result.unserved.map((row) => (
                        <li key={row.asset_id} className="rounded-lg border border-coral/25 bg-coral/[0.06] px-3 py-2 text-[11px]">
                          <p className="font-medium text-white">
                            {row.asset_code} · {row.asset_name} (P{row.priority})
                          </p>
                          <p className="text-ink-400">{row.reason}</p>
                        </li>
                      ))}
                    </ul>
                  </Panel>
                ) : null}

                {radar.length ? (
                  <Panel>
                    <PanelHeader title="Resource utilisation" subtitle="Share of each resource allocated" />
                    <CoverageRadar data={radar} summary="Radar of generator utilisation percentages." />
                  </Panel>
                ) : null}
              </>
            ) : null}
          </div>
        </div>
      ) : null}

      {tab === "plans" ? (
        <Panel className="mt-4">
          <PanelHeader title="Persisted plans" subtitle="Every solve is stored with its full explanation" icon={<Layers className="h-4 w-4" />} />
          <DataTable
            rows={plans.data?.rows ?? []}
            loading={plans.loading}
            getKey={(plan) => plan.id}
            empty={<EmptyState title="No plans yet" description="Compose a demand set and solve it to persist the first plan." />}
            columns={[
              {
                key: "plan",
                header: "Plan",
                render: (plan) => (
                  <div>
                    <Link href={`/optimization/plans/${plan.id}`} className="text-sm font-medium text-white hover:text-accent">
                      {plan.code}
                    </Link>
                    <p className="text-[10px] text-ink-500">{formatDateTime(plan.created_at)}</p>
                  </div>
                ),
              },
              { key: "status", header: "Solver", render: (plan) => <StatusPill status={plan.solution_status} /> },
              {
                key: "coverage",
                header: "Coverage",
                render: (plan) => (
                  <span className="text-xs text-ink-300">
                    {plan.covered_demand}/{plan.total_demand} · {percent(plan.coverage_percent, 0)}
                  </span>
                ),
              },
              {
                key: "objective",
                header: "Objective",
                render: (plan) => <span className="text-xs text-ink-300">{formatNumber(plan.objective_value)}</span>,
              },
              {
                key: "state",
                header: "Plan state",
                render: (plan) => <StatusPill status={plan.status} />,
              },
              {
                key: "actions",
                header: "",
                className: "text-right",
                render: (plan) => (
                  <Link href={`/optimization/plans/${plan.id}`} className="btn-ghost btn-sm" aria-label={`Open ${plan.code}`}>
                    <ArrowUpRight className="h-3.5 w-3.5" />
                  </Link>
                ),
              },
            ]}
          />
        </Panel>
      ) : null}

      {tab === "engine" ? (
        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          <Panel>
            <PanelHeader title="Objective" subtitle="Maximise weighted critical coverage" icon={<Cpu className="h-4 w-4" />} />
            <p className="text-xs leading-relaxed text-ink-400">
              Each served demand contributes its priority weight (P1 = 60, P2 = 30, P3 = 12, P4 = 5, P5 = 2) plus a
              small population term. The model is all-or-nothing per demand-resource pair: a partial generator
              allocation is not accepted, because a hospital cannot run on 40% of a required supply.
            </p>
            <ul className="mt-3 space-y-2 text-[11px] text-ink-400">
              <li>
                <span className="text-ink-200">Must-serve floor:</span> priority ≤ N demands are constrained to full
                coverage. If that is impossible the model is reported infeasible, never partially satisfied silently.
              </li>
              <li>
                <span className="text-ink-200">Capacity:</span> each generator can be allocated at most its available
                quantity after live reservations are deducted.
              </li>
              <li>
                <span className="text-ink-200">Assignments per demand:</span> a demand may be met by up to three
                generators.
              </li>
              <li>
                <span className="text-ink-200">Determinism:</span> single worker, seed 7 — the same input always yields
                the same plan.
              </li>
            </ul>
          </Panel>
          <Panel>
            <PanelHeader title="Reading an infeasible result" icon={<Ban className="h-4 w-4" />} />
            <p className="text-xs leading-relaxed text-ink-400">
              Enable “Force infeasible” to multiply every demand by four. The solver then proves the model has no
              solution and returns a human-readable reason. The plan is stored in an infeasible state and the API
              refuses to approve it — the demo path that proves we do not fabricate success.
            </p>
            <Button
              variant="secondary"
              className="mt-3"
              onClick={() => {
                setForceInfeasible(true);
                setTab("compose");
                setNotice("Force-infeasible is now enabled. Run a preview to see the proof.");
              }}
            >
              Prepare infeasible demo
            </Button>
          </Panel>
        </div>
      ) : null}

      <Modal
        open={demandModal}
        onClose={() => setDemandModal(false)}
        title="Add a demand"
        description="Add the assets that need backup power. Priority defaults to the asset's criticality."
        size="md"
      >
        <div className="max-h-[60vh] overflow-y-auto scrollbar-slim">
          <ul className="space-y-1">
            {(assets.data ?? []).map((asset) => {
              const added = demands.some((demand) => demand.asset_id === asset.id);
              const Icon = CATEGORY_ICON[asset.category] ?? Layers;
              return (
                <li key={asset.id}>
                  <button
                    className="flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left text-xs hover:bg-white/5 disabled:opacity-40"
                    onClick={() => { addDemand(asset.id); setDemandModal(false); }}
                    disabled={added}
                  >
                    <span className="flex items-center gap-2">
                      <Icon className="h-3.5 w-3.5 text-accent" />
                      <span className="font-mono text-[10px] text-ink-500">{asset.code}</span>
                      <span className="text-ink-200">{asset.name}</span>
                    </span>
                    <span className="flex items-center gap-2">
                      <Badge>P{asset.criticality}</Badge>
                      <span className="text-[10px] text-ink-500">{added ? "added" : "add"}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      </Modal>
    </>
  );
}
