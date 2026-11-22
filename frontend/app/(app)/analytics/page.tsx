"use client";

/**
 * Screen 15 — Analytics & Reports.
 *
 * Every metric comes from stored records via /api/analytics/*. CSV export hits
 * the real export endpoint (permission: analytics:export), so the file reflects
 * the same rows the screen shows.
 */

import { useState } from "react";
import {
  BarChart3,
  CircleDollarSign,
  Download,
  FileText,
  Gauge,
  Play,
  RefreshCw,
  TrendingUp,
} from "lucide-react";
import { ComparisonBarChart, LineTrend, StatusDonut, TrendAreaChart } from "@/components/charts";
import {
  Alert,
  Badge,
  Button,
  EmptyState,
  Panel,
  PanelHeader,
  PageHeader,
  ProgressBar,
  Select,
  Spinner,
  Tabs,
} from "@/components/ui";
import { api, qs } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatNumber, percent, titleCase } from "@/lib/format";
import { useAsync } from "@/lib/hooks";
import type { Overview } from "@/lib/types";

interface CategoryRow {
  category: string;
  label: string;
  total: number;
  operational: number;
  degraded: number;
  offline: number;
  maintenance: number;
  availability_percent: number;
}

interface IncidentAnalytics {
  trend: { date: string; reported: number; resolved: number; critical: number }[];
  severity: { severity: string; count: number }[];
}

interface ResourceRow {
  category: string;
  label: string;
  count: number;
  capacity: number;
  reserved: number;
  available: number;
  utilisation_percent: number;
}

interface SimulationAnalytics {
  comparison: {
    id: number;
    code: string;
    name: string;
    started_at: string;
    severity_index: number;
    assets_failed: number;
    affected_population: number;
    max_depth_reached: number;
    status: string;
  }[];
  impact: { code: string; name: string; summary: Record<string, number | string>; started_at: string }[];
}

interface RecoveryAnalytics {
  verified_tasks: number;
  avg_hours_to_verify: number;
  by_priority: { priority: number; tasks: number; avg_hours: number }[];
  on_time_percent: number;
}

const EXPORTS = [
  { kind: "overview", label: "City overview" },
  { kind: "categories", label: "Asset categories" },
  { kind: "incidents", label: "Incident register" },
  { kind: "tasks", label: "Repair tasks" },
  { kind: "resources", label: "Resource utilisation" },
  { kind: "recovery", label: "Recovery performance" },
  { kind: "simulations", label: "Simulation comparison" },
];

