"use client";

import { criticalityStats } from "@/lib/criticality";

/**
 * Screen 14 — Resilience intelligence.
 *
 * Four questions a command layer has to answer about a city's infrastructure,
 * each as a tab, each sourced from its own endpoint:
 *
 *  - exposure:    where is the risk concentrated, and why (heatmap + criticality)
 *  - futures:     what if this fails, and what if that fails instead (what-if)
 *  - trade-offs:  which recovery plan is worth choosing (multi-objective frontier)
 *  - investment:  what should be fixed first, and what does it buy (planner)
 *
 * Every screen states its own assumptions. The alternative — a confident number
 * with its caveats in a document nobody opens — is how dashboards get trusted
 * past their evidence. Assumptions arrive from the API, so what is displayed is
 * what the model actually used.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Banknote,
  Coins,
  ChevronLeft,
  ChevronRight,
  GitBranch,
  History,
  Layers,
  SkipBack,
  SkipForward,
  MapPin,
  ShieldCheck,
  Split,
  Target,
  TriangleAlert,
} from "lucide-react";
import {
  Alert,
  Badge,
  Button,
  EmptyState,
  Field,
  Input,
  LoadingBlock,
  Panel,
  PanelHeader,
  PageHeader,
  ProgressBar,
  Select,
  StatCard,
  Tabs,
} from "@/components/ui";
import { ZoneRiskMap, bandToken, type HeatAsset, type HeatZone } from "@/components/zone-risk-map";
import { api, errorMessage, qs } from "@/lib/api";
import { AiFeatureCard } from "@/components/ai/ai-feature-card";
import { ScenarioCompareAi } from "@/components/ai/scenario-compare-ai";
import { useAuth } from "@/lib/auth";
import { formatDateTime, formatNumber, percent, titleCase } from "@/lib/format";
import { useAsync } from "@/lib/hooks";

/* ------------------------------------------------------------------ types */

interface CriticalityRank {
  asset_id: number;
  code: string;
  name: string;
  category: string;
  zone_code: string | null;
  criticality_index: number;
  components: Record<string, number>;
  consequence: { assets_failed: number; population_affected: number; critical_services_lost: string[] };
}

interface CriticalityResponse {
  model: { weights: Record<string, number>; assumptions: string[] };
  fleet: { assets_scored: number; mean_index: number; max_index: number };
  ranking: CriticalityRank[];
}

interface HeatResponse {
  zones: HeatZone[];
  assets: HeatAsset[];
  legend: { band: string; label: string; threshold: number | null; description: string; color_token: string }[];
  assumptions: string[];
  source: string;
  runs: { run_id: number; code: string }[] | null;
  totals: { zones: number; population_at_risk: number; assets_failed: number; assets_degraded: number };
  generated_at: string;
}

interface WhatIfObservation {
  id: number;
  run_id: number | null;
  headline: string;
  note: string;
  metrics: Record<string, number>;
  created_at: string;
}

interface WhatIf {
  id: number;
  code: string;
  name: string;
  description: string;
  initial_failure_ids: number[];
  failure_mode: string;
  cascade_threshold: number;
  is_baseline: boolean;
  observations: WhatIfObservation[];
}

interface Comparison {
  columns: {
    scenario: WhatIf;
    observation: { headline: string; created_at: string } | null;
    metrics: Record<string, number> | null;
    has_reading: boolean;
  }[];
  explanation: {
    headline: string;
    input_changes: { between: string[]; field: string; description: string }[];
    agreed_core: string[];
    only_in: Record<string, string[]>;
    spread: Record<string, { values: Record<string, number>; min: number; max: number; delta: number }>;
    notes: string[];
  };
  assumptions: string[];
}

interface FrontierPlan {
  direction: string;
  objectives: { criticality: number; coverage: number; cost: number };
  status: string;
  covered_demand: number;
  total_demand: number;
  coverage_percent: number;
  served_assets: string[];
  served_population: number;
  unserved_count: number;
  wall_ms: number;
  assignments?: { asset_code: string; resource_code: string; quantity: number; rationale: string }[];
}

interface FrontierResponse {
  objectives: Record<string, string>;
  plans: FrontierPlan[];
  frontier_size: number;
  plans_explored: number;
  coverage_requirements_tried: number;
  solver_ms: number;
  skipped: { direction: string; status: string; requested_coverage?: number }[];
  notes: string[];
  assumptions: string[];
}

interface InvestmentOption {
  asset_id: number;
  asset_code: string;
  asset_name: string;
  category: string;
  intervention: string;
  mechanism: string;
  annual_cost: number;
  benefit: {
    population_protected: number;
    assets_saved: number;
    critical_services_protected: string[];
    resilience_score: number;
  };
  changes_anything: boolean;
}

interface InvestmentResponse {
  baseline: {
    trigger_codes: string[];
    assets_failed: number;
    population_at_risk: number;
    critical_services_lost: string[];
  };
  options: InvestmentOption[];
  portfolio?: {
    budget: number;
    spent: number;
    unspent: number;
    selected: { asset_code: string; intervention: string; annual_cost: number; population_protected: number }[];
    measured_together: { population_protected: number; assets_saved: number; population_at_risk_after: number };
    individual_benefits_sum: number;
    overlap_clawback: number;
  };
  method: { weighting: Record<string, number>; cost_basis: Record<string, string>; costs_are: string };
  assumptions: string[];
  notes: string[];
}

interface ReplayStep {
  index: number;
  at: string;
  kind: string;
  summary: string;
  detail: string;
  from: string | null;
  to: string | null;
  asset_code?: string;
  was?: string | null;
  now?: string;
}

interface Snapshot {
  moment: string;
  status_counts: Record<string, number>;
  assets: { id: number; code: string; name: string; category: string; status: string }[];
  failed_asset_ids: number[];
  incidents: { id: number; code: string; title: string; severity: string; status: string }[];
  population_at_risk: number;
  simulations: { run_id: number; code: string; summary: Record<string, number> }[];
  plans_designed: number;
  fidelity: { exact: string[]; inferred: string[]; not_reconstructed: string[] };
}

