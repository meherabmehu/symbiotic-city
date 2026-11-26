"use client";

/**
 * Screen 09 — Failure Simulation Lab.
 *
 * Operators pick initial failure assets and parameters, then POST
 * /api/simulations/run. The engine result is displayed here and persisted for
 * the results screen. Parameters are explicit so every run is reproducible.
 */

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState } from "react";
import {
  Beaker,
  ChevronRight,
  Clock,
  Cpu,
  History,
  Info,
  Layers,
  Play,
  RotateCcw,
  Save,
  Sparkles,
  TriangleAlert,
} from "lucide-react";
import { CityTwin } from "@/components/city-twin";
import {
  Alert,
  Badge,
  Button,
  EmptyState,
  Field,
  Input,
  Panel,
  PanelHeader,
  PageHeader,
  ProgressBar,
  Select,
  Spinner,
  StatusPill,
  Tabs,
  Textarea,
} from "@/components/ui";
import { api, errorMessage, qs } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatDateTime, formatNumber, percent, titleCase } from "@/lib/format";
import { useAsync } from "@/lib/hooks";
import { WhatIfExtract } from "@/components/ai/whatif-extract";
import type { Asset, ListResponse, SimulationRun, SimulationRunDetail, TwinGraph } from "@/lib/types";

interface Scenario {
  id: number;
  name: string;
  description: string;
  failure_mode: string;
  cascade_threshold: number;
  max_depth: number;
  random_seed: number;
  initial_failure_ids: number[];
  is_template: boolean;
  created_at: string;
}

const FAILURE_MODES = [
  { value: "total_failure", label: "Total failure", hint: "Asset delivers zero capacity immediately." },
  { value: "capacity_loss", label: "Capacity loss", hint: "75% capacity lost; partial supply continues." },
  { value: "maintenance", label: "Maintenance", hint: "60% capacity unavailable during a work window." },
];