export default function AnalyticsPage() {
  const { can } = useAuth();
  const [tab, setTab] = useState<"operational" | "recovery" | "simulation">("operational");
  const [days, setDays] = useState(30);
  const [refreshKey, setRefreshKey] = useState(0);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const overview = useAsync<Overview>(() => api.get(`/analytics/overview${qs({ days })}`), [days, refreshKey]);
  const categories = useAsync<CategoryRow[]>(() => api.get("/analytics/categories"), [refreshKey]);
  const incidents = useAsync<IncidentAnalytics>(() => api.get(`/analytics/incidents${qs({ days })}`), [days, refreshKey]);
  const resources = useAsync<ResourceRow[]>(() => api.get("/analytics/resources"), [refreshKey]);
  const simulations = useAsync<SimulationAnalytics>(() => api.get("/analytics/simulations"), [refreshKey]);
  const recovery = useAsync<RecoveryAnalytics>(() => api.get("/analytics/recovery?days=90"), [refreshKey]);

  async function download(kind: string) {
    setDownloading(kind);
    setError(null);
    try {
      const csv = await api.download(`/analytics/export${qs({ kind, days: 90 })}`);
      const blob = new Blob([csv], { type: "text/csv" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `symbiotic-city-${kind}.csv`;
      anchor.click();
      URL.revokeObjectURL(url);
      setNotice(`${kind} report exported (${csv.split("\n").length - 1} rows). The export is recorded in the audit log.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Export failed.");
    } finally {
      setDownloading(null);
    }
  }

  const data = overview.data;

  return (
    <>
      <PageHeader
        eyebrow="Reporting"
        title="Analytics & reports"
        description="Operational analytics computed from stored incidents, tasks, reservations and simulation runs — nothing is pre-computed or hardcoded. CSV exports use the same underlying queries."
        actions={
          <>
            <Select value={days} onChange={(event) => setDays(Number(event.target.value))} aria-label="Reporting window" className="max-w-[150px]">
              {[7, 30, 90, 180, 365].map((value) => (
                <option key={value} value={value}>Last {value} days</option>
              ))}
            </Select>
            <Button variant="secondary" onClick={() => setRefreshKey((k) => k + 1)} loading={overview.loading}>
              <RefreshCw className="h-4 w-4" aria-hidden /> Refresh
            </Button>
          </>
        }
      />

      {error ? <Alert tone="danger">{error}</Alert> : null}
      {notice ? <Alert tone="success" action={<Button variant="ghost" size="sm" onClick={() => setNotice(null)}>Dismiss</Button>}>{notice}</Alert> : null}

      <Tabs
        value={tab}
        onChange={setTab}
        label="Report sections"
        tabs={[
          { id: "operational", label: "Operational health" },
          { id: "recovery", label: "Recovery performance" },
          { id: "simulation", label: "Simulation analysis" },
        ]}
      />

      {overview.loading && !data ? (
        <div className="grid place-items-center py-20"><Spinner label="Computing analytics…" /></div>
      ) : null}

      {tab === "operational" && data ? (
        <div className="mt-4 space-y-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {[
              { label: "Health index", value: `${data.health_index.toFixed(1)}%`, icon: Gauge, hint: `${data.assets_total} assets` },
              { label: "Mean time to repair", value: `${data.mean_time_to_repair_hours}h`, icon: TrendingUp, hint: "verified tasks" },
              { label: "Incidents resolved", value: `${data.incidents_resolved}/${data.incidents_reported}`, icon: BarChart3, hint: `${data.window_days}d window` },
              { label: "Population at risk", value: formatNumber(data.population_at_risk), icon: CircleDollarSign, hint: "from open incidents" },
            ].map((tile) => (
              <div key={tile.label} className="glass p-4">
                <div className="flex items-center justify-between">
                  <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-ink-500">{tile.label}</p>
                  <tile.icon className="h-4 w-4 text-accent" />
                </div>
                <p className="mt-1 font-display text-2xl font-semibold text-white">{tile.value}</p>
                <p className="mt-0.5 text-[10px] text-ink-500">{tile.hint}</p>
              </div>
            ))}
          </div>

          <div className="grid gap-4 xl:grid-cols-3">
            <Panel className="xl:col-span-2">
              <PanelHeader title="Incident flow" subtitle={`Reported vs resolved per day · ${days} day window`} icon={<BarChart3 className="h-4 w-4" />} />
              {incidents.data?.trend.length ? (
                <TrendAreaChart
                  data={incidents.data.trend}
                  series={[
                    { key: "reported", label: "Reported", color: "#ffb545" },
                    { key: "resolved", label: "Resolved", color: "#3ee6a5" },
                  ]}
                  summary={`Daily incident counts for ${incidents.data.trend.length} days.`}
                />
              ) : (
                <EmptyState title="No incidents in this window" />
              )}
            </Panel>

            <Panel>
              <PanelHeader title="Severity mix" subtitle="All recorded incidents" />
              {incidents.data?.severity.length ? (
                <>
                  <StatusDonut
                    data={incidents.data.severity.map((row, index) => ({
                      name: titleCase(row.severity),
                      value: row.count,
                      color: ["#ff6b6b", "#ffb545", "#45d8f5", "#3ee6a5"][index % 4],
                    }))}
                    label="incidents"
                  />
                  <ul className="mt-2 space-y-1 text-[11px]">
                    {incidents.data.severity.map((row) => (
                      <li key={row.severity} className="flex justify-between text-ink-400">
                        <span>{titleCase(row.severity)}</span>
                        <span className="text-ink-200">{row.count}</span>
                      </li>
                    ))}
                  </ul>
                </>
              ) : (
                <EmptyState title="No severity data" />
              )}
            </Panel>
          </div>

          <div className="grid gap-4 xl:grid-cols-2">
            <Panel>
              <PanelHeader title="Category availability" subtitle="Operational share per asset class" icon={<Gauge className="h-4 w-4" />} />
              {categories.data?.length ? (
                <ul className="space-y-2.5">
                  {categories.data.map((row) => (
                    <li key={row.category}>
                      <div className="mb-1 flex items-center justify-between text-xs">
                        <span className="text-ink-300">{row.label}</span>
                        <span className="text-ink-400">
                          {row.operational}/{row.total} · {percent(row.availability_percent, 0)}
                        </span>
                      </div>
                      <ProgressBar
                        value={row.availability_percent}
                        tone={row.availability_percent < 60 ? "coral" : row.availability_percent < 85 ? "amber" : "mint"}
                        label={`${row.label} availability`}
                      />
                    </li>
                  ))}
                </ul>
              ) : (
                <EmptyState title="No category data" />
              )}
            </Panel>

            <Panel>
              <PanelHeader title="Resource utilisation" subtitle="Reserved share of capacity" icon={<Gauge className="h-4 w-4" />} />
              {resources.data?.length ? (
                <ComparisonBarChart
                  data={resources.data.map((row) => ({
                    category: row.label.replace(/ .*/, ""),
                    capacity: row.capacity,
                    reserved: row.reserved,
                  }))}
                  xKey="category"
                  bars={[
                    { key: "capacity", label: "Capacity", color: "#45d8f5" },
                    { key: "reserved", label: "Reserved", color: "#ffb545" },
                  ]}
                  summary="Capacity and reserved quantity per resource category."
                />
              ) : (
                <EmptyState title="No resource data" />
              )}
            </Panel>
          </div>
        </div>
      ) : null}

      {tab === "recovery" ? (
        <div className="mt-4 space-y-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {[
              { label: "Verified tasks", value: recovery.data?.verified_tasks ?? 0 },
              { label: "Avg hours to verify", value: `${recovery.data?.avg_hours_to_verify ?? 0}h` },
              { label: "On-time share", value: percent(recovery.data?.on_time_percent ?? 0, 0) },
              { label: "Priority bands", value: recovery.data?.by_priority.length ?? 0 },
            ].map((tile) => (
              <div key={tile.label} className="glass p-4">
                <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-ink-500">{tile.label}</p>
                <p className="mt-1 font-display text-2xl font-semibold text-white">{tile.value}</p>
              </div>
            ))}
          </div>

          <Panel>
            <PanelHeader title="Repair cycle by priority" subtitle="Verified tasks only · 90 day window" icon={<TrendingUp className="h-4 w-4" />} />
            {recovery.data?.by_priority.length ? (
              <LineTrend
                data={recovery.data.by_priority.map((row) => ({
                  date: `P${row.priority}`,
                  tasks: row.tasks,
                  avg_hours: row.avg_hours,
                }))}
                series={[
                  { key: "avg_hours", label: "Avg hours", color: "#45d8f5" },
                  { key: "tasks", label: "Tasks verified", color: "#3ee6a5", dashed: true },
                ]}
                summary="Average verification hours and task counts per priority band."
              />
            ) : (
              <EmptyState
                title="No verified tasks yet"
                description="Complete a recovery cycle — approve a plan, let an engineer finish a task, then verify it — to populate this report."
              />
            )}
          </Panel>
        </div>
      ) : null}

      {tab === "simulation" ? (
        <div className="mt-4 space-y-4">
          <Panel>
            <PanelHeader title="Severity by run" subtitle="Compare recent cascade analyses" icon={<Play className="h-4 w-4" />} />
            {simulations.data?.comparison.length ? (
              <ComparisonBarChart
                data={simulations.data.comparison.map((row) => ({
                  label: row.code,
                  severity: row.severity_index,
                  failed: row.assets_failed,
                }))}
                xKey="label"
                bars={[
                  { key: "severity", label: "Severity index", color: "#ff6b6b" },
                  { key: "failed", label: "Assets failed", color: "#ffb545" },
                ]}
                summary="Severity index and failed asset counts for recent simulation runs."
              />
            ) : (
              <EmptyState title="No simulation runs" description="Run a scenario in the failure lab to build this comparison." />
            )}
          </Panel>

          <Panel>
            <PanelHeader title="Export reports" subtitle="CSV generated server-side from the same queries" icon={<FileText className="h-4 w-4" />} />
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {EXPORTS.map((item) => (
                <div key={item.kind} className="flex items-center justify-between rounded-xl border border-white/10 bg-white/[0.02] px-3 py-2">
                  <span className="text-xs text-ink-200">{item.label}</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => download(item.kind)}
                    loading={downloading === item.kind}
                    disabled={!can("analytics:export")}
                    aria-label={`Export ${item.label} as CSV`}
                  >
                    <Download className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ))}
            </div>
            {!can("analytics:export") ? (
              <p className="mt-2 text-[11px] text-amber">
                Your role cannot export. Ask an administrator for the City Analyst or Super Admin role.
              </p>
            ) : null}
            {data ? (
              <div className="mt-3 flex flex-wrap gap-2">
                <Badge>window {data.window_days}d</Badge>
                <Badge>{data.simulations_total} simulations</Badge>
                <Badge>{data.plans_total} plans</Badge>
                <Badge>{data.completed_tasks} tasks completed</Badge>
              </div>
            ) : null}
          </Panel>
        </div>
      ) : null}
    </>
  );
}