interface Replay {
  window: { since: string; until: string };
  steps: ReplayStep[];
  step_count: number;
  total_changes: number;
  truncated: boolean;
  snapshot_at_end: Snapshot;
  sources: string[];
  notes: string[];
}

interface MomentDiff {
  first: { moment: string; status_counts: Record<string, number> };
  second: { moment: string; status_counts: Record<string, number> };
  changes: { asset_code: string; asset_name: string; from: string; to: string; direction: string; at: string | null }[];
  worsened: { asset_code: string }[];
  improved: { asset_code: string }[];
  population_at_risk: { first: number; second: number; delta: number };
  notes: string[];
}

type TabId = "exposure" | "futures" | "tradeoffs" | "investment" | "history";

/* ------------------------------------------------------------------ pieces */

function Assumptions({ items, title = "How this is calculated" }: { items: string[]; title?: string }) {
  if (!items?.length) return null;
  return (
    <details className="rounded-xl border border-white/10 bg-white/[0.02] px-3 py-2">
      <summary className="cursor-pointer text-xs font-medium text-ink-300">{title}</summary>
      <ul className="mt-2 space-y-1.5 text-[11px] leading-relaxed text-ink-400">
        {items.map((item) => (
          <li key={item} className="flex gap-2">
            <span aria-hidden className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-accent/60" />
            {item}
          </li>
        ))}
      </ul>
    </details>
  );
}

