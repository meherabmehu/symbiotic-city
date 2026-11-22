"use client";

/**
 * Screen 05 — Main Dashboard.
 *
 * Every figure comes from GET /api/dashboard, which aggregates stored records
 * for the caller's role scope. Role-dependent panels (approvals, my tasks) are
 * shown only to the roles that can act on them.
 */

import Link from "next/link";
import {
  Activity,
  AlertTriangle,
  ArrowUpRight,
  CheckCircle2,
  ClipboardList,
  Cpu,
  Gauge,
  RefreshCw,
  ShieldAlert,
  Users,
  Zap,
} from "lucide-react";
import { ComparisonBarChart, StatusDonut, TrendAreaChart } from "@/components/charts";
import {
  Alert,
  Badge,
  Button,
  EmptyState,
  Panel,
  PanelHeader,
  PageHeader,
  ProgressBar,
  SeverityBadge,
  StatCard,
  StatusPill,
} from "@/components/ui";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatNumber, percent, timeAgo } from "@/lib/format";
import { useAsync } from "@/lib/hooks";
import type { DashboardBundle } from "@/lib/types";

const STATUS_COLORS: Record<string, string> = {
  operational: "#3ee6a5",
  degraded: "#ffb545",
  offline: "#ff6b6b",
  maintenance: "#45d8f5",
  archived: "#4d6d8f",
};

