"use client";

/**
 * Screen 10 — Simulation Results.
 *
 * Detailed, exportable result of a stored run: impact table with explanations,
 * propagation timeline, category breakdown and the assumptions that produced it.
 */

import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import {
  ArrowLeft,
  ArrowUpRight,
  Check,
  Cpu,
  Download,
  Layers,
  ListTree,
  ShieldAlert,
  TriangleAlert,
} from "lucide-react";
import { ComparisonBarChart, StatusDonut } from "@/components/charts";
import {
  Alert,
  Badge,
  Button,
  DataTable,
  Panel,
  PanelHeader,
  PageHeader,
  ProgressBar,
  SeverityBadge,
  Spinner,
  StatusPill,
} from "@/components/ui";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatDateTime, formatNumber, titleCase } from "@/lib/format";
import { useAsync } from "@/lib/hooks";
import type { SimulationRunDetail } from "@/lib/types";

const LEVEL_TONE: Record<string, string> = {
  failed: "border-coral/40 bg-coral/10 text-coral",
  degraded: "border-amber/40 bg-amber/10 text-amber",
  affected: "border-accent/40 bg-accent/10 text-accent",
};

export default function SimulationResultPage() {
  const params = useParams<{ id: string }>();
  const id = Number(params.id);
  const { can } = useAuth();
  const [deriving, setDeriving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = useAsync<SimulationRunDetail>(() => api.get(`/simulations/${id}`), [id]);
  const data = run.data;

  function exportCsv() {
    if (!data) return;
    const header = ["code", "name", "category", "impact_level", "depth", "impact_score", "capacity_loss_percent", "affected_population", "explanation"];
    const lines = data.impacts.map((impact) =>
      [
        impact.code,
        `"${impact.name.replace(/"/g, '""')}"`,
        impact.category,
        impact.impact_level,
        impact.depth,
        impact.impact_score.toFixed(3),
        impact.capacity_loss_percent.toFixed(1),
        impact.affected_population,
        `"${impact.explanation.replace(/"/g, '""')}"`,
      ].join(","),
    );
    const blob = new Blob([[header.join(","), ...lines].join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${data.code}-impacts.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  async function deriveDemand() {
    setDeriving(true);
    setError(null);
    try {
      const result = await api.get<{ demands: unknown[] }>(`/simulations/${id}/demands`);
      setNotice(`${result.demands.length} resource demands derived. Open AI Optimisation to build a recovery plan.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not derive demand.");
    } finally {
      setDeriving(false);
    }
  }

  if (run.loading && !data) {
    return <div className="grid place-items-center py-24"><Spinner label="Loading results…" /></div>;
  }

  if (!data) {
    return (
      <Alert tone="danger" title="Run not found">
        {run.error ?? "This simulation run does not exist."}
        <div className="mt-3">
          <Link href="/simulation" className="btn-secondary btn-sm">Back to lab</Link>
        </div>
      </Alert>
    );
  }

  const levelCounts = data.summary.cascade_category_breakdown;

  return (
    <>
      <div className="mb-4">
        <Link href="/simulation" className="inline-flex items-center gap-1.5 text-xs text-ink-400 hover:text-white">
          <ArrowLeft className="h-3.5 w-3.5" /> Simulation lab
        </Link>
      </div>

      <PageHeader
        eyebrow={`${data.code} · ${titleCase(data.failure_mode)}`}
        title={data.name}
        description={`Executed ${formatDateTime(data.started_at)} · threshold ${(data.cascade_threshold * 100).toFixed(0)}% · max depth ${data.max_depth} · seed ${data.random_seed}`}
        actions={
          <>
            <Button variant="secondary" onClick={exportCsv}>
              <Download className="h-4 w-4" aria-hidden /> Export impacts
            </Button>
            {can("optimization:run") ? (
              <Button onClick={deriveDemand} loading={deriving}>
                <Cpu className="h-4 w-4" aria-hidden /> Derive demand
              </Button>
            ) : null}
            {data.incident_id ? (
              <Link href={`/incidents/${data.incident_id}`} className="btn-primary">
                Open incident <ArrowUpRight className="h-4 w-4" />
              </Link>
            ) : null}
          </>
        }
      >
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <StatusPill status={data.status} />
          <Badge tone="danger">{data.summary.assets_failed} failed</Badge>
          <Badge tone="warning">{data.summary.assets_degraded} degraded</Badge>
          <Badge tone="accent">{data.summary.assets_affected} affected</Badge>
          <Badge>{formatNumber(data.summary.affected_population)} residents</Badge>
          <Badge>depth {data.summary.max_depth_reached}</Badge>
        </div>
      </PageHeader>

      {notice ? <Alert tone="success">{notice}</Alert> : null}
      {error ? <Alert tone="danger">{error}</Alert> : null}

      <div className="grid gap-4 xl:grid-cols-[1fr_340px]">
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {[
              { label: "Severity index", value: `${data.summary.severity_index.toFixed(0)}/100`, tone: "coral" },
              { label: "Assets impacted", value: `${data.summary.assets_impacted}/${data.summary.assets_total}`, tone: "accent" },
              { label: "Engine time", value: `${data.duration_ms ?? 0} ms`, tone: "mint" },
              { label: "Snapshot", value: data.snapshot_hash.slice(0, 10), tone: "amber" },
            ].map((tile) => (
              <div key={tile.label} className="glass p-4">
                <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-ink-500">{tile.label}</p>
                <p className="mt-1 font-display text-xl font-semibold text-white">{tile.value}</p>
              </div>
            ))}
          </div>

          <Panel>
            <PanelHeader title="Severity" subtitle="Composite of failures, depth and population" icon={<TriangleAlert className="h-4 w-4" />} />
            <ProgressBar
              value={data.summary.severity_index}
              tone={data.summary.severity_index > 60 ? "coral" : data.summary.severity_index > 35 ? "amber" : "mint"}
              label="Severity index"
            />
            <div className="mt-3 flex flex-wrap gap-2">
              {data.summary.critical_services_down.map((service) => (
                <Badge key={service} tone="danger">
                  <ShieldAlert className="h-3 w-3" /> {service}
                </Badge>
              ))}
            </div>
          </Panel>

          <Panel>
            <PanelHeader
              title="Impact table"
              subtitle={`${data.impacts.length} impacted assets with explanations`}
              icon={<ListTree className="h-4 w-4" />}
            />
            <DataTable
              rows={data.impacts}
              getKey={(impact) => impact.asset_id}
              empty={<p className="py-8 text-center text-sm text-ink-400">No assets were impacted by this scenario.</p>}
              columns={[
                {
                  key: "asset",
                  header: "Asset",
                  render: (impact) => (
                    <div>
                      <Link href={`/infrastructure/${impact.asset_id}`} className="text-xs font-medium text-white hover:text-accent">
                        {impact.name}
                      </Link>
                      <p className="font-mono text-[10px] text-ink-500">
                        {impact.code} · {titleCase(impact.category)}
                      </p>
                    </div>
                  ),
                },
                {
                  key: "level",
                  header: "Impact",
                  render: (impact) => (
                    <span className={`badge border ${LEVEL_TONE[impact.impact_level] ?? ""}`}>{impact.impact_level}</span>
                  ),
                },
                { key: "depth", header: "Depth", render: (impact) => <span className="text-xs text-ink-300">{impact.depth}</span> },
                {
                  key: "score",
                  header: "Score",
                  render: (impact) => <span className="text-xs text-ink-300">{impact.impact_score.toFixed(2)}</span>,
                },
                {
                  key: "loss",
                  header: "Capacity loss",
                  render: (impact) => <span className="text-xs text-ink-300">{impact.capacity_loss_percent.toFixed(0)}%</span>,
                },
                {
                  key: "people",
                  header: "Residents",
                  render: (impact) => <span className="text-xs text-ink-300">{formatNumber(impact.affected_population)}</span>,
                },
                {
                  key: "why",
                  header: "Explanation",
                  render: (impact) => (
                    <span className="block max-w-xs text-[11px] leading-relaxed text-ink-500">{impact.explanation}</span>
                  ),
                },
              ]}
            />
          </Panel>

          <Panel>
            <PanelHeader title="Timeline" subtitle="Cascade order by hop" icon={<Layers className="h-4 w-4" />} />
            <ol className="space-y-2">
              {data.timeline.map((row, index) => (
                <li key={`${row.depth}-${row.asset_id}-${index}`} className="flex items-start gap-3 rounded-lg bg-white/[0.02] px-3 py-2">
                  <span className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full border border-white/10 text-[10px] text-ink-300">
                    {row.depth}
                  </span>
                  <div>
                    <p className="text-xs text-white">
                      <span className="font-mono text-[10px] text-ink-500">{row.code}</span> {row.level}
                    </p>
                    <p className="text-[11px] text-ink-500">{row.reason}</p>
                  </div>
                  <span className="ml-auto text-[10px] text-ink-500">{formatNumber(row.affected_population)}</span>
                </li>
              ))}
            </ol>
          </Panel>
        </div>

        <div className="space-y-4">
          <Panel>
            <PanelHeader title="Impact mix" subtitle="Assets by level" />
            <StatusDonut
              data={[
                { name: "Failed", value: data.summary.assets_failed, color: "#ff6b6b" },
                { name: "Degraded", value: data.summary.assets_degraded, color: "#ffb545" },
                { name: "Affected", value: data.summary.assets_affected, color: "#45d8f5" },
              ]}
              label="impacted"
              height={190}
            />
          </Panel>

          <Panel>
            <PanelHeader title="By category" subtitle="Failures per asset class" />
            <ComparisonBarChart
              data={Object.entries(levelCounts).map(([category, count]) => ({
                category: titleCase(category).replace(/ .*/, ""),
                count,
              }))}
              xKey="category"
              bars={[{ key: "count", label: "Assets", color: "#45d8f5" }]}
              height={200}
              summary={Object.entries(levelCounts)
                .map(([category, count]) => `${category}: ${count}`)
                .join(", ")}
            />
          </Panel>

          <Panel>
            <PanelHeader title="Initial failures" subtitle="Seeds of this cascade" />
            <ul className="space-y-1.5">
              {data.initial_failure_ids.map((assetId) => {
                const impact = data.impacts.find((row) => row.asset_id === assetId);
                return (
                  <li key={assetId} className="flex items-center justify-between text-xs">
                    <Link href={`/infrastructure/${assetId}`} className="text-ink-200 hover:text-accent">
                      {impact ? `${impact.code} · ${impact.name}` : `asset #${assetId}`}
                    </Link>
                    <SeverityBadge severity={impact?.impact_level === "failed" ? "critical" : "medium"} />
                  </li>
                );
              })}
            </ul>
          </Panel>

          {data.graph_warnings.length ? (
            <Panel>
              <PanelHeader title="Graph warnings" subtitle="Data quality notes" />
              <ul className="space-y-1.5 text-[11px] text-amber">
                {data.graph_warnings.map((warning) => (
                  <li key={warning}>• {warning}</li>
                ))}
              </ul>
            </Panel>
          ) : null}

          <Panel>
            <PanelHeader title="Assumptions" subtitle="How to read these numbers" />
            <ul className="space-y-2 text-[11px] leading-relaxed text-ink-400">
              {data.assumptions.map((line) => (
                <li key={line} className="flex gap-1.5">
                  <Check className="mt-0.5 h-3 w-3 shrink-0 text-mint" />
                  {line}
                </li>
              ))}
            </ul>
          </Panel>
        </div>
      </div>
    </>
  );
}
