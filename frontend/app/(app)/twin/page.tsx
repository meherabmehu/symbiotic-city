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
  Flame,
  GitCompare,
  History,
  Network,
  Play,
  Share2,
  ShieldAlert,
} from "lucide-react";
import { ZoneSummary } from "@/components/city-twin";
import { TwinView } from "@/components/city3d/twin-view";
import { TwinMetricsRow, type IncidentSummary } from "@/components/city3d/twin-metrics";
import { HeatmapPanel } from "@/components/city3d/heatmap-panel";
import { ReplayPanel } from "@/components/city3d/replay-panel";
import { TimelinePanel, presentFrame, timelineOverlay } from "@/components/city3d/timeline-panel";
import { LensPanel, type LensMode } from "@/components/city3d/lens-panel";
import { RunComparePanel } from "@/components/city3d/run-compare-panel";
import { frameAt } from "@/lib/timeline";
import type { City3DOverlay } from "@/components/city3d/city-3d";
import {
  Alert,
  Badge,
  Button,
  Panel,
  PanelHeader,
  PageHeader,
  StatusPill,
} from "@/components/ui";
import { api, qs } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useAsync } from "@/lib/hooks";
import type {
  AssetDetail,
  CriticalityIndex,
  Heatmap,
  Incident,
  InvestmentPlan,
  Timeline,
  ListResponse,
  SimulationRun,
  SimulationRunDetail,
  TwinGraph,
  TwinNode,
} from "@/lib/types";

