"use client";

/**
 * Screen 06 — Interactive 3D City digital twin.
 * Screen 08 — infrastructure details sit in the side panel and on /infrastructure/[id].
 */

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Activity,
  AlertTriangle,
  ArrowUpRight,
  Cpu,
  Flame,
  History,
  Layers,
  Network,
  Play,
  Share2,
  ShieldAlert,
} from "lucide-react";
import { ZoneSummary } from "@/components/city-twin";
import { TwinView } from "@/components/city3d/twin-view";
import { HeatmapPanel } from "@/components/city3d/heatmap-panel";
import { ReplayPanel } from "@/components/city3d/replay-panel";
import { TimelinePanel, presentFrame, timelineOverlay } from "@/components/city3d/timeline-panel";
import { LensPanel, type LensMode } from "@/components/city3d/lens-panel";
import { frameAt, statusSteps } from "@/lib/timeline";
import type { City3DOverlay } from "@/components/city3d/city-3d";
import {
  Alert,
  Badge,
  Button,
  Panel,
  PanelHeader,
  PageHeader,
  ProgressBar,
  Select,
  StatusPill,
} from "@/components/ui";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatNumber, percent } from "@/lib/format";
import { useAsync } from "@/lib/hooks";
import type {
  CriticalityIndex,
  Heatmap,
  InvestmentPlan,
  Timeline,
  ListResponse,
  SimulationRun,
  SimulationRunDetail,
  TwinGraph,
  TwinNode,
} from "@/lib/types";

const LEGEND_FILTERS = [
  { value: "all", label: "All statuses" },
  { value: "operational", label: "Operational only" },
  { value: "degraded", label: "Degraded only" },
  { value: "offline", label: "Offline only" },
  { value: "maintenance", label: "In maintenance" },
];

