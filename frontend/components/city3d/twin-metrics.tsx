"use client";

/**
 * The metric cards beneath the 3D viewport: status census, city criticality,
 * active incidents, population impact, and the selected-asset dossier.
 *
 * Every number here is read from the API -- the twin graph, the criticality
 * index, the exposure heatmap, the incident summary, and the asset record
 * itself. Where a source has not loaded (or a role cannot read it) the card
 * says so instead of showing a zero that would read as "nothing is wrong".
 * The layout follows the reference dashboard's bottom row; the data does not.
 */

import Link from "next/link";
import {
  AlertTriangle,
  ArrowUpRight,
  Cpu,
  Layers,
  ShieldAlert,
  TriangleAlert,
  Users,
} from "lucide-react";
import { Panel, ProgressBar, StatusPill, Button } from "@/components/ui";
import { STATUS_STYLES, type VisualStatus } from "@/lib/city-model";
import { criticalityStats } from "@/lib/criticality";
import { formatNumber, percent } from "@/lib/format";
import { useAuth } from "@/lib/auth";
import type {
  AssetDetail,
  CriticalityIndex,
  Heatmap,
  Incident,
  TwinGraph,
  TwinNode,
} from "@/lib/types";

export interface IncidentSummary {
  counts: Record<string, number>;
  active: number;
  total: number;
}

export interface TwinMetricsProps {
  graph: TwinGraph | null;
  criticality: CriticalityIndex | null;
  criticalityLoading: boolean;
  criticalityError: string | null;
  heatmap: Heatmap | null;
  heatmapLoading: boolean;
  heatmapError: string | null;
  incidentSummary: IncidentSummary | null;
  incidentSummaryError: string | null;
  /** Most recent incidents, newest first -- used only for the 24h delta. */
  recentIncidents: Incident[] | null;
  selected: TwinNode | null;
  onSelect: (node: TwinNode | null) => void;
  /** The asset record fetch: unit, zone name, dependency redundancy, incidents. */
  detail: AssetDetail | null;
  detailLoading: boolean;
  detailError: string | null;
  selectedIncidents: Incident[];
  selectedIncidentsLoading: boolean;
}

const VISUAL_ORDER: VisualStatus[] = [
  "operational",
  "degraded",
  "failed",
  "maintenance",
  "recovering",
];

/** The shape that encodes a status, matching the 3D beacon above each building. */
function StatusMarkGlyph({ mark, color }: { mark: string; color: string }) {
  if (mark === "none") return null;
  if (mark === "cross") {
    return (
      <span aria-hidden style={{ color }} className="text-[10px] leading-none">
        ✕
      </span>
    );
  }
  if (mark === "bar") {
    return (
      <span aria-hidden style={{ color }} className="text-[10px] leading-none">
        ▬
      </span>
    );
  }
  if (mark === "half") {
    return (
      <span aria-hidden style={{ color }} className="text-[10px] leading-none">
        ◐
      </span>
    );
  }
  if (mark === "pulse") {
    return (
      <span aria-hidden style={{ color }} className="text-[10px] leading-none">
        ◉
      </span>
    );
  }
  return (
    <span aria-hidden style={{ color }} className="text-[10px] leading-none">
      ●
    </span>
  );
}