export default function TwinPage() {
  const { can } = useAuth();
  const router = useRouter();
  const [selected, setSelected] = useState<TwinNode | null>(null);
  const [reducedMotion, setReducedMotion] = useState(false);
  const [heatOn, setHeatOn] = useState(false);
  const [heatZone, setHeatZone] = useState<string | null>(null);
  const [lens, setLens] = useState<LensMode>("off");
  const [replayRunId, setReplayRunId] = useState<number | null>(null);
  const [compareAId, setCompareAId] = useState<number | null>(null);
  const [compareBId, setCompareBId] = useState<number | null>(null);
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

  const compareA = useAsync<SimulationRunDetail>(
    () => (compareAId ? api.get(`/simulations/${compareAId}`) : Promise.resolve(null as unknown as SimulationRunDetail)),
    [compareAId],
  );
  const compareB = useAsync<SimulationRunDetail>(
    () => (compareBId ? api.get(`/simulations/${compareBId}`) : Promise.resolve(null as unknown as SimulationRunDetail)),
    [compareBId],
  );

  const overlay = useMemo<City3DOverlay>(() => {
    const result: City3DOverlay = {};
    // A replay is a recorded run, so it is "historical" even though it plays in the
    // present tense: the assets are today's, the cascade is not.
    if (replayRunId != null) result.scenario = "historical";

    // Timeline frames are maintenance overrides built from the API's own history.
    if (timeline.data && timelineIndex !== null && replayRunId == null) result.scenario = "historical";

    if (replayLevels.size > 0) {
      // The cascade is drawn from whichever assets the run started at. A run can
      // fail several at once; the first is the origin the rings expand from.
      result.originId = replayDetail.data?.initial_failure_ids?.[0] ?? null;
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

    // A/B comparison. Only the *differences* are drawn, because the point of the
    // comparison is where the two runs part company -- painting the whole of B
    // would make the two runs look like one run and hide the answer.
    if (
      compareAId != null &&
      compareBId != null &&
      compareA.data &&
      compareB.data &&
      replayLevels.size === 0
    ) {
      const left = new Map(compareA.data.impacts.map((impact) => [impact.asset_id, impact.impact_level]));
      const right = new Map(compareB.data.impacts.map((impact) => [impact.asset_id, impact.impact_level]));
      const differing: NonNullable<City3DOverlay["impacts"]> = [];
      for (const [assetId, level] of right) {
        if (left.get(assetId) !== level) {
          differing.push({
            asset_id: assetId,
            impact_level: level,
            code: "",
            name: "",
            category: "",
            depth: 0,
            impact_score: 0,
            capacity_loss_percent: 0,
            affected_population: 0,
            cause_asset_id: null,
            explanation: "",
          });
        }
      }
      for (const [assetId, level] of left) {
        if (!right.has(assetId)) {
          // A breaks it and B does not: drawn as recovered-in-B rather than as a
          // failure, so the eye reads it as an improvement rather than a loss.
          differing.push({
            asset_id: assetId,
            impact_level: level,
            code: "",
            name: "",
            category: "",
            depth: 0,
            impact_score: 0,
            capacity_loss_percent: 0,
            affected_population: 0,
            cause_asset_id: null,
            explanation: "",
          });
        }
      }
      result.impacts = differing;
      result.scenario = "hypothetical";
      result.originId = compareB.data.initial_failure_ids?.[0] ?? null;
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
  }, [
    replayLevels,
    replayRunId,
    replayDetail.data,
    compareAId,
    compareBId,
    compareA.data,
    compareB.data,
    heatOn,
    heatmap.data,
    timeline.data,
    timelineIndex,
    data,
    lens,
    criticality.data,
    investment.data,
  ]);

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

  /**
   * Incidents for the selected asset.
   *
   * Fetched separately rather than counted from `active_incidents`, because the
   * count tells you something is wrong and the list tells you what. Both can
   * disagree for a moment while this loads, and the panel says so rather than
   * showing an empty list that reads as "nothing is wrong".
   */
  const assetIncidents = useAsync<Incident[]>(
    async (signal) =>
      selected
        ? (await api.list<Incident>(`/incidents${qs({ asset_id: selected.id, page_size: 8 })}`, { signal })).data
        : [],
    [selected?.id],
  );

  // The metric cards read their own endpoints: the incident summary and the
  // 24h intake for the incidents card, the asset register for the dossier.
  // Each fails independently -- a card that cannot load says so rather than
  // taking the viewport down with it.
  const incidentSummary = useAsync<IncidentSummary>(() => api.get("/incidents/summary"), []);
  const recentIncidents = useAsync<Incident[]>(
    async () => (await api.list<Incident>("/incidents?page_size=50&sort=reported_at&direction=desc")).data,
    [],
  );
  const assetDetail = useAsync<AssetDetail>(
    () =>
      selected
        ? api.get(`/infrastructure/${selected.id}`)
        : Promise.resolve(null as unknown as AssetDetail),
    [selected?.id],
  );

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
        title="Interactive 3D City"
        description="Real-time digital twin of Aurora Vale — monitor, analyse and orchestrate a self-healing city."
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

      {/* The viewport owns the top of the screen the way the reference
          dashboard composes it: control bar, stats strip, the city itself, and
          the metric cards directly beneath. Everything below is analysis. */}
      <TwinView
        graph={data}
        loading={loading}
        error={error}
        overlay={overlay}
        selectedId={selected?.id ?? null}
        onSelect={setSelected}
        selectedZone={heatZone}
        activeIncidents={(data?.nodes ?? []).reduce((sum, node) => sum + (node.active_incidents ?? 0), 0)}
        height={600}
        belowCanvas={
          <TwinMetricsRow
            graph={data}
            criticality={criticality.data}
            criticalityLoading={criticality.loading}
            criticalityError={criticality.error}
            heatmap={heatmap.data}
            heatmapLoading={heatmap.loading}
            heatmapError={heatmap.error}
            incidentSummary={incidentSummary.data}
            incidentSummaryError={incidentSummary.error}
            recentIncidents={recentIncidents.data}
            selected={selected}
            onSelect={setSelected}
            detail={assetDetail.data && assetDetail.data.id === selected?.id ? assetDetail.data : null}
            detailLoading={assetDetail.loading}
            detailError={assetDetail.error}
            selectedIncidents={assetIncidents.data ?? []}
            selectedIncidentsLoading={assetIncidents.loading}
          />
        }
      />

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
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
              title="Compare two runs"
              subtitle="Where two stored simulations part company"
              icon={<GitCompare className="h-4 w-4" />}
            />
            <RunComparePanel
              runs={runs.data ?? []}
              aId={compareAId}
              bId={compareBId}
              onSelectA={setCompareAId}
              onSelectB={setCompareBId}
              a={compareA.data ?? null}
              b={compareB.data ?? null}
              loading={compareA.loading || compareB.loading}
              error={compareA.error ?? compareB.error}
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
    </>
  );
}
