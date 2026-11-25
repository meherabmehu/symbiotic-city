"use client";

/**
 * Resilience heatmap: which zone is most exposed, and why.
 *
 * The map colours are only half of this component. The other half is the table
 * below it, which carries the same reading in words and numbers -- because a
 * colour gradient on its own is not accessible, and because "the whole east side
 * is orange" is not an answer to "what should we do first".
 *
 * Every figure comes from `/resilience/heatmap`. The panel does not score
 * anything itself; if the backend has no run to score against, it says so.
 */

import { useMemo, useState } from "react";
import { Flame, Info } from "lucide-react";
import { Badge, Button, Select } from "@/components/ui";
import { formatNumber } from "@/lib/format";
import type { Heatmap } from "@/lib/types";

/** Band colours, taken from the backend's own legend ordering. */
const BAND_COLOURS: Record<string, string> = {
  low: "#3ee6a5",
  guarded: "#45b8f5",
  elevated: "#ffd166",
  high: "#fb923c",
  severe: "#ff6b6b",
};

export function bandColour(band: string): string {
  return BAND_COLOURS[band] ?? "#8aa0bb";
}

export interface HeatmapPanelProps {
  heatmap: Heatmap | null;
  loading?: boolean;
  error?: string | null;
  /** Called with the zone scores and the per-asset scores, for the 3D overlay. */
  onEnable?: (enabled: boolean) => void;
  enabled?: boolean;
  selectedZone?: string | null;
  onSelectZone?: (code: string | null) => void;
}

export function HeatmapPanel({
  heatmap,
  loading,
  error,
  enabled,
  onEnable,
  selectedZone,
  onSelectZone,
}: HeatmapPanelProps) {
  const [sortBy, setSortBy] = useState<"risk" | "population">("risk");

  const zones = useMemo(() => {
    const rows = [...(heatmap?.zones ?? [])];
    return rows.sort((a, b) =>
      sortBy === "risk" ? b.risk_score - a.risk_score : b.population_at_risk - a.population_at_risk,
    );
  }, [heatmap, sortBy]);

  if (loading) {
    return <p className="text-xs text-ink-500">Scoring zones…</p>;
  }

  if (error) {
    return (
      <p className="rounded-lg border border-coral/30 bg-coral/10 px-3 py-2 text-xs text-coral" role="alert">
        {error}
      </p>
    );
  }

  if (!heatmap || heatmap.zones.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-white/10 bg-white/[0.02] px-3 py-4 text-center">
        <p className="text-xs font-semibold text-white">No exposure scores yet</p>
        <p className="mt-1 text-[11px] leading-relaxed text-ink-500">
          The heatmap is built from a simulation run. Once one has completed, each zone is scored by
          the exposure of the assets inside it.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant={enabled ? "secondary" : "ghost"}
          size="sm"
          onClick={() => onEnable?.(!enabled)}
          aria-pressed={Boolean(enabled)}
        >
          <Flame className="h-3.5 w-3.5" aria-hidden /> {enabled ? "Overlay on" : "Show on map"}
        </Button>
        <Select
          value={sortBy}
          onChange={(event) => setSortBy(event.target.value as "risk" | "population")}
          aria-label="Sort zones by"
          className="py-1.5 text-xs"
        >
          <option value="risk">Most exposed first</option>
          <option value="population">Most people at risk first</option>
        </Select>
        <Badge tone="warning">
          <span data-testid="heatmap-at-risk">
            {formatNumber(heatmap.totals.population_at_risk, 0)} people at risk
          </span>
        </Badge>
      </div>

      {/* Legend. Each band shows its colour, its name and its threshold, so the
          scale is readable without hovering anything. */}
      <div>
        <p className="mb-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-ink-500">
          Exposure bands
        </p>
        <ul className="flex flex-wrap gap-1.5">
          {heatmap.legend.map((entry) => (
            <li
              key={entry.band}
              title={entry.description}
              className="inline-flex items-center gap-1.5 rounded-md border border-white/10 bg-white/[0.03] px-1.5 py-0.5 text-[10px] text-ink-300"
            >
              <span
                className="inline-block h-2 w-2 rounded-sm"
                style={{ backgroundColor: bandColour(entry.band) }}
                aria-hidden
              />
              {entry.label}
              <span className="text-ink-600">≥{entry.threshold}</span>
            </li>
          ))}
        </ul>
        <p className="mt-1 text-[10px] leading-snug text-ink-600">
          <Info className="mr-1 inline h-3 w-3" aria-hidden />
          {heatmap.source === "latest"
            ? "Scored from the most recent completed run."
            : `Scored from run ${heatmap.runs.code ?? "—"}.`}{" "}
          Impact weight {heatmap.model.impact_weight}, criticality weight{" "}
          {heatmap.model.criticality_weight}.
        </p>
      </div>

      <ul className="space-y-1.5">
        {zones.map((zone) => {
          const active = selectedZone === zone.code;
          return (
            <li key={zone.code}>
              <button
                onClick={() => onSelectZone?.(active ? null : zone.code)}
                aria-pressed={active}
                className={`w-full rounded-lg border px-2 py-1.5 text-left transition ${
                  active
                    ? "border-accent/40 bg-accent/10"
                    : "border-white/5 bg-white/[0.02] hover:border-white/15"
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="flex items-center gap-1.5 text-[11px] text-ink-200">
                    <span
                      className="inline-block h-2.5 w-2.5 rounded-sm"
                      style={{ backgroundColor: bandColour(zone.risk_band) }}
                      aria-hidden
                    />
                    {zone.name}
                    <span className="font-mono text-[10px] text-ink-500">{zone.code}</span>
                  </span>
                  <span className="text-[11px] tabular-nums text-ink-200">
                    {zone.risk_score.toFixed(0)}
                    <span className="text-[9px] text-ink-600">/100</span>
                  </span>
                </div>
                <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-ink-500">
                  <span>{zone.risk_band}</span>
                  <span>{zone.assets_failed} failed</span>
                  <span>{zone.assets_degraded} degraded</span>
                  <span>{formatNumber(zone.population_at_risk, 0)} at risk</span>
                </div>
                {active && zone.drivers.length > 0 ? (
                  <ul className="mt-1.5 space-y-0.5 border-t border-white/5 pt-1.5">
                    {zone.drivers.slice(0, 3).map((driver, index) => (
                      <li key={index} className="text-[10px] leading-snug text-ink-400">
                        · {driver}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