export function TwinMetricsRow({
  graph,
  criticality,
  criticalityLoading,
  criticalityError,
  heatmap,
  heatmapLoading,
  heatmapError,
  incidentSummary,
  incidentSummaryError,
  recentIncidents,
  selected,
  onSelect,
  detail,
  detailLoading,
  detailError,
  selectedIncidents,
  selectedIncidentsLoading,
}: TwinMetricsProps) {
  const nodes = graph?.nodes ?? [];
  const stats = criticalityStats(criticality);

  // Status census, straight from the graph the canvas draws.
  const counts: Record<string, number> = {};
  for (const node of nodes) {
    const visual: string = node.status === "offline" ? "failed" : node.status;
    counts[visual] = (counts[visual] ?? 0) + 1;
  }

  // Fallback for the incident card: if the summary endpoint is unreadable for
  // this session, the graph's own flagged-asset count still tells the truth.
  const flaggedAssets = nodes.filter((node) => node.active_incidents > 0).length;
  const activeFromGraph = nodes.reduce((sum, node) => sum + (node.active_incidents > 0 ? 1 : 0), 0);
  const activeIncidents = incidentSummary?.active ?? null;
  const newIn24h = (recentIncidents ?? []).filter(
    (incident) => Date.now() - new Date(incident.reported_at).getTime() < 24 * 60 * 60 * 1000,
  ).length;

  const totalPopulation = (graph?.zones ?? []).reduce((sum, zone) => sum + zone.population, 0);
  const atRisk = heatmap?.totals.population_at_risk ?? null;
  const heatmapSource =
    heatmap?.source === "baseline"
      ? "baseline"
      : heatmap?.source === "run"
        ? "stored run"
        : "latest run";

  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-12">
      {/* ---------------------------------------------------- status census */}
      <Panel className="sm:col-span-1 xl:col-span-3" data-testid="metrics-status">
        <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-ink-500">
          Status (assets)
        </p>
        <ul className="mt-3 space-y-2">
          {VISUAL_ORDER.map((key) => {
            const style = STATUS_STYLES[key];
            const count = counts[key] ?? 0;
            return (
              <li key={key} className="flex items-center justify-between gap-2 text-xs">
                <span className="flex items-center gap-2 text-ink-200">
                  <span className="inline-flex items-center gap-1">
                    <span
                      className="inline-block h-2.5 w-2.5 rounded-sm"
                      style={{ backgroundColor: style.color }}
                      aria-hidden
                    />
                    <StatusMarkGlyph mark={style.mark} color={style.color} />
                  </span>
                  {style.label}
                </span>
                <span className="font-mono text-ink-300">{formatNumber(count)}</span>
              </li>
            );
          })}
        </ul>
        <p className="mt-3 text-[10px] leading-snug text-ink-600">
          {nodes.length} assets in the graph. Each status carries a mark as well as a colour, so
          shape identifies it too.
        </p>
      </Panel>

      {/* ----------------------------------------------------- criticality */}
      <Panel className="xl:col-span-2" data-testid="metrics-criticality">
        <div className="flex items-center gap-2">
          <ShieldAlert className="h-4 w-4 text-accent" aria-hidden />
          <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-ink-500">
            City criticality
          </p>
        </div>
        {criticalityLoading ? (
          <p className="mt-4 text-xs text-ink-500" role="status">
            Loading criticality index…
          </p>
        ) : criticalityError ? (
          <p className="mt-4 text-xs text-coral" role="alert">
            Index unavailable: {criticalityError}
          </p>
        ) : criticality ? (
          <>
            <p className="mt-3 font-display text-3xl font-semibold text-white">
              {stats.mean.toFixed(1)}
            </p>
            <p className="mt-1 text-[11px] text-ink-400">
              mean criticality index (0–100) · {stats.scored} assets scored
            </p>
            <p className="mt-2 font-mono text-[10px] text-ink-600">
              range {stats.floor.toFixed(1)}–{stats.peak.toFixed(1)} · {criticality.fleet.critical_assets}{" "}
              critical services · {criticality.fleet.total_dependencies} links
            </p>
            <p className="mt-3 text-[10px] leading-snug text-ink-600">
              Dependency-aware consequence per asset, from the resilience service. Higher means the
              city loses more if that asset fails.
            </p>
          </>
        ) : (
          <p className="mt-4 text-xs text-ink-500">No criticality reading yet.</p>
        )}
      </Panel>

      {/* ------------------------------------------------------- incidents */}
      <Panel className="xl:col-span-2" data-testid="metrics-incidents">
        <div className="flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 text-amber" aria-hidden />
          <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-ink-500">
            Active incidents
          </p>
        </div>
        {incidentSummaryError && !incidentSummary ? (
          // Fall back to the graph's own view rather than an empty card.
          <>
            <p className="mt-3 font-display text-3xl font-semibold text-white">{activeFromGraph}</p>
            <p className="mt-1 text-[11px] text-ink-400">
              assets with an open incident (summary unreadable)
            </p>
          </>
        ) : !incidentSummary ? (
          <p className="mt-4 text-xs text-ink-500" role="status">
            Loading incident summary…
          </p>
        ) : (
          <>
            <p
              className={`mt-3 font-display text-3xl font-semibold ${
                incidentSummary.active > 0 ? "text-amber" : "text-mint"
              }`}
            >
              {incidentSummary.active}
            </p>
            <p className="mt-1 text-[11px] text-ink-400">
              open now · {incidentSummary.total} recorded in total
            </p>
          </>
        )}
        <p className="mt-2 text-[11px] text-ink-500">
          <span className={newIn24h > 0 ? "text-amber" : "text-ink-400"}>
            {newIn24h > 0 ? `▲ +${newIn24h}` : "± 0"} (24h)
          </span>{" "}
          · {flaggedAssets} asset{flaggedAssets === 1 ? "" : "s"} flagged
        </p>
        <p className="mt-3 text-[10px] leading-snug text-ink-600">
          Counted from the incident register; the twin graph flags the same incidents on the assets
          they touch.
        </p>
      </Panel>

      {/* ---------------------------------------------- population impact */}
      <Panel className="xl:col-span-2" data-testid="metrics-population">
        <div className="flex items-center gap-2">
          <Users className="h-4 w-4 text-accent" aria-hidden />
          <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-ink-500">
            Population impact
          </p>
        </div>
        {heatmapLoading ? (
          <p className="mt-4 text-xs text-ink-500" role="status">
            Loading exposure…
          </p>
        ) : heatmapError ? (
          <p className="mt-4 text-xs text-coral" role="alert">
            Exposure unavailable: {heatmapError}
          </p>
        ) : atRisk != null ? (
          <>
            <p className="mt-3 font-display text-3xl font-semibold text-white">
              {formatNumber(atRisk)}
            </p>
            <p className="mt-1 text-[11px] text-ink-400">
              {totalPopulation > 0
                ? `${percent((atRisk / totalPopulation) * 100, 1)} of ${formatNumber(totalPopulation)} residents`
                : "residents in exposed zones"}
            </p>
            <p className="mt-2 font-mono text-[10px] text-ink-600">
              exposure from {heatmapSource} · {heatmap?.totals.assets_failed ?? 0} failed ·{" "}
              {heatmap?.totals.assets_degraded ?? 0} degraded
            </p>
            <p className="mt-3 text-[10px] leading-snug text-ink-600">
              Zone risk summed from the exposure heatmap; not a live evacuation figure.
            </p>
          </>
        ) : (
          <p className="mt-4 text-xs text-ink-500">No exposure reading yet.</p>
        )}
      </Panel>

      {/* ------------------------------------------------- selected asset */}
      <SelectedAssetCard
        className="sm:col-span-2 xl:col-span-3"
        selected={selected}
        onSelect={onSelect}
        detail={detail}
        detailLoading={detailLoading}
        detailError={detailError}
        selectedIncidents={selectedIncidents}
        selectedIncidentsLoading={selectedIncidentsLoading}
        graph={graph}
      />
    </div>
  );
}