/** A number with its unit, so a bare figure never has to be guessed at. */
function Metric({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wider text-ink-500">{label}</p>
      <p className="font-display text-lg text-white">{value}</p>
      {hint ? <p className="text-[10px] text-ink-500">{hint}</p> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ exposure */

function ExposureTab({ canPlan }: { canPlan: boolean }) {
  const [zone, setZone] = useState<string | null>(null);
  const heat = useAsync<HeatResponse>(() => api.get("/resilience/heatmap"), []);
  const criticality = useAsync<CriticalityResponse>(() => api.get("/resilience/criticality"), []);

  const selected = useMemo(
    () => heat.data?.zones.find((item) => item.code === zone) ?? null,
    [heat.data, zone],
  );

  return (
    <div className="space-y-4">
      {heat.error ? <Alert tone="danger" title="Zone risk unavailable">{heat.error}</Alert> : null}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,380px)]">
        <Panel>
          <PanelHeader
            title="Zone risk map"
            subtitle={
              heat.data
                ? `Built from ${heat.data.source === "synthetic" ? "a derived scenario" : `the ${heat.data.source} run`} · ${formatDateTime(heat.data.generated_at)}`
                : "Loading recorded impact"
            }
            icon={<Layers className="h-4 w-4" />}
            action={
              heat.data ? (
                <Badge tone="accent">{formatNumber(heat.data.totals.population_at_risk)} people at risk</Badge>
              ) : null
            }
          />
          {heat.loading && !heat.data ? (
            <LoadingBlock rows={4} label="Scoring zones" />
          ) : heat.data && heat.data.zones.length ? (
            <>
              <ZoneRiskMap
                zones={heat.data.zones}
                assets={heat.data.assets}
                legend={heat.data.legend}
                selectedZone={zone}
                onSelect={(code) => setZone((current) => (current === code ? null : code))}
              />
              <ul className="mt-3 grid gap-1.5 sm:grid-cols-2" aria-label="Zone risk summary">
                {[...heat.data.zones]
                  .sort((a, b) => b.risk_score - a.risk_score)
                  .map((item) => {
                    const token = bandToken(item.risk_score, heat.data!.legend);
                    return (
                      <li key={item.code}>
                        <button
                          type="button"
                          onClick={() => setZone((current) => (current === item.code ? null : item.code))}
                          className={`flex w-full items-center gap-2 rounded-lg border px-2.5 py-1.5 text-left text-xs transition ${
                            zone === item.code
                              ? "border-accent/50 bg-accent/10"
                              : "border-white/10 hover:bg-white/5"
                          }`}
                        >
                          <span
                            aria-hidden
                            className="h-2.5 w-2.5 shrink-0 rounded-sm"
                            style={{ backgroundColor: `var(--token-${token}, #45d8f5)` }}
                          />
                          <span className="flex-1 truncate text-ink-200">{item.name}</span>
                          <span className="font-mono text-[10px] text-ink-500">{item.risk_score.toFixed(0)}</span>
                          <span className="text-[10px] uppercase tracking-wide text-ink-400">{item.risk_band}</span>
                        </button>
                      </li>
                    );
                  })}
              </ul>
              <div className="mt-3 flex flex-wrap gap-3" aria-label="Risk band legend">
                {heat.data.legend.map((entry) => (
                  <span key={entry.band} className="flex items-center gap-1.5 text-[10px] text-ink-400">
                    <span
                      aria-hidden
                      className="h-2 w-2 rounded-sm"
                      style={{
                        backgroundColor: ["mint", "accent", "amber", "coral", "coral-deep"].includes(entry.color_token)
                          ? { mint: "#3ee6a5", accent: "#45d8f5", amber: "#ffb545", coral: "#ff6b6b", "coral-deep": "#ff8a5c" }[entry.color_token]
                          : "#7699ba",
                      }}
                    />
                    <span className="uppercase tracking-wider">{entry.label}</span>
                    <span className="text-ink-500">
                      {entry.threshold === null ? "80+" : `<${entry.threshold}`}
                    </span>
                  </span>
                ))}
              </div>
              <Assumptions items={heat.data.assumptions} />
            </>
          ) : (
            <EmptyState
              title="No zones to score"
              description="Add infrastructure with locations to see where risk concentrates."
            />
          )}
        </Panel>

        <div className="space-y-4">
          <Panel>
            <PanelHeader title="Selected zone" subtitle="Why this score" icon={<MapPin className="h-4 w-4" />} />
            {selected ? (
              <div className="space-y-3">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="font-display text-base text-white">{selected.name}</p>
                    <p className="text-[11px] text-ink-500">
                      {selected.district} · {selected.asset_count} assets · {formatNumber(selected.population)} residents
                    </p>
                  </div>
                  <Badge
                    tone={
                      selected.risk_band === "severe" || selected.risk_band === "high"
                        ? "danger"
                        : selected.risk_band === "elevated"
                          ? "warning"
                          : "success"
                    }
                  >
                    {selected.risk_score.toFixed(0)} · {selected.risk_band}
                  </Badge>
                </div>
                <div className="grid grid-cols-3 gap-2">
                  <Metric label="Failed" value={String(selected.assets_failed)} />
                  <Metric label="Degraded" value={String(selected.assets_degraded)} />
                  <Metric label="At risk" value={formatNumber(selected.population_at_risk)} />
                </div>
                <div>
                  <p className="label">Drivers</p>
                  <ul className="mt-1 space-y-1 text-[11px] leading-relaxed text-ink-300">
                    {selected.drivers.map((driver) => (
                      <li key={driver} className="flex gap-2">
                        <span aria-hidden className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-amber" />
                        {driver}
                      </li>
                    ))}
                  </ul>
                </div>
                {!selected.has_stored_impact ? (
                  <Alert tone="info">
                    No recorded failure in this zone. The score comes from asset criticality alone, so it is an
                    estimate of exposure rather than an observed impact.
                  </Alert>
                ) : null}
              </div>
            ) : (
              <p className="text-xs text-ink-400">
                Choose a zone on the map or in the list to see which assets drive its score.
              </p>
            )}
          </Panel>

          <Panel>
            <PanelHeader
              title="Most consequential assets"
              subtitle="Derived from the dependency graph"
              icon={<Target className="h-4 w-4" />}
            />
            {criticality.loading && !criticality.data ? (
              <LoadingBlock rows={4} label="Scoring the fleet" />
            ) : criticality.data ? (
              <>
                <ol className="space-y-1.5">
                  {criticality.data.ranking.slice(0, 6).map((row, index) => (
                    <li key={row.asset_id} className="rounded-lg border border-white/10 bg-white/[0.02] px-2.5 py-2">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-[10px] text-ink-500">{String(index + 1).padStart(2, "0")}</span>
                        <span className="font-mono text-[10px] text-accent">{row.code}</span>
                        <span className="flex-1 truncate text-xs text-ink-200">{row.name}</span>
                        <span className="font-display text-sm text-white">{row.criticality_index.toFixed(1)}</span>
                      </div>
                      <p className="mt-1 text-[10px] text-ink-500">
                        losing it fails {row.consequence.assets_failed} assets and affects{" "}
                        {formatNumber(row.consequence.population_affected)} people
                        {row.consequence.critical_services_lost.length
                          ? ` · ${row.consequence.critical_services_lost.map(titleCase).join(", ")}`
                          : ""}
                      </p>
                    </li>
                  ))}
                </ol>
                <p className="mt-2 text-[10px] text-ink-500">
                  {criticalityStats(criticality.data).scored} assets scored · mean{" "}
                  {criticalityStats(criticality.data).mean.toFixed(1)} · peak{" "}
                  {criticalityStats(criticality.data).peak.toFixed(1)}
                  {canPlan ? "" : " · read-only view"}
                </p>
                <Assumptions items={criticality.data.model.assumptions} title="Criticality model" />
              </>
            ) : (
              <p className="text-xs text-ink-400">No criticality data.</p>
            )}
          </Panel>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ futures */

function FuturesTab() {
  const [refresh, setRefresh] = useState(0);
  const [selected, setSelected] = useState<number[]>([]);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const scenarios = useAsync<WhatIf[]>(() => api.get("/resilience/whatif"), [refresh]);
  // The compare endpoint takes a repeated `ids` parameter, which ``qs`` -- a map
  // of single values -- cannot express, so the query string is built directly.
  const comparePaths = selected.map((id) => `ids=${id}`).join("&");

  const loadComparison = useCallback(async () => {
    if (selected.length < 2) return null;
    return api.get<Comparison>(`/resilience/whatif/compare?${comparePaths}`);
  }, [comparePaths, selected.length]);

  const [comparison, setComparison] = useState<Comparison | null>(null);
  const [seenRefresh, setSeenRefresh] = useState(refresh);

  // A new reading invalidates a comparison rendered from the old one.
  useEffect(() => {
    if (seenRefresh !== refresh) {
      setComparison(null);
      setSeenRefresh(refresh);
    }
  }, [refresh, seenRefresh]);

  async function observe(id: number) {
    setBusy(`observe-${id}`);
    setError(null);
    try {
      await api.post(`/resilience/whatif/${id}/observe`, { note });
      setNote("");
      setRefresh((value) => value + 1);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  async function runComparison() {
    if (selected.length < 2) {
      setError("Select at least two scenarios to compare.");
      return;
    }
    setBusy("compare");
    setError(null);
    try {
      setComparison(await loadComparison());
    } catch (err) {
      setError(errorMessage(err));
      setComparison(null);
    } finally {
      setBusy(null);
    }
  }

  const result = comparison;
  const scenariosData = scenarios.data ?? [];

  return (
    <div className="space-y-4">
      {error ? <Alert tone="danger" title="Comparison failed">{error}</Alert> : null}
      <Panel>
        <PanelHeader
          title="Saved futures"
          subtitle="Run a hypothesis, record what it produced, then compare"
          icon={<Split className="h-4 w-4" />}
          action={<Badge>{scenarios.data?.length ?? 0} scenarios</Badge>}
        />
        {scenarios.loading && !scenarios.data ? (
          <LoadingBlock rows={3} label="Loading scenarios" />
        ) : scenariosData.length === 0 ? (
          <EmptyState
            title="No what-if scenarios yet"
            description="Save a failure hypothesis from the simulation lab to compare futures here."
          />
        ) : (
          <div className="space-y-2">
            {scenariosData.map((scenario) => {
              const latest = scenario.observations[0];
              const checked = selected.includes(scenario.id);
              return (
                <div
                  key={scenario.id}
                  className={`rounded-xl border p-3 transition ${
                    checked ? "border-accent/40 bg-accent/[0.06]" : "border-white/10 bg-white/[0.02]"
                  }`}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <label className="flex flex-1 items-center gap-2 text-xs">
                      <input
                        type="checkbox"
                        className="h-3.5 w-3.5 accent-[#45d8f5]"
                        checked={checked}
                        onChange={() =>
                          setSelected((current) =>
                            current.includes(scenario.id)
                              ? current.filter((id) => id !== scenario.id)
                              : current.length >= 4
                                ? current
                                : [...current, scenario.id],
                          )
                        }
                        aria-label={`Compare ${scenario.name}`}
                      />
                      <span className="font-mono text-[10px] text-ink-500">{scenario.code}</span>
                      <span className="text-ink-200">{scenario.name}</span>
                      {scenario.is_baseline ? <Badge tone="accent">baseline</Badge> : null}
                    </label>
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => observe(scenario.id)}
                      disabled={busy === `observe-${scenario.id}`}
                    >
                      {busy === `observe-${scenario.id}` ? "Running…" : "Record reading"}
                    </Button>
                  </div>
                  <p className="mt-1 text-[11px] text-ink-400">
                    {latest
                      ? `${latest.headline} · ${formatDateTime(latest.created_at)}`
                      : "No reading recorded yet — the scenario is saved but has never been run."}
                  </p>
                </div>
              );
            })}
            <div className="flex flex-wrap items-end gap-2 pt-1">
              <Field label="Note for the next reading" htmlFor="whatif-note">
                <Input
                  id="whatif-note"
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                  placeholder="Why are you running it again?"
                  maxLength={300}
                />
              </Field>
              <Button onClick={runComparison} disabled={busy === "compare" || selected.length < 2}>
                {busy === "compare" ? "Comparing…" : `Compare ${selected.length || ""}`}
              </Button>
            </div>
          </div>
        )}
      </Panel>

      {result ? (
        <Panel>
          <PanelHeader
            title="What separates these futures"
            subtitle={result.explanation.headline}
            icon={<GitBranch className="h-4 w-4" />}
          />
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <caption className="sr-only">Scenario comparison by recorded reading</caption>
              <thead>
                <tr className="border-b border-white/10 text-[10px] uppercase tracking-wider text-ink-500">
                  <th scope="col" className="py-2 pr-3 font-medium">Measure</th>
                  {result.columns.map((column) => (
                    <th key={column.scenario.id} scope="col" className="py-2 pr-3 font-medium">
                      {column.scenario.code}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {[
                  ["Assets failed", "assets_failed"],
                  ["People affected", "affected_population"],
                  ["Critical services down", null],
                  ["Propagation depth", "max_depth_reached"],
                ].map(([label, key]) => (
                  <tr key={String(label)} className="border-b border-white/5">
                    <th scope="row" className="py-2 pr-3 font-normal text-ink-400">{label}</th>
                    {result.columns.map((column) => (
                      <td key={column.scenario.id} className="py-2 pr-3 text-ink-200">
                        {column.has_reading ? (
                          key ? (
                            formatNumber(column.metrics?.[key] ?? 0)
                          ) : (
                            (column.metrics?.critical_services_down as unknown as string[])?.length ?? 0
                          )
                        ) : (
                          <span className="text-ink-500">not recorded</span>
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="mt-3 grid gap-3 md:grid-cols-2">
            <div>
              <p className="label">Fails in every scenario</p>
              <p className="mt-1 text-[11px] text-ink-300">
                {result.explanation.agreed_core.length
                  ? result.explanation.agreed_core.join(", ")
                  : "None — the futures share no failures at all."}
              </p>
            </div>
            <div>
              <p className="label">Specific to one future</p>
              <ul className="mt-1 space-y-1 text-[11px] text-ink-300">
                {Object.entries(result.explanation.only_in).map(([code, assets]) => (
                  <li key={code}>
                    <span className="font-mono text-[10px] text-accent">{code}</span> {assets.join(", ")}
                  </li>
                ))}
                {Object.keys(result.explanation.only_in).length === 0 ? <li>None.</li> : null}
              </ul>
            </div>
          </div>

          <ul className="mt-3 space-y-1.5 text-[11px] leading-relaxed text-ink-300">
            {result.explanation.notes.map((item) => (
              <li key={item} className="flex gap-2">
                <span aria-hidden className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-accent/60" />
                {item}
              </li>
            ))}
          </ul>
          <Assumptions items={result.assumptions} title="How the comparison is made" />
        </Panel>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ trade-offs */

function TradeoffsTab({ canPlan }: { canPlan: boolean }) {
  const [budgetHours, setBudgetHours] = useState(12);
  const [runId, setRunId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [data, setData] = useState<FrontierResponse | null>(null);

  const runs = useAsync<{ id: number; code: string; summary?: Record<string, number> }[]>(
    async () => (await api.list<{ id: number; code: string }>("/simulations?page_size=20")).data,
    [],
  );

  async function solve() {
    if (!runId) {
      setError("Choose a simulation run to plan against.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const demands = await api.get<
        {
          asset_id: number;
          category: string;
          need: number;
          priority: number;
          eligible_categories: string[];
          service_window_minutes: number;
          estimated_hours: number;
        }[]
      >(`/simulations/${runId}/demands`);
      const resources = (await api.list<{ id: number }>("/resources?page_size=50")).data.map((item) => item.id);
      const response = await api.post<FrontierResponse>("/resilience/frontier", {
        title: `Frontier for run ${runId}`,
        simulation_run_id: runId,
        demands,
        resource_ids: resources,
        horizon_hours: budgetHours,
        must_serve_priority: null,
      });
      setData(response);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      {error ? <Alert tone="danger" title="Could not build the frontier">{error}</Alert> : null}
      <Panel>
        <PanelHeader
          title="Recovery trade-offs"
          subtitle="Every non-dominated plan, measured rather than assumed"
          icon={<Split className="h-4 w-4" />}
          action={data ? <Badge tone="accent">{data.frontier_size} plans</Badge> : null}
        />
        {!canPlan ? (
          <Alert tone="info">
            Building a frontier runs several solver passes. Your role can read resilience data but not run
            planning comparisons — ask an operator or analyst.
          </Alert>
        ) : (
          <div className="flex flex-wrap items-end gap-3">
            <Field label="Against run" htmlFor="frontier-run">
              <Select
                id="frontier-run"
                value={runId ?? ""}
                onChange={(event) => setRunId(Number(event.target.value) || null)}
              >
                <option value="">Choose a simulation run</option>
                {(runs.data ?? []).map((run) => (
                  <option key={run.id} value={run.id}>
                    {run.code}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Horizon (hours)" htmlFor="frontier-horizon">
              <Input
                id="frontier-horizon"
                type="number"
                min={1}
                max={72}
                value={budgetHours}
                onChange={(event) => setBudgetHours(Number(event.target.value) || 12)}
              />
            </Field>
            <Button onClick={solve} disabled={busy}>
              {busy ? "Solving…" : "Build frontier"}
            </Button>
          </div>
        )}
      </Panel>

      {data && data.plans.length > 1 ? <Tradeoff data={data} /> : null}

      {data ? (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {data.plans.map((plan, index) => (
            <Panel key={plan.direction} className="flex flex-col justify-between">
              <div>
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="text-[10px] uppercase tracking-wider text-ink-500">
                      Option {index + 1}
                    </p>
                    <p className="font-display text-base text-white">{plan.direction}</p>
                  </div>
                  <Badge tone={index === 0 ? "accent" : "neutral"}>{plan.coverage_percent.toFixed(0)}%</Badge>
                </div>
                <ProgressBar
                  value={plan.coverage_percent}
                  label={`Coverage: ${plan.covered_demand} of ${plan.total_demand} demands`}
                />
                <dl className="mt-3 grid grid-cols-3 gap-2">
                  <Metric label="Criticality" value={plan.objectives.criticality.toFixed(0)} />
                  <Metric label="Sites" value={`${plan.covered_demand}/${plan.total_demand}`} />
                  <Metric label="Cost" value={formatNumber(plan.objectives.cost)} />
                </dl>
                <p className="mt-2 text-[11px] text-ink-400">
                  Protects {formatNumber(plan.served_population)} people; {plan.unserved_count} demands left
                  unserved.
                </p>
                <div className="mt-2 flex flex-wrap gap-1">
                  {plan.served_assets.slice(0, 8).map((code) => (
                    <span key={code} className="rounded bg-white/5 px-1.5 py-0.5 font-mono text-[10px] text-ink-300">
                      {code}
                    </span>
                  ))}
                  {plan.served_assets.length > 8 ? (
                    <span className="px-1 text-[10px] text-ink-500">+{plan.served_assets.length - 8}</span>
                  ) : null}
                </div>
              </div>
              <p className="mt-3 text-[10px] text-ink-500">solved in {plan.wall_ms} ms</p>
            </Panel>
          ))}
        </div>
      ) : null}

      {data ? (
        <Panel>
          <PanelHeader title="What the frontier means" subtitle="The argument, stated" icon={<TriangleAlert className="h-4 w-4" />} />
          <ul className="space-y-1.5 text-[11px] leading-relaxed text-ink-300">
            {data.notes.map((item) => (
              <li key={item} className="flex gap-2">
                <span aria-hidden className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-amber" />
                {item}
              </li>
            ))}
          </ul>
          <div className="mt-3 grid gap-2 sm:grid-cols-3">
            {Object.entries(data.objectives).map(([key, description]) => (
              <div key={key} className="rounded-lg border border-white/10 bg-white/[0.02] p-2">
                <p className="text-[10px] uppercase tracking-wider text-ink-500">{key}</p>
                <p className="mt-0.5 text-[11px] text-ink-400">{description}</p>
              </div>
            ))}
          </div>
          <p className="mt-3 text-[10px] text-ink-500">
            {data.plans_explored} distinct plans from {data.coverage_requirements_tried} coverage requirements ·{" "}
            {(data.solver_ms / 1000).toFixed(1)}s of solving
          </p>
          <Assumptions items={data.assumptions} title="Frontier assumptions" />
        </Panel>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ investment */

function InvestmentTab() {
  const [objective, setObjective] = useState("balanced");
  const [budget, setBudget] = useState<string>("150000");
  const [data, setData] = useState<InvestmentResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (nextObjective: string, nextBudget: string) => {
      setBusy(true);
      setError(null);
      try {
        const response = await api.get<InvestmentResponse>(
          `/resilience/investment${qs({
            objective: nextObjective,
            budget: nextBudget ? Number(nextBudget) : undefined,
          })}`,
        );
        setData(response);
      } catch (err) {
        setError(errorMessage(err));
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  useEffect(() => {
    void load("balanced", "150000");
  }, [load]);

  return (
    <div className="space-y-4">
      {error ? <Alert tone="danger" title="Investment planning failed">{error}</Alert> : null}

      <div className="flex flex-wrap items-end gap-3">
        <Field label="Objective" htmlFor="invest-objective">
          <Select
            id="invest-objective"
            value={objective}
            onChange={(event) => {
              setObjective(event.target.value);
              void load(event.target.value, budget);
            }}
          >
            <option value="balanced">Balanced</option>
            <option value="population">Protect the most people</option>
            <option value="assets">Restore the most assets</option>
            <option value="critical">Protect critical services</option>
          </Select>
        </Field>
        <Field label="Annual budget" htmlFor="invest-budget" hint="Leave empty for an unconstrained ranking.">
          <Input
            id="invest-budget"
            type="number"
            min={0}
            step={10000}
            value={budget}
            onChange={(event) => setBudget(event.target.value)}
            onBlur={() => void load(objective, budget)}
          />
        </Field>
        <Button onClick={() => void load(objective, budget)} disabled={busy}>
          {busy ? "Measuring…" : "Re-plan"}
        </Button>
      </div>

      {data ? (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard
              label="Scenario planned against"
              value={data.baseline.trigger_codes.join(", ") || "—"}
              hint={`${data.baseline.assets_failed} assets fail`}
            />
            <StatCard
              label="People at risk"
              value={formatNumber(data.baseline.population_at_risk)}
              hint="without intervention"
            />
            <StatCard
              label="Critical services lost"
              value={String(data.baseline.critical_services_lost.length)}
              hint={data.baseline.critical_services_lost.map(titleCase).join(", ") || "none"}
            />
            <StatCard
              label="Options measured"
              value={String(data.options.length)}
              hint={`${data.options.filter((option) => option.changes_anything).length} change something`}
            />
          </div>

          {data.portfolio ? (
            <Panel>
              <PanelHeader
                title="Recommended package"
                subtitle={`Greedy under ${formatNumber(data.portfolio.budget)} a year`}
                icon={<Coins className="h-4 w-4" />}
                action={
                  <Badge tone="accent">
                    {formatNumber(data.portfolio.spent)} spent ·{" "}
                    {formatNumber(data.portfolio.unspent)} left
                  </Badge>
                }
              />
              {data.portfolio.selected.length === 0 ? (
                <p className="text-xs text-ink-400">
                  Nothing fits inside this budget. Raise it or widen the intervention types.
                </p>
              ) : (
                <>
                  <div className="grid gap-3 sm:grid-cols-3">
                    <Metric
                      label="Measured together"
                      value={`${formatNumber(data.portfolio.measured_together.population_protected)} people`}
                      hint="applying every choice at once"
                    />
                    <Metric
                      label="Assets saved"
                      value={String(data.portfolio.measured_together.assets_saved)}
                      hint={`${formatNumber(data.portfolio.measured_together.population_at_risk_after)} people still at risk`}
                    />
                    <Metric
                      label="Not claimed"
                      value={formatNumber(data.portfolio.overlap_clawback)}
                      hint="people counted twice by summing"
                    />
                  </div>
                  <ol className="mt-3 space-y-1.5">
                    {data.portfolio.selected.map((choice, index) => (
                      <li
                        key={`${choice.asset_code}-${choice.intervention}`}
                        className="flex flex-wrap items-center gap-2 rounded-lg border border-white/10 bg-white/[0.02] px-2.5 py-1.5 text-xs"
                      >
                        <span className="font-mono text-[10px] text-ink-500">{index + 1}</span>
                        <span className="font-mono text-[10px] text-accent">{choice.asset_code}</span>
                        <span className="text-ink-200">{titleCase(choice.intervention)}</span>
                        <span className="ml-auto text-ink-400">{formatNumber(choice.annual_cost)}/yr</span>
                        <span className="text-mint">{formatNumber(choice.population_protected)} protected</span>
                      </li>
                    ))}
                  </ol>
                </>
              )}
            </Panel>
          ) : null}

          <Panel>
            <PanelHeader
              title="Every option, ranked"
              subtitle="Benefit is a measured difference, not an estimate"
              icon={<Banknote className="h-4 w-4" />}
            />
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-left text-xs">
                <caption className="sr-only">Resilience investment options ranked by measured benefit</caption>
                <thead>
                  <tr className="border-b border-white/10 text-[10px] uppercase tracking-wider text-ink-500">
                    <th scope="col" className="py-2 pr-3 font-medium">Asset</th>
                    <th scope="col" className="py-2 pr-3 font-medium">Intervention</th>
                    <th scope="col" className="py-2 pr-3 text-right font-medium">Cost / yr</th>
                    <th scope="col" className="py-2 pr-3 text-right font-medium">People</th>
                    <th scope="col" className="py-2 pr-3 text-right font-medium">Assets</th>
                    <th scope="col" className="py-2 pr-3 font-medium">Effect</th>
                  </tr>
                </thead>
                <tbody>
                  {data.options.map((option) => (
                    <tr
                      key={`${option.asset_id}-${option.intervention}`}
                      className={`border-b border-white/5 ${option.changes_anything ? "" : "opacity-55"}`}
                    >
                      <td className="py-2 pr-3">
                        <span className="font-mono text-[10px] text-accent">{option.asset_code}</span>
                        <span className="ml-2 text-ink-300">{option.asset_name}</span>
                      </td>
                      <td className="py-2 pr-3 text-ink-200">{titleCase(option.intervention)}</td>
                      <td className="py-2 pr-3 text-right tabular-nums text-ink-300">
                        {formatNumber(option.annual_cost)}
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums text-ink-200">
                        {option.changes_anything ? formatNumber(option.benefit.population_protected) : "—"}
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums text-ink-200">
                        {option.changes_anything ? option.benefit.assets_saved : "—"}
                      </td>
                      <td className="py-2 pr-3 text-[11px] text-ink-400">
                        {option.changes_anything ? option.mechanism : "changes nothing measurable"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <ul className="mt-3 space-y-1.5 text-[11px] leading-relaxed text-ink-300">
              {data.notes.map((note) => (
                <li key={note} className="flex gap-2">
                  <span aria-hidden className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-mint" />
                  {note}
                </li>
              ))}
            </ul>
            <div className="mt-3 grid gap-2 sm:grid-cols-3">
              {Object.entries(data.method.cost_basis).map(([kind, basis]) => (
                <div key={kind} className="rounded-lg border border-white/10 bg-white/[0.02] p-2">
                  <p className="text-[10px] uppercase tracking-wider text-ink-500">{titleCase(kind)}</p>
                  <p className="mt-0.5 text-[11px] text-ink-400">{basis}</p>
                </div>
              ))}
            </div>
            <p className="mt-2 text-[10px] text-ink-500">Costs are {data.method.costs_are}.</p>
            <Assumptions items={data.assumptions} title="Planning assumptions" />
          </Panel>
        </>
      ) : busy ? (
        <LoadingBlock rows={5} label="Measuring interventions" />
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ history */

const STEP_TONE: Record<string, string> = {
  status: "border-amber/40",
  simulation: "border-accent/40",
  incident: "border-coral/40",
  design: "border-mint/40",
  dispatch: "border-mint/40",
  response: "border-white/15",
};

function HistoryTab() {
  const [steps, setSteps] = useState<number>(0);
  const [diff, setDiff] = useState<MomentDiff | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const replay = useAsync<Replay>(() => api.get("/resilience/timetravel?limit=200"), []);

  const atStep = replay.data?.steps[Math.min(steps, (replay.data?.steps.length ?? 1) - 1)] ?? null;

  async function compareWindow() {
    if (!replay.data) return;
    setBusy(true);
    setError(null);
    try {
      setDiff(
        await api.get<MomentDiff>(
          `/resilience/timetravel/diff${qs({
            first: replay.data.window.since,
            second: replay.data.window.until,
          })}`,
        ),
      );
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      {error ? <Alert tone="danger" title="Replay failed">{error}</Alert> : null}
      {replay.error ? <Alert tone="danger" title="History unavailable">{replay.error}</Alert> : null}

      <Panel>
        <PanelHeader
          title="Replay recorded history"
          subtitle={
            replay.data
              ? `${replay.data.step_count} recorded changes between ${formatDateTime(replay.data.window.since)} and ${formatDateTime(replay.data.window.until)}`
              : "Loading the record"
          }
          icon={<History className="h-4 w-4" />}
          action={
            replay.data ? (
              <Button variant="secondary" size="sm" onClick={compareWindow} disabled={busy}>
                {busy ? "Comparing…" : "Compare window ends"}
              </Button>
            ) : null
          }
        />
        {replay.loading && !replay.data ? (
          <LoadingBlock rows={4} label="Reading history" />
        ) : !replay.data?.steps.length ? (
          <EmptyState
            title="Nothing recorded in this window"
            description="The replay shows recorded changes only. An empty timeline is a statement about the record, not the city."
          />
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-3">
              <label className="flex-1 text-[11px] text-ink-400">
                Step {Math.min(steps + 1, replay.data.steps.length)} of {replay.data.steps.length}
                <input
                  type="range"
                  min={0}
                  max={replay.data.steps.length - 1}
                  value={steps}
                  onChange={(event) => setSteps(Number(event.target.value))}
                  className="mt-1 w-full accent-[#45d8f5]"
                  aria-label="Replay position"
                />
              </label>
              <div className="flex gap-1">
                <Button variant="secondary" size="sm" onClick={() => setSteps(0)} aria-label="Jump to first change">
                  <SkipBack className="h-3 w-3" />
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setSteps((value) => Math.max(0, value - 1))}
                  aria-label="Previous change"
                >
                  <ChevronLeft className="h-3 w-3" />
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setSteps((value) => Math.min(replay.data!.steps.length - 1, value + 1))}
                  aria-label="Next change"
                >
                  <ChevronRight className="h-3 w-3" />
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setSteps(replay.data!.steps.length - 1)}
                  aria-label="Jump to latest change"
                >
                  <SkipForward className="h-3 w-3" />
                </Button>
              </div>
            </div>

            {atStep ? (
              <div className="mt-3 rounded-xl border border-accent/30 bg-accent/[0.06] p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone="accent">{atStep.kind}</Badge>
                  <span className="text-xs text-white">{atStep.summary}</span>
                  <span className="ml-auto font-mono text-[10px] text-ink-400">
                    {formatDateTime(atStep.at)}
                  </span>
                </div>
                {atStep.detail ? <p className="mt-1 text-[11px] text-ink-300">{atStep.detail}</p> : null}
                {atStep.was || atStep.now ? (
                  <p className="mt-1 text-[11px] text-ink-400">
                    Status{" "}
                    <span className="text-ink-200">{atStep.was ?? "unknown"}</span> →{" "}
                    <span className="text-ink-100">{atStep.now}</span>
                  </p>
                ) : null}
              </div>
            ) : null}

            <ol className="mt-3 max-h-80 space-y-1 overflow-y-auto pr-1 scrollbar-slim" aria-label="Recorded changes">
              {replay.data.steps.map((step, index) => (
                <li key={`${step.index}-${step.at}`}>
                  <button
                    type="button"
                    onClick={() => setSteps(index)}
                    className={`flex w-full items-start gap-2 rounded-lg border-l-2 px-2 py-1.5 text-left text-[11px] transition ${
                      index === steps ? "bg-white/[0.07]" : "hover:bg-white/[0.03]"
                    } ${STEP_TONE[step.kind] ?? "border-white/10"}`}
                  >
                    <span className="w-16 shrink-0 font-mono text-[10px] text-ink-500">
                      {formatDateTime(step.at).split(",")[0]}
                    </span>
                    <span className="flex-1 text-ink-300">{step.summary}</span>
                  </button>
                </li>
              ))}
            </ol>

            <ul className="mt-3 space-y-1.5 text-[11px] leading-relaxed text-ink-300">
              {replay.data.notes.map((note) => (
                <li key={note} className="flex gap-2">
                  <span aria-hidden className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-accent/60" />
                  {note}
                </li>
              ))}
            </ul>
          </>
        )}
      </Panel>

      {replay.data ? (
        <div className="grid gap-4 xl:grid-cols-2">
          <Panel>
            <PanelHeader
              title="City at the end of the window"
              subtitle={formatDateTime(replay.data.snapshot_at_end.moment)}
              icon={<MapPin className="h-4 w-4" />}
            />
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {Object.entries(replay.data.snapshot_at_end.status_counts).map(([status, count]) => (
                <Metric key={status} label={titleCase(status)} value={String(count)} />
              ))}
            </div>
            <p className="mt-2 text-[11px] text-ink-400">
              {formatNumber(replay.data.snapshot_at_end.population_at_risk)} people at risk ·{" "}
              {replay.data.snapshot_at_end.incidents.length} incidents open ·{" "}
              {replay.data.snapshot_at_end.plans_designed} plans designed
            </p>
            <div className="mt-3 space-y-2">
              {(["exact", "inferred", "not_reconstructed"] as const).map((kind) => (
                <div key={kind}>
                  <p className="text-[10px] uppercase tracking-wider text-ink-500">
                    {kind === "not_reconstructed" ? "Not reconstructed" : kind}
                  </p>
                  <ul className="mt-0.5 space-y-0.5 text-[11px] text-ink-400">
                    {replay.data!.snapshot_at_end.fidelity[kind].map((item) => (
                      <li key={item} className="flex gap-2">
                        <span
                          aria-hidden
                          className={`mt-1.5 h-1 w-1 shrink-0 rounded-full ${
                            kind === "exact" ? "bg-mint" : kind === "inferred" ? "bg-amber" : "bg-coral"
                          }`}
                        />
                        {item}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </Panel>

          <Panel>
            <PanelHeader
              title="Between the two ends"
              subtitle="Worse, better, or unchanged"
              icon={<GitBranch className="h-4 w-4" />}
            />
            {diff ? (
              <>
                <div className="grid grid-cols-3 gap-2">
                  <Metric label="Worsened" value={String(diff.worsened.length)} />
                  <Metric label="Improved" value={String(diff.improved.length)} />
                  <Metric
                    label="Risk change"
                    value={`${diff.population_at_risk.delta > 0 ? "+" : ""}${formatNumber(diff.population_at_risk.delta)}`}
                    hint="people"
                  />
                </div>
                <ul className="mt-3 max-h-56 space-y-1 overflow-y-auto scrollbar-slim">
                  {diff.changes.map((change) => (
                    <li
                      key={`${change.asset_code}-${change.at}`}
                      className="flex items-center gap-2 rounded-lg bg-white/[0.02] px-2 py-1 text-[11px]"
                    >
                      <span className="font-mono text-[10px] text-accent">{change.asset_code}</span>
                      <span className="flex-1 truncate text-ink-400">{change.asset_name}</span>
                      <span className="text-ink-300">
                        {change.from} → {change.to}
                      </span>
                      <Badge tone={change.direction === "worse" ? "danger" : "success"}>
                        {change.direction}
                      </Badge>
                    </li>
                  ))}
                </ul>
                <ul className="mt-2 space-y-1 text-[11px] text-ink-400">
                  {diff.notes.map((note) => (
                    <li key={note}>{note}</li>
                  ))}
                </ul>
              </>
            ) : (
              <p className="text-xs text-ink-400">
                Compare the two ends of the window to see which assets moved and in which direction.
              </p>
            )}
          </Panel>
        </div>
      ) : null}

      {replay.data ? <Assumptions items={replay.data.sources} title="Where the replay comes from" /> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ page */

export default function ResiliencePage() {
  const { can } = useAuth();
  const canPlan = can("resilience:plan");
  const [tab, setTab] = useState<TabId>("exposure");

  return (
    <>
      <PageHeader
        eyebrow="Resilience intelligence"
        title="Where the city is fragile, and what to do about it"
        description="Exposure by zone, saved failure hypotheses, recovery trade-offs and a priced investment plan. Every screen states what it measured and what it assumed."
        actions={
          <>
            <Badge tone="accent">
              <ShieldCheck className="h-3 w-3" /> resilience:read
            </Badge>
            {canPlan ? <Badge>planning enabled</Badge> : <Badge>read only</Badge>}
          </>
        }
      />

      <div className="mt-4">
        <AiFeatureCard
          testId="resilience-report"
          title="Resilience report"
          subtitle="A short situational brief from the platform's own figures — exposure, failures, tasks and the criticality index. Provider-labelled, no invented numbers."
          endpoint="/ai/resilience/report"
          buttonLabel="Generate report"
        />
      </div>

      <Tabs
        value={tab}
        onChange={setTab}
        label="Resilience sections"
        tabs={[
          { id: "exposure", label: "Exposure" },
          { id: "futures", label: "What-if futures" },
          { id: "tradeoffs", label: "Recovery trade-offs" },
          { id: "investment", label: "Investment plan" },
          { id: "history", label: "Time travel" },
        ]}
      />

      <div className="mt-4">
        {tab === "exposure" ? (
          <ExposureTab canPlan={canPlan} />
        ) : tab === "futures" ? (
          <div className="space-y-4">
            <ScenarioCompareAi />
            <FuturesTab />
          </div>
        ) : tab === "tradeoffs" ? (
          <TradeoffsTab canPlan={canPlan} />
        ) : tab === "investment" ? (
          <InvestmentTab />
        ) : (
          <HistoryTab />
        )}
      </div>
    </>
  );
}

/**
 * The trade-off, named.
 *
 * A frontier is a set of plans that are each unbeaten on something; the table of
 * cards leaves the reader to work out which is which. Naming the cheapest and the
 * highest-coverage plan, and saying what each gives up, is the whole argument in
 * two sentences -- and it refuses to invent a single "best", because there is not
 * one.
 */
function Tradeoff({ data }: { data: FrontierResponse }) {
  const cheapest = [...data.plans].sort((a, b) => a.objectives.cost - b.objectives.cost)[0];
  const most = [...data.plans].sort((a, b) => b.coverage_percent - a.coverage_percent)[0];

  // The cheapest plan may also be the most complete one, in which case there is no
  // trade-off to describe and inventing one would be worse than saying nothing.
  const sameRow = cheapest.direction === most.direction;

  return (
    <Panel>
      <PanelHeader
        title="The trade-off"
        subtitle="What the cheapest plan gives up"
        icon={<TriangleAlert className="h-4 w-4" />}
      />
      {sameRow ? (
        <p className="text-xs leading-relaxed text-ink-300">
          One plan is both the cheapest and the most complete: <strong>{cheapest.direction}</strong>,
          covering {cheapest.coverage_percent.toFixed(0)}% of demand for{" "}
          {formatNumber(cheapest.objectives.cost)}. On this demand set there is no trade-off to make.
        </p>
      ) : (
        <div className="space-y-2 text-xs leading-relaxed text-ink-300">
          <p>
            <strong>{cheapest.direction}</strong> is the cheapest at{" "}
            {formatNumber(cheapest.objectives.cost)}, but covers{" "}
            {(most.coverage_percent - cheapest.coverage_percent).toFixed(0)} points less demand
            ({cheapest.coverage_percent.toFixed(0)}% against {most.coverage_percent.toFixed(0)}%).
          </p>
          <p>
            <strong>{most.direction}</strong> protects {formatNumber(most.served_population)} people
            against {formatNumber(cheapest.served_population)}, for{" "}
            {formatNumber(most.objectives.cost - cheapest.objectives.cost)} more.
          </p>
          <p className="text-[11px] text-ink-500">
            Neither is the answer. Which one is right depends on whether the budget or the uncovered
            demand is the binding constraint, and that is a decision this page does not make. Nothing
            here is committed until a plan is approved elsewhere.
          </p>
        </div>
      )}
    </Panel>
  );
}