export default function TwinPage() {
  const { can } = useAuth();
  const router = useRouter();
  const [selected, setSelected] = useState<TwinNode | null>(null);
  const [statusFilter, setStatusFilter] = useState("all");
  const [showEdges, setShowEdges] = useState(true);
  const [showZones, setShowZones] = useState(true);
  const [reducedMotion, setReducedMotion] = useState(false);
  const [heatOn, setHeatOn] = useState(false);
  const [heatZone, setHeatZone] = useState<string | null>(null);
  const [lens, setLens] = useState<LensMode>("off");
  const [replayRunId, setReplayRunId] = useState<number | null>(null);
  const [replayLevels, setReplayLevels] = useState<Map<number, "failed" | "degraded" | "affected">>(new Map());
  const [timelineIndex, setTimelineIndex] = useState<number | null>(null);
  const { data, loading, error, reload } = useAsync<TwinGraph>(() => api.get("/twin/graph"), []);

  // Overlay data is fetched separately from the twin itself: if either analytical
  // layer fails, the city still draws and the failure is reported where it
  // belongs instead of blanking the screen.
  const heatmap = useAsync<Heatmap>(() => api.get("/resilience/heatmap"), []);
  const runs = useAsync<SimulationRun[]>(async () => {
    const response: ListResponse<SimulationRun> = await api.list("/simulations?page_size=20");
    return response.data;
  }, []);
  const criticality = useAsync<CriticalityIndex>(() => api.get("/resilience/criticality"), []);
  const investment = useAsync<InvestmentPlan>(() => api.get("/resilience/investment"), []);
  const timeline = useAsync<Timeline>(() => api.get("/resilience/timetravel"), []);
  const replayDetail = useAsync<SimulationRunDetail>(
    () => (replayRunId ? api.get(`/simulations/${replayRunId}`) : Promise.resolve(null as unknown as SimulationRunDetail)),
    [replayRunId],
  );

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReducedMotion(query.matches);
    const handler = (event: MediaQueryListEvent) => setReducedMotion(event.matches);
    query.addEventListener("change", handler);
    return () => query.removeEventListener("change", handler);
  }, []);

  const overlay = useMemo<City3DOverlay>(() => {
    const result: City3DOverlay = {};
    if (replayLevels.size > 0) {
      result.impacts = [...replayLevels].map(([assetId, level]) => ({
        asset_id: assetId,
        impact_level: level,
      })) as City3DOverlay["impacts"];
    }
    if (heatOn && heatmap.data) {
      result.heat = new Map(
        heatmap.data.zones.map((zone) => [zone.code, { score: zone.risk_score, band: zone.risk_band }]),
      );
    }
    // The analytical lens: one number per asset, from whichever ranking is on.
    if (lens === "criticality" && criticality.data) {
      result.intensity = new Map(
        criticality.data.ranking.map((row) => [
          row.asset_id,
          { value: row.criticality_index, emphasis: row.criticality_index >= 70 },
        ]),
      );
    } else if (lens === "investment" && investment.data) {
      const max = investment.data.options.reduce(
        (best, option) => Math.max(best, option.benefit.population_protected),
        1,
      );
      const byAsset = new Map<number, { value: number; emphasis?: boolean }>();
      for (const option of investment.data.options) {
        if (!option.changes_anything) continue;
        // Several interventions can target one asset; the strongest reading wins,
        // because that is the one worth acting on.
        const value = (option.benefit.population_protected / max) * 100;
        const existing = byAsset.get(option.asset_id);
        if (!existing || value > existing.value) {
          byAsset.set(option.asset_id, { value, emphasis: value >= 70 });
        }
      }
      result.intensity = byAsset;
    }

    // Timeline overrides are additive: they describe the past, so they coexist
    // with a replay or a heat layer rather than replacing it.
    if (timeline.data && timelineIndex !== null) {
      const frame = frameAt(timeline.data, data?.nodes ?? [], timelineIndex);
      const overrides = timelineOverlay(frame, data?.nodes ?? []);
      result.impacts = [...(result.impacts ?? []), ...(overrides as NonNullable<City3DOverlay["impacts"]>)];
      result.recovering = [...frame.maintenance];
    }
    return result;
  }, [replayLevels, heatOn, heatmap.data, timeline.data, timelineIndex, data, lens, criticality.data, investment.data]);

  // Stable identity: the replay panel pushes a frame per animation tick, and a new
  // callback each render would re-run its effect on every frame.
  const handleReplayFrame = useCallback(
    (levels: Map<number, "failed" | "degraded" | "affected">) => setReplayLevels(levels),
    [],
  );

  const timelineFrame = useMemo(
    () =>
      timelineIndex === null
        ? presentFrame(timeline.data, data?.nodes ?? [])
        : frameAt(timeline.data, data?.nodes ?? [], timelineIndex),
    [timelineIndex, timeline.data, data],
  );

  const graph = useMemo(() => {
    if (!data) return null;
    if (statusFilter === "all") return data;
    return { ...data, nodes: data.nodes.filter((node) => node.status === statusFilter) };
  }, [data, statusFilter]);

  const stats = data?.stats;
  const criticalNodes = useMemo(
    () => (data?.nodes ?? []).filter((node) => node.criticality <= 2),
    [data],
  );
  const offline = (data?.nodes ?? []).filter((node) => node.status === "offline");

  return (
    <>
      <PageHeader
        eyebrow="Digital twin"
        title="Interactive city"
        description="A living 3D model of Aurora Vale: five zones, every registered asset and every modelled dependency, with traffic on the avenues. Rotate, zoom and select a building to inspect what it depends on, then launch a simulation from the failure lab."
        actions={
          <>
            <Button variant="secondary" onClick={reload}>
              <Share2 className="h-4 w-4" aria-hidden /> Refresh twin
            </Button>
            {can("simulation:run") ? (
              <Button onClick={() => router.push("/simulation")}>
                <Play className="h-4 w-4" aria-hidden /> Open failure lab
              </Button>
            ) : null}
          </>
        }
      >
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Badge tone="success">
            <Activity className="h-3 w-3" /> {stats?.by_status.operational ?? 0} operational
          </Badge>
          <Badge tone="warning">{stats?.by_status.degraded ?? 0} degraded</Badge>
          <Badge tone="danger">{stats?.by_status.offline ?? 0} offline</Badge>
          <Badge>{stats?.edges ?? 0} dependency links</Badge>
        </div>
      </PageHeader>

      {error ? (
        <Alert tone="danger" title="The twin could not be loaded">
          {error}
        </Alert>
      ) : null}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
        {/* min-w-0: a grid child defaults to min-width:auto, so the canvas would
            otherwise be able to push the column past the viewport. */}
        <div className="min-w-0 space-y-4">
          <Panel className="p-3 sm:p-4">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Select
                  value={statusFilter}
                  onChange={(event) => setStatusFilter(event.target.value)}
                  aria-label="Filter twin by status"
                  className="py-1.5 text-xs"
                >
                  {LEGEND_FILTERS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </Select>
                <Button
                  variant={showEdges ? "secondary" : "ghost"}
                  size="sm"
                  onClick={() => setShowEdges((v) => !v)}
                  aria-pressed={showEdges}
                >
                  <Network className="h-3.5 w-3.5" aria-hidden /> {showEdges ? "Dependencies on" : "Dependencies off"}
                </Button>
                <Button
                  variant={showZones ? "secondary" : "ghost"}
                  size="sm"
                  onClick={() => setShowZones((v) => !v)}
                  aria-pressed={showZones}
                >
                  <Layers className="h-3.5 w-3.5" aria-hidden /> {showZones ? "Zones on" : "Zones off"}
                </Button>
              </div>
              <p className="text-[11px] text-ink-500">Synthetic layout · assets placed from the twin graph, roads routed around their plots</p>
            </div>
            <TwinView
              graph={graph}
              loading={loading}
              error={error}
              overlay={overlay}
              selectedId={selected?.id ?? null}
              onSelect={setSelected}
              showEdges={showEdges}
              showZones={showZones}
              selectedZone={heatZone}
              height={560}
            />
          </Panel>

          <div className="grid gap-4 sm:grid-cols-2">
            <Panel>
              <PanelHeader title="Critical services" subtitle="Priority 1–2 assets in the model" icon={<AlertTriangle className="h-4 w-4" />} />
              <ul className="space-y-2">
                {criticalNodes.slice(0, 6).map((node) => (
                  <li key={node.id}>
                    <button
                      onClick={() => setSelected(node)}
                      className="flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition hover:bg-white/5"
                    >
                      <span className="truncate text-ink-200">
                        <span className="font-mono text-[10px] text-ink-500">{node.code}</span> {node.name}
                      </span>
                      <StatusPill status={node.status} />
                    </button>
                  </li>
                ))}
              </ul>
            </Panel>
            <ZoneSummary zones={data?.zones ?? []} nodes={data?.nodes ?? []} />
          </div>
        </div>

        {/* details drawer-equivalent panel */}
        <div className="space-y-4">
          <Panel>
            <PanelHeader
              title={selected ? selected.name : "No asset selected"}
              subtitle={selected ? `${selected.zone ?? "Unzoned"} · ${selected.category.replace(/_/g, " ")}` : "Select an asset on the map or from the navigator."}
              icon={<Layers className="h-4 w-4" />}
            />
            {selected ? (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="font-mono text-xs text-ink-400">{selected.code}</span>
                  <StatusPill status={selected.status} />
                </div>
                <dl className="space-y-2 text-xs">
                  <div className="flex justify-between">
                    <dt className="text-ink-500">Criticality</dt>
                    <dd className="text-ink-100">Priority {selected.criticality}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-ink-500">Capacity</dt>
                    <dd className="text-ink-100">{formatNumber(selected.capacity, 0)}</dd>
                  </div>
                  <div>
                    <div className="mb-1 flex justify-between">
                      <dt className="text-ink-500">Load</dt>
                      <dd className="text-ink-100">{percent(selected.load_percent, 0)}</dd>
                    </div>
                    <ProgressBar
                      value={selected.load_percent}
                      tone={selected.load_percent > 85 ? "coral" : selected.load_percent > 65 ? "amber" : "mint"}
                      label={`${selected.name} load`}
                    />
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-ink-500">Active incidents</dt>
                    <dd className={selected.active_incidents ? "text-amber" : "text-ink-100"}>
                      {selected.active_incidents}
                    </dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-ink-500">Dependencies</dt>
                    <dd className="text-ink-100">
                      {data?.edges.filter((edge) => edge.target === selected.id).length ?? 0} in ·{" "}
                      {data?.edges.filter((edge) => edge.source === selected.id).length ?? 0} out
                    </dd>
                  </div>
                </dl>
                <div className="space-y-1.5">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-500">
                    Depends on
                  </p>
                  {data?.edges
                    .filter((edge) => edge.target === selected.id)
                    .map((edge) => {
                      const source = data.nodes.find((node) => node.id === edge.source);
                      return (
                        <p key={edge.id} className="rounded-lg bg-white/[0.03] px-2 py-1 text-[11px] text-ink-300">
                          {source?.code} · weight {edge.impact_weight.toFixed(2)} · redundancy{" "}
                          {edge.redundancy.toFixed(2)}
                        </p>
                      );
                    })}
                  {!data?.edges.some((edge) => edge.target === selected.id) ? (
                    <p className="text-[11px] text-ink-500">No upstream dependencies recorded.</p>
                  ) : null}
                </div>
                <div className="flex flex-wrap gap-2 pt-1">
                  <Link href={`/infrastructure/${selected.id}`} className="btn-secondary btn-sm">
                    Full details <ArrowUpRight className="h-3 w-3" />
                  </Link>
                  {can("simulation:run") ? (
                    <Link href={`/simulation?asset=${selected.id}`} className="btn-primary btn-sm">
                      <Cpu className="h-3 w-3" /> Simulate failure
                    </Link>
                  ) : null}
                </div>
              </div>
            ) : (
              <p className="text-sm text-ink-400">
                Pick a node on the map. Each node shows status colour, load height and an amber marker when an
                incident is open.
              </p>
            )}
          </Panel>

          <Panel>
            <PanelHeader
              title="Resilience lens"
              subtitle="Criticality and investment, drawn on the city"
              icon={<ShieldAlert className="h-4 w-4" />}
            />
            <LensPanel
              criticality={criticality.data}
              investment={investment.data}
              loading={criticality.loading && investment.loading}
              error={criticality.error ?? investment.error}
              mode={lens}
              onMode={setLens}
              onSelectAsset={(id) => {
                const node = data?.nodes.find((candidate) => candidate.id === id) ?? null;
                setSelected(node);
              }}
            />
          </Panel>

          <Panel>
            <PanelHeader
              title="Exposure heatmap"
              subtitle="Zone risk from the latest simulated run"
              icon={<Flame className="h-4 w-4" />}
            />
            <HeatmapPanel
              heatmap={heatmap.data}
              loading={heatmap.loading}
              error={heatmap.error}
              enabled={heatOn}
              onEnable={setHeatOn}
              selectedZone={heatZone}
              onSelectZone={setHeatZone}
            />
          </Panel>

          <Panel>
            <PanelHeader
              title="Time travel"
              subtitle="Rewind the twin through its recorded history"
              icon={<History className="h-4 w-4" />}
            />
            <TimelinePanel
              timeline={timeline.data}
              nodes={data?.nodes ?? []}
              loading={timeline.loading}
              error={timeline.error}
              frame={timelineFrame}
              onScrub={setTimelineIndex}
              onReset={() => setTimelineIndex(null)}
              onSelectAsset={(id) => {
                const node = data?.nodes.find((candidate) => candidate.id === id) ?? null;
                setSelected(node);
              }}
            />
          </Panel>

          <Panel>
            <PanelHeader
              title="Replay a cascade"
              subtitle="Stored simulation results, played over the live map"
              icon={<History className="h-4 w-4" />}
            />
            <ReplayPanel
              runs={runs.data ?? []}
              selectedRunId={replayRunId}
              onSelectRun={setReplayRunId}
              detail={replayDetail.data ?? null}
              loading={runs.loading || replayDetail.loading}
              error={runs.error ?? replayDetail.error}
              reducedMotion={reducedMotion}
              onFrame={handleReplayFrame}
            />
          </Panel>

          <Panel>
            <PanelHeader title="Failure propagation" subtitle="How impact is modelled" icon={<Network className="h-4 w-4" />} />
            <p className="text-xs leading-relaxed text-ink-400">
              Edges point from supplier to dependent. When a supplier fails, the dependent&apos;s supply deficit is
              combined multiplicatively across its feeds and compared with the cascade threshold (default 35%). Assets
              above 60% of the threshold are marked degraded rather than failed.
            </p>
            <div className="mt-3 space-y-2">
              {[
                { label: "Failed", tone: "coral" as const, body: "Deficit exceeded the threshold — asset is down." },
                { label: "Degraded", tone: "amber" as const, body: "Residual capacity only; still partly operating." },
                { label: "Affected", tone: "accent" as const, body: "Dependent but within its redundancy envelope." },
              ].map((row) => (
                <div key={row.label} className="flex items-start gap-2 text-[11px]">
                  <Badge tone={row.tone === "coral" ? "danger" : row.tone === "amber" ? "warning" : "accent"}>
                    {row.label}
                  </Badge>
                  <span className="text-ink-400">{row.body}</span>
                </div>
              ))}
            </div>
            {offline.length > 0 ? (
              <Alert tone="warning" title={`${offline.length} asset(s) currently offline`} >
                Status changes made here propagate to dependent assets, so the twin always reflects operational truth.
              </Alert>
            ) : null}
          </Panel>
        </div>
      </div>
    </>
  );
}