export default function DashboardPage() {
  const { user, hasRole, can } = useAuth();
  const { data, loading, error, reload } = useAsync<DashboardBundle>(
    () => api.get("/dashboard"),
    [],
  );

  const overview = data?.overview;
  const roleLabel = user?.roles[0]?.name ?? "Member";
  const statusData = overview
    ? Object.entries(overview.asset_status_counts)
        .filter(([, count]) => count > 0)
        .map(([status, count]) => ({
          name: status,
          value: count,
          color: STATUS_COLORS[status] ?? "#4d6d8f",
        }))
    : [];

  return (
    <>
      <PageHeader
        eyebrow={`${roleLabel} workspace`}
        title={`Good ${new Date().getHours() < 12 ? "morning" : new Date().getHours() < 18 ? "afternoon" : "evening"}, ${user?.full_name.split(" ")[0] ?? "operator"}`}
        description={
          hasRole("field_engineer")
            ? "Your dispatch queue, affected assets and the deadlines that matter today."
            : "Live posture of the Aurora Vale network across power, water, health, telecom and civic assets."
        }
        actions={
          <>
            <Button variant="secondary" onClick={reload} loading={loading}>
              <RefreshCw className="h-4 w-4" aria-hidden /> Refresh
            </Button>
            {can("simulation:run") ? (
              <Link href="/simulation" className="btn-primary">
                <Cpu className="h-4 w-4" aria-hidden /> New simulation
              </Link>
            ) : (
              <Link href="/my-tasks" className="btn-primary">
                <ClipboardList className="h-4 w-4" aria-hidden /> My queue
              </Link>
            )}
          </>
        }
      />

      {error ? (
        <Alert tone="danger" title="Dashboard unavailable">
          {error}
        </Alert>
      ) : null}

      {loading && !data ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 8 }).map((_, index) => (
            <div key={index} className="skeleton h-24" />
          ))}
        </div>
      ) : null}

      {data ? (
        <div className="space-y-4">
          <section aria-label="Key indicators" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard
              label="City health index"
              value={overview ? `${overview.health_index.toFixed(1)}%` : "—"}
              hint={`${overview?.assets_total ?? 0} assets in scope`}
              tone={overview && overview.health_index > 88 ? "mint" : "amber"}
              icon={<Activity className="h-4 w-4" />}
              trend={{
                value: `${overview?.avg_load_percent.toFixed(0) ?? 0}% average load`,
                direction: "flat",
              }}
            />
            <StatCard
              label="Active incidents"
              value={overview?.active_incidents ?? 0}
              hint={`${overview?.incidents_reported ?? 0} reported in ${overview?.window_days ?? 30}d window`}
              tone={overview && overview.active_incidents > 0 ? "coral" : "mint"}
              icon={<AlertTriangle className="h-4 w-4" />}
            />
            <StatCard
              label="Open repair tasks"
              value={overview?.open_tasks ?? 0}
              hint={`${overview?.completed_tasks ?? 0} completed · MTTR ${overview?.mean_time_to_repair_hours ?? 0}h`}
              tone="accent"
              icon={<ClipboardList className="h-4 w-4" />}
            />
            <StatCard
              label="Resource utilisation"
              value={`${overview?.resource_utilisation_percent ?? 0}%`}
              hint={`${overview?.resource_reserved ?? 0} of ${overview?.resource_capacity ?? 0} units reserved`}
              tone="amber"
              icon={<Gauge className="h-4 w-4" />}
            />
          </section>

          <div className="grid gap-4 xl:grid-cols-3">
            <Panel className="xl:col-span-2">
              <PanelHeader
                title="Incident flow"
                subtitle={`Reported vs resolved over the last ${overview?.window_days ?? 30} days`}
                icon={<AlertTriangle className="h-4 w-4" />}
                action={
                  <Link href="/analytics" className="btn-ghost btn-sm">
                    Analytics <ArrowUpRight className="h-3 w-3" />
                  </Link>
                }
              />
              {data.incident_trends && data.incident_trends.length > 0 ? (
                <TrendAreaChart
                  data={data.incident_trends}
                  series={[
                    { key: "reported", label: "Reported", color: "#ffb545" },
                    { key: "resolved", label: "Resolved", color: "#3ee6a5" },
                    { key: "critical", label: "Critical", color: "#ff6b6b" },
                  ]}
                  summary={`Incident trend over ${data.incident_trends.length} days: ${data.incident_trends.reduce((s, d) => s + d.reported, 0)} reported, ${data.incident_trends.reduce((s, d) => s + d.resolved, 0)} resolved.`}
                />
              ) : (
                <EmptyState title="No incident history in this window" description="Trends appear after incidents are reported or seeded." />
              )}
            </Panel>

            <Panel>
              <PanelHeader title="Asset posture" subtitle="Distribution by operational status" icon={<ShieldAlert className="h-4 w-4" />} />
              {statusData.length ? (
                <>
                  <StatusDonut data={statusData} label="assets" />
                  <ul className="mt-2 space-y-1.5">
                    {statusData.map((item) => (
                      <li key={item.name} className="flex items-center justify-between text-xs">
                        <span className="flex items-center gap-2 text-ink-300">
                          <span className="h-2 w-2 rounded-full" style={{ backgroundColor: item.color }} />
                          {item.name}
                        </span>
                        <span className="text-ink-100">{item.value}</span>
                      </li>
                    ))}
                  </ul>
                </>
              ) : (
                <EmptyState title="No assets yet" />
              )}
              <div className="mt-4 rounded-xl border border-white/10 bg-white/[0.03] p-3">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-ink-400">Population at risk</span>
                  <span className="font-semibold text-white">{formatNumber(overview?.population_at_risk ?? 0)}</span>
                </div>
                <div className="mt-1 flex items-center justify-between text-xs">
                  <span className="text-ink-400">Dependency links</span>
                  <span className="text-ink-100">{overview?.dependencies_total ?? 0}</span>
                </div>
              </div>
            </Panel>
          </div>

          <div className="grid gap-4 xl:grid-cols-3">
            <Panel className="xl:col-span-2">
              <PanelHeader
                title="Active incidents"
                subtitle="Open cases ordered by severity"
                icon={<AlertTriangle className="h-4 w-4" />}
                action={
                  <Link href="/incidents" className="btn-ghost btn-sm">
                    All incidents <ArrowUpRight className="h-3 w-3" />
                  </Link>
                }
              />
              {data.active_incident_list.length ? (
                <ul className="space-y-2">
                  {data.active_incident_list.map((incident) => (
                    <li key={incident.id}>
                      <Link
                        href={`/incidents/${incident.id}`}
                        className="flex flex-col gap-2 rounded-xl border border-white/10 bg-white/[0.02] px-3 py-2.5 transition hover:border-accent/30 hover:bg-white/[0.05] sm:flex-row sm:items-center sm:justify-between"
                      >
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="font-mono text-[10px] text-ink-500">{incident.code}</span>
                            <SeverityBadge severity={incident.severity} />
                            <StatusPill status={incident.status} />
                          </div>
                          <p className="mt-1 truncate text-sm font-medium text-white">{incident.title}</p>
                        </div>
                        <div className="flex items-center gap-4 text-[11px] text-ink-400">
                          <span>{formatNumber(incident.affected_population)} residents</span>
                          <span>{timeAgo(incident.reported_at)}</span>
                        </div>
                      </Link>
                    </li>
                  ))}
                </ul>
              ) : (
                <EmptyState
                  title="No active incidents"
                  description="The network is stable. Inject a controlled failure in the simulation lab to exercise recovery."
                  icon={<CheckCircle2 className="h-5 w-5 text-mint" />}
                  action={
                    can("simulation:run") ? (
                      <Link href="/simulation" className="btn-secondary btn-sm">
                        Open failure lab
                      </Link>
                    ) : undefined
                  }
                />
              )}
            </Panel>

            <div className="space-y-4">
              {hasRole("field_engineer") ? (
                <Panel>
                  <PanelHeader title="My queue" subtitle="Assigned to you" icon={<ClipboardList className="h-4 w-4" />} />
                  <p className="font-display text-3xl font-semibold text-white">{data.my_open_tasks}</p>
                  <p className="mt-1 text-xs text-ink-400">open tasks require acceptance</p>
                  <Link href="/my-tasks" className="btn-secondary btn-sm mt-3 w-full">
                    Open workspace
                  </Link>
                </Panel>
              ) : null}

              <Panel>
                <PanelHeader
                  title="Plan approvals"
                  subtitle="Recovery plans awaiting sign-off"
                  icon={<Zap className="h-4 w-4" />}
                />
                <p className="font-display text-3xl font-semibold text-white">{data.pending_plan_approvals}</p>
                <p className="mt-1 text-xs text-ink-400">
                  Approval reserves resources transactionally and starts field dispatch.
                </p>
                <Link href="/optimization" className="btn-secondary btn-sm mt-3 w-full">
                  Optimisation queue
                </Link>
              </Panel>

              <Panel>
                <PanelHeader title="Notifications" subtitle="Unread items" icon={<Activity className="h-4 w-4" />} />
                <p className="font-display text-3xl font-semibold text-white">{data.unread_notifications}</p>
                <Link href="/notifications" className="btn-ghost btn-sm mt-3 w-full">
                  Review inbox
                </Link>
              </Panel>
            </div>
          </div>

          <div className="grid gap-4 xl:grid-cols-2">
            <Panel>
              <PanelHeader
                title="Asset availability by category"
                subtitle="Operational share per asset class"
                icon={<Gauge className="h-4 w-4" />}
              />
              <ComparisonBarChart
                data={data.category_breakdown.map((row) => ({
                  category: row.label.replace(/ .*/, ""),
                  operational: row.operational,
                  degraded: row.degraded,
                  offline: row.offline,
                }))}
                stacked
                xKey="category"
                bars={[
                  { key: "operational", label: "Operational", color: "#3ee6a5" },
                  { key: "degraded", label: "Degraded", color: "#ffb545" },
                  { key: "offline", label: "Offline", color: "#ff6b6b" },
                ]}
                summary="Stacked count of asset statuses per category."
              />
            </Panel>

            <Panel>
              <PanelHeader
                title="Latest simulation"
                subtitle="Most recent cascade analysis"
                icon={<Cpu className="h-4 w-4" />}
                action={
                  <Link href="/simulation" className="btn-ghost btn-sm">
                    Lab <ArrowUpRight className="h-3 w-3" />
                  </Link>
                }
              />
              {data.latest_simulation ? (
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm font-semibold text-white">{data.latest_simulation.name}</p>
                      <p className="font-mono text-[10px] text-ink-500">{data.latest_simulation.code}</p>
                    </div>
                    <StatusPill status={data.latest_simulation.status} />
                  </div>
                  <dl className="grid grid-cols-2 gap-2 text-xs">
                    {[
                      ["Assets failed", data.latest_simulation.summary.assets_failed],
                      ["Assets impacted", data.latest_simulation.summary.assets_impacted],
                      ["Max depth", data.latest_simulation.summary.max_depth_reached],
                      ["Affected residents", formatNumber(data.latest_simulation.summary.affected_population)],
                    ].map(([label, value]) => (
                      <div key={String(label)} className="rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-2">
                        <dt className="text-[10px] uppercase tracking-wider text-ink-500">{label}</dt>
                        <dd className="mt-0.5 font-display text-base font-semibold text-white">{value}</dd>
                      </div>
                    ))}
                  </dl>
                  <div>
                    <div className="mb-1 flex justify-between text-[11px] text-ink-400">
                      <span>Severity index</span>
                      <span>{data.latest_simulation.summary.severity_index.toFixed(0)} / 100</span>
                    </div>
                    <ProgressBar
                      value={data.latest_simulation.summary.severity_index}
                      tone={data.latest_simulation.summary.severity_index > 60 ? "coral" : "amber"}
                      label="Simulation severity index"
                    />
                  </div>
                  <Link href={`/simulations/${data.latest_simulation.id}`} className="btn-secondary btn-sm w-full">
                    Open results
                  </Link>
                </div>
              ) : (
                <EmptyState
                  title="No simulations yet"
                  description="Run the cascade engine to see how a failure propagates."
                  action={can("simulation:run") ? <Link href="/simulation" className="btn-secondary btn-sm">Open lab</Link> : undefined}
                />
              )}
            </Panel>
          </div>

          <div className="grid gap-4 xl:grid-cols-3">
            <Panel>
              <PanelHeader title="Resource utilisation" subtitle="Reserved vs available" icon={<Gauge className="h-4 w-4" />} />
              {data.resource_utilisation?.length ? (
                <ul className="space-y-2.5">
                  {data.resource_utilisation.map((row) => (
                    <li key={row.category}>
                      <div className="mb-1 flex items-center justify-between text-xs">
                        <span className="text-ink-300">{row.label}</span>
                        <span className="text-ink-400">
                          {row.reserved}/{row.capacity}
                        </span>
                      </div>
                      <ProgressBar
                        value={row.utilisation_percent}
                        tone={row.utilisation_percent > 80 ? "coral" : row.utilisation_percent > 50 ? "amber" : "mint"}
                        label={`${row.label} utilisation`}
                      />
                    </li>
                  ))}
                </ul>
              ) : (
                <EmptyState title="No resources registered" />
              )}
            </Panel>

            <Panel>
              <PanelHeader title="Repair throughput" subtitle="Verification performance" icon={<CheckCircle2 className="h-4 w-4" />} />
              <dl className="space-y-2 text-xs">
                <div className="flex justify-between">
                  <dt className="text-ink-400">Verified tasks</dt>
                  <dd className="text-ink-100">{data.recovery_performance?.verified_tasks ?? 0}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-ink-400">Avg hours to verify</dt>
                  <dd className="text-ink-100">{data.recovery_performance?.avg_hours_to_verify ?? 0}h</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-ink-400">On-time share</dt>
                  <dd className="text-ink-100">{percent(data.recovery_performance?.on_time_percent ?? 0, 0)}</dd>
                </div>
              </dl>
              <ul className="mt-3 space-y-1.5">
                {(data.recovery_performance?.by_priority ?? []).map((row) => (
                  <li key={row.priority} className="flex items-center justify-between text-[11px] text-ink-400">
                    <span>Priority {row.priority}</span>
                    <span>
                      {row.tasks} tasks · {row.avg_hours}h avg
                    </span>
                  </li>
                ))}
              </ul>
            </Panel>

            <Panel>
              <PanelHeader title="Task board" subtitle="Current dispatch state" icon={<ClipboardList className="h-4 w-4" />} />
              {data.task_board.length ? (
                <ul className="space-y-1.5">
                  {data.task_board.map((task) => (
                    <li key={task.id}>
                      <Link
                        href={`/tasks/${task.id}`}
                        className="flex items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-xs transition hover:bg-white/5"
                      >
                        <span className="min-w-0 truncate text-ink-200">
                          <span className="font-mono text-[10px] text-ink-500">{task.code}</span> {task.title}
                        </span>
                        <span className="flex items-center gap-1.5">
                          <Badge tone={task.assignee_id ? "accent" : "neutral"}>
                            {task.assignee_id ? "assigned" : "unassigned"}
                          </Badge>
                          <StatusPill status={task.status} />
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              ) : (
                <EmptyState title="No tasks in the board" />
              )}
              <Link href="/tasks" className="btn-ghost btn-sm mt-2 w-full">
                Full dispatch board
              </Link>
            </Panel>
          </div>

          <p className="flex items-center gap-2 text-[11px] text-ink-600">
            <Users className="h-3 w-3" aria-hidden />
            Figures are aggregated from stored operational records · generated {timeAgo(data?.generated_at)} ·
            synthetic dataset
          </p>
        </div>
      ) : null}
    </>
  );
}