/* ---------------------------------------------------------- selected asset */

function SelectedAssetCard({
  className,
  selected,
  onSelect,
  detail,
  detailLoading,
  detailError,
  selectedIncidents,
  selectedIncidentsLoading,
  graph,
}: {
  className?: string;
  selected: TwinNode | null;
  onSelect: (node: TwinNode | null) => void;
  detail: AssetDetail | null;
  detailLoading: boolean;
  detailError: string | null;
  selectedIncidents: Incident[];
  selectedIncidentsLoading: boolean;
  graph: TwinGraph | null;
}) {
  const { can } = useAuth();
  const edges = graph?.edges ?? [];

  if (!selected) {
    return (
      <Panel className={className} data-testid="metrics-selected">
        <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-ink-500">
          Selected asset
        </p>
        <div className="mt-6 flex flex-col items-center gap-2 py-4 text-center">
          <Layers className="h-6 w-6 text-ink-600" aria-hidden />
          <p className="text-sm font-semibold text-ink-300">No asset selected</p>
          <p className="max-w-[280px] text-[11px] leading-relaxed text-ink-500">
            Click a building or a floating label on the map, or pick a chip from the navigator
            below. The dossier fills in with live register data.
          </p>
        </div>
      </Panel>
    );
  }

  const inbound = edges.filter((edge) => edge.target === selected.id);
  const outbound = edges.filter((edge) => edge.source === selected.id);
  const avgRedundancy =
    inbound.length > 0
      ? inbound.reduce((sum, edge) => sum + edge.redundancy, 0) / inbound.length
      : null;
  const openIncidents = selectedIncidents.filter((incident) => !incident.resolved_at);

  // The graph node is always available; the asset record enriches it with the
  // unit, the zone name and per-feed redundancy. Either alone is enough to
  // render, so a slow or failed detail fetch degrades instead of blanking.
  const typeLabel =
    detail?.category_label ?? selected.category.replace(/_/g, " ");
  const zoneLabel = detail?.zone?.name ?? selected.zone ?? "Unzoned";
  const capacityLabel = detail
    ? `${formatNumber(detail.capacity, 0)}${detail.capacity_unit ? ` ${detail.capacity_unit}` : ""}`
    : formatNumber(selected.capacity, 0);

  return (
    <Panel className={className} data-testid="metrics-selected">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-ink-500">
            Selected asset
          </p>
          <p className="mt-1 truncate text-sm font-semibold text-white" title={selected.name}>
            {selected.name}
          </p>
          <p className="font-mono text-[10px] text-ink-500">{selected.code}</p>
        </div>
        <StatusPill status={selected.status} />
      </div>

      {detailLoading ? (
        <p className="mt-3 text-[11px] text-ink-500" role="status">
          Loading asset record…
        </p>
      ) : detailError ? (
        <p className="mt-3 text-[11px] text-amber" role="alert">
          Register detail unavailable — showing graph values. {detailError}
        </p>
      ) : null}

      <dl className="mt-3 space-y-1.5 text-[11px]">
        <div className="flex justify-between gap-2">
          <dt className="text-ink-500">Type</dt>
          <dd className="text-ink-100">{typeLabel}</dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-ink-500">Zone</dt>
          <dd className="text-ink-100">{zoneLabel}</dd>
        </div>
        <div>
          <div className="flex justify-between gap-2">
            <dt className="text-ink-500">Load</dt>
            <dd className="text-ink-100">{percent(selected.load_percent, 0)}</dd>
          </div>
          <div className="mt-1">
            <ProgressBar
              value={selected.load_percent}
              tone={selected.load_percent > 85 ? "coral" : selected.load_percent > 65 ? "amber" : "mint"}
              label={`${selected.name} load`}
            />
          </div>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-ink-500">Capacity</dt>
          <dd className="text-ink-100">{capacityLabel}</dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-ink-500">Dependencies</dt>
          <dd className="text-ink-100">
            {inbound.length} in · {outbound.length} out
          </dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-ink-500">Redundancy</dt>
          <dd className="text-ink-100">
            {avgRedundancy == null
              ? "no recorded feeds"
              : `${inbound.length} feed${inbound.length === 1 ? "" : "s"} · ${percent(avgRedundancy * 100, 0)} mean`}
          </dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-ink-500">Criticality</dt>
          <dd className="text-ink-100">Priority {selected.criticality}</dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-ink-500">Incidents</dt>
          <dd className={selected.active_incidents ? "text-amber" : "text-ink-100"}>
            {selected.active_incidents} open
            {selectedIncidentsLoading ? " · loading…" : ""}
          </dd>
        </div>
      </dl>

      {openIncidents.length > 0 ? (
        <ul className="mt-2 space-y-1">
          {openIncidents.slice(0, 2).map((incident) => (
            <li key={incident.id}>
              <Link
                href={`/incidents/${incident.id}`}
                className="flex items-center justify-between gap-2 rounded-lg bg-amber/10 px-2 py-1 text-[10px] text-amber hover:bg-amber/15"
              >
                <span className="truncate">
                  <span className="font-mono opacity-80">{incident.code}</span> {incident.title}
                </span>
                <span className="shrink-0 uppercase opacity-80">{incident.severity}</span>
              </Link>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="mt-3 flex flex-wrap gap-2">
        <Link href={`/infrastructure/${selected.id}`} className="btn-secondary btn-sm">
          Full details <ArrowUpRight className="h-3 w-3" />
        </Link>
        {can("simulation:run") ? (
          <Link href={`/simulation?asset=${selected.id}`} className="btn-primary btn-sm">
            <Cpu className="h-3 w-3" /> Simulate
          </Link>
        ) : null}
        {can("incident:create") && selected.status !== "offline" ? (
          <Link href={`/incidents?asset=${selected.id}`} className="btn-secondary btn-sm">
            <TriangleAlert className="h-3 w-3" /> Report
          </Link>
        ) : null}
      </div>
      {!can("simulation:run") || !can("incident:create") ? (
        <p className="mt-2 text-[10px] leading-snug text-ink-600">
          {[
            !can("simulation:run") ? "simulating a failure" : null,
            !can("incident:create") ? "reporting an incident" : null,
          ]
            .filter(Boolean)
            .join(" and ")}{" "}
          {!can("simulation:run") && !can("incident:create") ? "require" : "requires"} a role your
          account does not have. Nothing here writes to the model.
        </p>
      ) : null}
      <button
        type="button"
        onClick={() => onSelect(null)}
        className="mt-2 text-[10px] text-ink-600 underline-offset-2 hover:text-ink-400 hover:underline"
      >
        Clear selection
      </button>
    </Panel>
  );
}