function SimulationLab() {
  const { can } = useAuth();
  const router = useRouter();
  const params = useSearchParams();
  const preselected = Number(params.get("asset") ?? 0);

  const [selectedIds, setSelectedIds] = useState<number[]>(preselected ? [preselected] : []);
  const [name, setName] = useState("");
  const [mode, setMode] = useState("total_failure");
  const [threshold, setThreshold] = useState(0.35);
  const [maxDepth, setMaxDepth] = useState(6);
  const [seed, setSeed] = useState(42);
  const [createIncident, setCreateIncident] = useState(false);
  const [incidentTitle, setIncidentTitle] = useState("");
  const [incidentSeverity, setIncidentSeverity] = useState("high");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SimulationRunDetail | null>(null);
  const [tab, setTab] = useState<"setup" | "scenarios" | "history">("setup");
  const [scenarioName, setScenarioName] = useState("");
  const [savedNotice, setSavedNotice] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const graph = useAsync<TwinGraph>(() => api.get("/twin/graph"), []);
  const assets = useAsync<Asset[]>(async () => (await api.list<Asset>("/infrastructure?page_size=100&sort=code")).data, []);
  const scenarios = useAsync<Scenario[]>(() => api.get("/scenarios"), [refreshKey]);
  const runs = useAsync<{ rows: SimulationRun[]; total: number }>(async () => {
    const response: ListResponse<SimulationRun> = await api.list("/simulations?page_size=10");
    return { rows: response.data, total: response.meta.total };
  }, [refreshKey]);

  const assumptions = useAsync<{ assumptions: string[] }>(() => api.get("/simulations/assumptions"), []);

  useEffect(() => {
    if (preselected) {
      setSelectedIds((prev) => (prev.includes(preselected) ? prev : [preselected]));
      const asset = assets.data?.find((item) => item.id === preselected);
      if (asset) setName(`${asset.code} ${mode.replace(/_/g, " ")} drill`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preselected, assets.data]);

  const selectedAssets = useMemo(
    () => (assets.data ?? []).filter((asset) => selectedIds.includes(asset.id)),
    [assets.data, selectedIds],
  );

  function toggleAsset(id: number) {
    setSelectedIds((prev) => {
      if (prev.includes(id)) return prev.filter((item) => item !== id);
      if (prev.length >= 10) return prev;
      return [...prev, id];
    });
  }

  async function run() {
    if (selectedIds.length === 0) {
      setError("Select at least one asset to fail.");
      return;
    }
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const payload = {
        name: name.trim() || undefined,
        failure_mode: mode,
        initial_failure_ids: selectedIds,
        cascade_threshold: threshold,
        max_depth: maxDepth,
        random_seed: seed,
        create_incident: createIncident,
        incident_title: createIncident ? incidentTitle || undefined : undefined,
        incident_severity: incidentSeverity,
      };
      const run = await api.post<SimulationRunDetail>("/simulations/run", payload);
      setResult(run);
      setRefreshKey((k) => k + 1);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function saveScenario() {
    if (!scenarioName.trim() || selectedIds.length === 0) {
      setError("Name the scenario and select at least one asset before saving.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.post("/scenarios", {
        name: scenarioName.trim(),
        description: `Saved from the failure lab: ${mode.replace(/_/g, " ")} at ${percent(threshold * 100, 0)} threshold.`,
        failure_mode: mode,
        initial_failure_ids: selectedIds,
        cascade_threshold: threshold,
        max_depth: maxDepth,
        random_seed: seed,
        save_as_template: true,
      });
      setSavedNotice(`Scenario “${scenarioName}” saved.`);
      setScenarioName("");
      setRefreshKey((k) => k + 1);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  function loadScenario(scenario: Scenario) {
    setSelectedIds(scenario.initial_failure_ids);
    setMode(scenario.failure_mode);
    setThreshold(scenario.cascade_threshold);
    setMaxDepth(scenario.max_depth);
    setSeed(scenario.random_seed);
    setName(scenario.name);
    setTab("setup");
    setSavedNotice(`Loaded scenario “${scenario.name}”.`);
  }

  const impactLevels = useMemo(() => {
    const levels = result?.impacts.map((impact) => ({
      ...impact,
      asset_id: impact.asset_id,
    })) ?? [];
    return levels;
  }, [result]);

  return (
    <>
      <PageHeader
        eyebrow="Simulation lab"
        title="Failure simulation"
        description="Model a controlled failure, watch it propagate through dependency edges and quantify who is affected. Runs are deterministic for a given seed and snapshot, and every run is stored for comparison."
        actions={
          <>
            <Badge tone="accent">
              <Cpu className="h-3 w-3" /> NetworkX cascade engine
            </Badge>
            <Badge>{runs.data?.total ?? 0} stored runs</Badge>
          </>
        }
      />

      {error ? <Alert tone="danger" title="Simulation failed">{error}</Alert> : null}
      {savedNotice ? <Alert tone="success" action={<Button variant="ghost" size="sm" onClick={() => setSavedNotice(null)}>Dismiss</Button>}>{savedNotice}</Alert> : null}

      <Tabs
        value={tab}
        onChange={setTab}
        label="Simulation sections"
        tabs={[
          { id: "setup", label: "Scenario setup" },
          { id: "scenarios", label: "Saved scenarios", count: scenarios.data?.length },
          { id: "history", label: "Run history", count: runs.data?.total },
        ]}
      />

      <div className="mt-4">
        <WhatIfExtract onCreated={() => setRefreshKey((k) => k + 1)} />
      </div>

      {/* grid-cols-1 base: below xl the implicit auto track sized itself to the
          asset picker's nowrap rows and overflowed a phone viewport. */}
      <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,420px)_minmax(0,1fr)]">
        <div className="space-y-4">
          {tab === "setup" ? (
            <>
              <Panel>
                <PanelHeader title="Failure definition" subtitle="Choose the assets that fail at t=0" icon={<Beaker className="h-4 w-4" />} />
                <div className="space-y-3">
                  <Field label="Run name" htmlFor="run-name" hint="Optional — used in history and reports.">
                    <Input
                      id="run-name"
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                      placeholder="PS-01 total failure drill"
                      maxLength={200}
                    />
                  </Field>

                  <div>
                    <p className="label">Initial failure assets ({selectedIds.length}/10)</p>
                    <div
                      className="max-h-56 overflow-y-auto rounded-xl border border-white/10 bg-white/[0.02] p-2 scrollbar-slim"
                      role="group"
                      aria-label="Initial failure assets"
                    >
                      {(assets.data ?? []).length === 0 ? (
                        <p className="px-2 py-3 text-xs text-ink-500">No assets available.</p>
                      ) : (
                        <ul className="space-y-0.5">
                          {(assets.data ?? []).map((asset) => {
                            const checked = selectedIds.includes(asset.id);
                            return (
                              <li key={asset.id}>
                                <label
                                  className={`flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-xs transition ${
                                    checked ? "bg-coral/10 text-white" : "text-ink-300 hover:bg-white/5"
                                  }`}
                                >
                                  <input
                                    type="checkbox"
                                    className="h-3.5 w-3.5 accent-[#45d8f5]"
                                    checked={checked}
                                    onChange={() => toggleAsset(asset.id)}
                                  />
                                  <span className="font-mono text-[10px] text-ink-500">{asset.code}</span>
                                  <span className="flex-1 truncate">{asset.name}</span>
                                  <StatusPill status={asset.status} />
                                </label>
                              </li>
                            );
                          })}
                        </ul>
                      )}
                    </div>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          const worst = [...(assets.data ?? [])]
                            .sort((a, b) => a.criticality - b.criticality)
                            .slice(0, 1);
                          if (worst[0]) setSelectedIds([worst[0].id]);
                        }}
                      >
                        <Sparkles className="h-3 w-3" /> Most critical asset
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => setSelectedIds([])} disabled={!selectedIds.length}>
                        <RotateCcw className="h-3 w-3" /> Clear
                      </Button>
                    </div>
                  </div>

                  <Field label="Failure mode" htmlFor="mode" required>
                    <Select id="mode" value={mode} onChange={(event) => setMode(event.target.value)}>
                      {FAILURE_MODES.map((option) => (
                        <option key={option.value} value={option.value}>{option.label}</option>
                      ))}
                    </Select>
                  </Field>
                  <p className="text-[11px] text-ink-500">{FAILURE_MODES.find((option) => option.value === mode)?.hint}</p>

                  <div className="grid grid-cols-2 gap-3">
                    <Field label="Cascade threshold" htmlFor="threshold" hint="Share of demand lost before a dependent fails.">
                      <Input
                        id="threshold"
                        type="number"
                        min={0.05}
                        max={1}
                        step={0.05}
                        value={threshold}
                        onChange={(event) => setThreshold(Number(event.target.value))}
                      />
                    </Field>
                    <Field label="Max depth" htmlFor="depth" hint="Hops to traverse.">
                      <Input
                        id="depth"
                        type="number"
                        min={1}
                        max={12}
                        value={maxDepth}
                        onChange={(event) => setMaxDepth(Number(event.target.value))}
                      />
                    </Field>
                    <Field label="Random seed" htmlFor="seed" hint="Deterministic replay.">
                      <Input
                        id="seed"
                        type="number"
                        min={0}
                        value={seed}
                        onChange={(event) => setSeed(Number(event.target.value))}
                      />
                    </Field>
                    <Field label="Incident severity" htmlFor="severity" hint="Applied if an incident is created.">
                      <Select id="severity" value={incidentSeverity} onChange={(event) => setIncidentSeverity(event.target.value)}>
                        {["critical", "high", "medium", "low"].map((value) => (
                          <option key={value} value={value}>{titleCase(value)}</option>
                        ))}
                      </Select>
                    </Field>
                  </div>

                  <label className="flex items-center gap-2 text-xs text-ink-300">
                    <input
                      type="checkbox"
                      className="h-3.5 w-3.5 accent-[#45d8f5]"
                      checked={createIncident}
                      onChange={(event) => setCreateIncident(event.target.checked)}
                    />
                    Create a real incident from this run (starts the recovery workflow)
                  </label>
                  {createIncident ? (
                    <Field label="Incident title" htmlFor="incident-title">
                      <Input
                        id="incident-title"
                        value={incidentTitle}
                        onChange={(event) => setIncidentTitle(event.target.value)}
                        placeholder="Cascading outage from PS-01 total failure"
                        maxLength={180}
                      />
                    </Field>
                  ) : null}

                  <div className="flex flex-wrap gap-2">
                    <Button onClick={run} loading={busy} disabled={!can("simulation:run")} className="flex-1">
                      <Play className="h-4 w-4" aria-hidden /> Run simulation
                    </Button>
                  </div>
                  {!can("simulation:run") ? (
                    <p className="text-[11px] text-amber">Your role can view simulations but not execute them.</p>
                  ) : null}
                </div>
              </Panel>

              <Panel>
                <PanelHeader title="Save as scenario" subtitle="Reusable preset for repeatable demos" icon={<Save className="h-4 w-4" />} />
                <div className="flex gap-2">
                  <Input
                    value={scenarioName}
                    onChange={(event) => setScenarioName(event.target.value)}
                    placeholder="Scenario name"
                    aria-label="Scenario name"
                    maxLength={160}
                  />
                  <Button variant="secondary" onClick={saveScenario} loading={busy} disabled={!can("simulation:run")}>
                    Save
                  </Button>
                </div>
              </Panel>

              <Panel>
                <PanelHeader title="Model assumptions" subtitle="Stated limits of the simulation" icon={<Info className="h-4 w-4" />} />
                <ul className="space-y-2 text-[11px] leading-relaxed text-ink-400">
                  {(assumptions.data?.assumptions ?? []).map((line) => (
                    <li key={line} className="flex gap-2">
                      <ChevronRight className="mt-0.5 h-3 w-3 shrink-0 text-accent" />
                      {line}
                    </li>
                  ))}
                </ul>
              </Panel>
            </>
          ) : null}

          {tab === "scenarios" ? (
            <Panel>
              <PanelHeader title="Saved scenarios" subtitle="Templates available to every analyst" icon={<Layers className="h-4 w-4" />} />
              {scenarios.loading ? <Spinner /> : null}
              {scenarios.data?.length ? (
                <ul className="space-y-2">
                  {scenarios.data.map((scenario) => (
                    <li key={scenario.id} className="rounded-xl border border-white/10 bg-white/[0.02] p-3">
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <p className="text-sm font-medium text-white">{scenario.name}</p>
                          <p className="mt-0.5 text-[11px] text-ink-500">{scenario.description}</p>
                        </div>
                        {scenario.is_template ? <Badge tone="accent">template</Badge> : null}
                      </div>
                      <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[10px] text-ink-500">
                        <Badge>{scenario.failure_mode.replace(/_/g, " ")}</Badge>
                        <Badge>threshold {percent(scenario.cascade_threshold * 100, 0)}</Badge>
                        <Badge>depth {scenario.max_depth}</Badge>
                        <Badge>{scenario.initial_failure_ids.length} seed assets</Badge>
                        <span className="ml-auto">{formatDateTime(scenario.created_at)}</span>
                      </div>
                      <Button variant="secondary" size="sm" className="mt-2" onClick={() => loadScenario(scenario)}>
                        Load into lab
                      </Button>
                    </li>
                  ))}
                </ul>
              ) : (
                <EmptyState title="No saved scenarios" description="Configure a run in the setup tab and save it as a template." />
              )}
            </Panel>
          ) : null}

          {tab === "history" ? (
            <Panel>
              <PanelHeader title="Run history" subtitle="Most recent ten runs" icon={<History className="h-4 w-4" />} />
              {runs.data?.rows.length ? (
                <ul className="space-y-2">
                  {runs.data.rows.map((run) => (
                    <li key={run.id} className="rounded-xl border border-white/10 bg-white/[0.02] px-3 py-2">
                      <div className="flex items-center justify-between gap-2">
                        <Link href={`/simulations/${run.id}`} className="text-sm font-medium text-white hover:text-accent">
                          {run.name}
                        </Link>
                        <StatusPill status={run.status} />
                      </div>
                      <div className="mt-1 flex flex-wrap gap-2 text-[10px] text-ink-500">
                        <span className="font-mono">{run.code}</span>
                        <span>{run.summary.assets_failed} failed</span>
                        <span>{formatNumber(run.summary.affected_population)} affected</span>
                        <span>severity {run.summary.severity_index.toFixed(0)}</span>
                        <span className="ml-auto">{formatDateTime(run.started_at)}</span>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <EmptyState title="No runs yet" description="Execute a simulation to populate the history." />
              )}
            </Panel>
          ) : null}
        </div>

        <div className="space-y-4">
          <Panel className="p-3 sm:p-4">
            <PanelHeader
              title={result ? `Cascade preview — ${result.code}` : "Twin preview"}
              subtitle={
                result
                  ? `${result.summary.assets_failed} failed · ${result.summary.assets_impacted} impacted · depth ${result.summary.max_depth_reached}`
                  : "Selected failure assets are outlined before the run"
              }
              icon={<Cpu className="h-4 w-4" />}
            />
            <CityTwin
              graph={graph.data}
              impacts={impactLevels}
              loading={graph.loading || busy}
              height={360}
              showEdges
            />
          </Panel>

          {busy ? (
            <Panel>
              <div className="flex items-center gap-3">
                <Spinner label="Running cascade engine…" />
              </div>
              <p className="mt-2 text-[11px] text-ink-500">
                Propagating through dependency edges up to {maxDepth} hops.
              </p>
            </Panel>
          ) : null}

          {result ? (
            <>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                {[
                  { label: "Assets failed", value: result.summary.assets_failed, tone: "coral" as const },
                  { label: "Degraded", value: result.summary.assets_degraded, tone: "amber" as const },
                  { label: "Affected", value: result.summary.assets_affected, tone: "accent" as const },
                  { label: "Residents", value: formatNumber(result.summary.affected_population), tone: "mint" as const },
                ].map((tile) => (
                  <div key={tile.label} className="glass p-4">
                    <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-ink-500">{tile.label}</p>
                    <p className="mt-1 font-display text-2xl font-semibold text-white">{tile.value}</p>
                  </div>
                ))}
              </div>

              <Panel>
                <PanelHeader
                  title="Result summary"
                  subtitle={`Severity index ${result.summary.severity_index.toFixed(0)}/100 · snapshot ${result.snapshot_hash.slice(0, 12)}…`}
                  icon={<TriangleAlert className="h-4 w-4" />}
                  action={
                    <Link href={`/simulations/${result.id}`} className="btn-secondary btn-sm">
                      Full results <ChevronRight className="h-3 w-3" />
                    </Link>
                  }
                />
                <ProgressBar
                  value={result.summary.severity_index}
                  tone={result.summary.severity_index > 60 ? "coral" : result.summary.severity_index > 35 ? "amber" : "mint"}
                  label="Severity index"
                />
                <div className="mt-3 flex flex-wrap gap-2">
                  {result.summary.critical_services_down.length ? (
                    result.summary.critical_services_down.map((service) => (
                      <Badge key={service} tone="danger">{service} down</Badge>
                    ))
                  ) : (
                    <Badge tone="success">No critical services down</Badge>
                  )}
                  <Badge>depth {result.summary.max_depth_reached}</Badge>
                  <Badge>{result.duration_ms ?? 0}ms engine</Badge>
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => router.push(`/simulations/${result.id}`)}
                  >
                    Detailed impact table
                  </Button>
                  {can("optimization:run") ? (
                    <Button
                      size="sm"
                      onClick={async () => {
                        try {
                          const demands = await api.get<{ demands: unknown[] }>(`/simulations/${result.id}/demands`);
                          const items = Array.isArray(demands?.demands) ? demands.demands.length : 0;
                          setSavedNotice(`Derived ${items} resource demands from this run. Open the optimiser to plan recovery.`);
                        } catch (err) {
                          setError(errorMessage(err));
                        }
                      }}
                    >
                      Derive resource demand
                    </Button>
                  ) : null}
                  {result.incident_id ? (
                    <Link href={`/incidents/${result.incident_id}`} className="btn-secondary btn-sm">
                      Incident opened
                    </Link>
                  ) : null}
                </div>
              </Panel>

              <Panel>
                <PanelHeader title="Propagation timeline" subtitle="Ordered by cascade depth" icon={<Clock className="h-4 w-4" />} />
                <div className="space-y-2">
                  {Array.from(new Set(result.timeline.map((row) => row.depth)))
                    .sort((a, b) => a - b)
                    .map((depth) => (
                      <div key={depth}>
                        <p className="mb-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-ink-500">
                          Depth {depth}
                        </p>
                        <div className="flex flex-wrap gap-1.5">
                          {result.timeline
                            .filter((row) => row.depth === depth)
                            .map((row) => (
                              <span
                                key={`${row.depth}-${row.asset_id}`}
                                className={`rounded-lg border px-2 py-1 text-[10px] ${
                                  row.level === "failed"
                                    ? "border-coral/40 bg-coral/10 text-coral"
                                    : row.level === "degraded"
                                      ? "border-amber/40 bg-amber/10 text-amber"
                                      : "border-accent/40 bg-accent/10 text-accent"
                                }`}
                                title={row.reason}
                              >
                                {row.code}
                              </span>
                            ))}
                        </div>
                      </div>
                    ))}
                </div>
              </Panel>
            </>
          ) : (
            <Panel>
              <EmptyState
                title="No simulation executed yet"
                description="Pick one or more assets on the left and run the cascade engine. Results, the twin overlay and the propagation timeline appear here."
                icon={<Beaker className="h-5 w-5" />}
              />
            </Panel>
          )}
        </div>
      </div>
    </>
  );
}

export default function SimulationPage() {
  return (
    <Suspense fallback={<div className="grid place-items-center py-24"><Spinner label="Loading lab…" /></div>}>
      <SimulationLab />
    </Suspense>
  );
}
