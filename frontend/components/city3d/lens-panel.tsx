"use client";

import { criticalityStats } from "@/lib/criticality";

/**
 * Analytical lenses over the city: criticality, and what an investment would buy.
 *
 * Both are read-only readings of data the backend has already computed. The
 * planner below does not choose what to fund -- it shows the options the backend
 * scored, sorted by what each one protects, and lets the eye follow them onto the
 * map. Choosing is somebody's decision, and spending real money is not something a
 * 3D view should do on a click.
 *
 * The numbers are never summed. Two interventions that each protect 400 people do
 * not protect 800: they overlap. The panel shows the measured-together figure when
 * the backend supplies one, and says so when it does not.
 */

import { useMemo, useState } from "react";
import { Coins, ShieldAlert } from "lucide-react";
import { Badge, Button, Select } from "@/components/ui";
import { formatNumber } from "@/lib/format";
import type { CriticalityIndex, InvestmentPlan } from "@/lib/types";

/** Cool-to-warm ramp matching the lens columns on the map. */
export function lensColour(value: number): string {
  const clamped = Math.max(0, Math.min(100, value));
  const hue = 200 - (clamped / 100) * 200;
  return `hsl(${hue}, 85%, 55%)`;
}

export type LensMode = "off" | "criticality" | "investment";

export interface LensPanelProps {
  criticality: CriticalityIndex | null;
  investment: InvestmentPlan | null;
  loading?: boolean;
  error?: string | null;
  mode: LensMode;
  onMode: (mode: LensMode) => void;
  onSelectAsset?: (id: number) => void;
}

export function LensPanel({
  criticality,
  investment,
  loading,
  error,
  mode,
  onMode,
  onSelectAsset,
}: LensPanelProps) {
  if (loading) return <p className="text-xs text-ink-500">Scoring the fleet…</p>;

  if (error) {
    return (
      <p className="rounded-lg border border-coral/30 bg-coral/10 px-3 py-2 text-xs text-coral" role="alert">
        {error}
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant={mode === "criticality" ? "secondary" : "ghost"}
          size="sm"
          onClick={() => onMode(mode === "criticality" ? "off" : "criticality")}
          aria-pressed={mode === "criticality"}
        >
          <ShieldAlert className="h-3.5 w-3.5" aria-hidden /> Criticality
        </Button>
        <Button
          variant={mode === "investment" ? "secondary" : "ghost"}
          size="sm"
          onClick={() => onMode(mode === "investment" ? "off" : "investment")}
          aria-pressed={mode === "investment"}
        >
          <Coins className="h-3.5 w-3.5" aria-hidden /> Investment
        </Button>
        {mode !== "off" ? (
          <span className="text-[10px] text-ink-500">
            Columns of light on the map · taller and redder means higher
          </span>
        ) : null}
      </div>

      {mode === "criticality" ? (
        <CriticalityList criticality={criticality} onSelectAsset={onSelectAsset} />
      ) : null}
      {mode === "investment" ? (
        <InvestmentList investment={investment} onSelectAsset={onSelectAsset} />
      ) : null}
      {mode === "off" ? (
        <p className="text-[11px] leading-relaxed text-ink-500">
          Criticality ranks assets by how much the city loses if they fail. Investment shows what each
          candidate intervention protects. Both are read-only views — neither changes an asset or
          commits a plan.
        </p>
      ) : null}
    </div>
  );
}

function CriticalityList({
  criticality,
  onSelectAsset,
}: {
  criticality: CriticalityIndex | null;
  onSelectAsset?: (id: number) => void;
}) {
  const rows = useMemo(
    () => [...(criticality?.ranking ?? [])].sort((a, b) => b.criticality_index - a.criticality_index),
    [criticality],
  );

  if (!criticality || rows.length === 0) {
    return <p className="text-[11px] text-ink-500">No criticality ranking available.</p>;
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="accent">{criticalityStats(criticality).scored} assets scored</Badge>
        <span className="text-[10px] text-ink-500">
          mean {criticalityStats(criticality).mean.toFixed(1)} · peak{" "}
          {criticalityStats(criticality).peak.toFixed(1)}
        </span>
      </div>
      <ul className="max-h-56 space-y-1 overflow-y-auto">
        {rows.slice(0, 10).map((row) => (
          <li key={row.asset_id}>
            <button
              onClick={() => onSelectAsset?.(row.asset_id)}
              className="w-full rounded-lg border border-white/5 bg-white/[0.02] px-2 py-1.5 text-left transition hover:border-white/15"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-1.5 truncate text-[11px] text-ink-200">
                  <span
                    className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm"
                    style={{ backgroundColor: lensColour(row.criticality_index) }}
                    aria-hidden
                  />
                  <span className="font-mono text-[10px] text-ink-500">{row.code}</span>
                  <span className="truncate">{row.name}</span>
                </span>
                <span className="shrink-0 text-[11px] tabular-nums text-ink-200">
                  {row.criticality_index.toFixed(0)}
                </span>
              </div>
              <p className="mt-0.5 text-[10px] leading-snug text-ink-500">
                {row.dependants_direct} direct dependants · loss would affect{" "}
                {formatNumber(row.consequence.population_affected, 0)} people
              </p>
            </button>
          </li>
        ))}
      </ul>
      <p className="text-[10px] leading-snug text-ink-600">
        {criticality.model.assumptions[0] ?? "Ranked by modelled consequence, not by asset criticality flag alone."}
      </p>
    </div>
  );
}

function InvestmentList({
  investment,
  onSelectAsset,
}: {
  investment: InvestmentPlan | null;
  onSelectAsset?: (id: number) => void;
}) {
  const [sortBy, setSortBy] = useInvestmentSort();

  if (!investment) {
    return <p className="text-[11px] text-ink-500">No investment options computed.</p>;
  }

  const options = [...investment.options]
    .filter((option) => option.changes_anything)
    .sort((a, b) =>
      sortBy === "people"
        ? b.benefit.population_protected - a.benefit.population_protected
        : b.benefit.resilience_score - a.benefit.resilience_score,
    );

  const maxBenefit = options.reduce(
    (max, option) => Math.max(max, option.benefit.population_protected),
    1,
  );

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="warning">
          {formatNumber(investment.baseline.population_at_risk, 0)} people at risk today
        </Badge>
        <Select
          value={sortBy}
          onChange={(event) => setSortBy(event.target.value as "people" | "score")}
          aria-label="Sort interventions by"
          className="py-1.5 text-xs"
        >
          <option value="people">Most people protected</option>
          <option value="score">Highest resilience score</option>
        </Select>
      </div>

      <ul className="max-h-56 space-y-1 overflow-y-auto">
        {options.slice(0, 10).map((option) => (
          <li key={`${option.asset_id}-${option.intervention}`}>
            <button
              onClick={() => onSelectAsset?.(option.asset_id)}
              className="w-full rounded-lg border border-white/5 bg-white/[0.02] px-2 py-1.5 text-left transition hover:border-white/15"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-[11px] text-ink-200">
                  <span className="font-mono text-[10px] text-ink-500">{option.asset_code}</span>{" "}
                  {option.asset_name}
                </span>
                <span className="shrink-0 text-[10px] text-ink-500">
                  £{formatNumber(option.annual_cost, 0)}/yr
                </span>
              </div>
              <p className="text-[10px] text-ink-500">{option.intervention.replace(/_/g, " ")}</p>
              {/* A bar, not just a number: comparing twelve figures read in a column
                  is harder than comparing twelve lengths. */}
              <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-white/5">
                <div
                  className="h-full rounded-full"
                  style={{
                    width: `${Math.round((option.benefit.population_protected / maxBenefit) * 100)}%`,
                    backgroundColor: lensColour(
                      (option.benefit.population_protected / maxBenefit) * 100,
                    ),
                  }}
                />
              </div>
              <p className="mt-0.5 text-[10px] text-ink-400">
                protects {formatNumber(option.benefit.population_protected, 0)} people · saves{" "}
                {option.benefit.assets_saved} assets
              </p>
            </button>
          </li>
        ))}
      </ul>

      <p className="text-[10px] leading-snug text-ink-600">
        Each figure is measured on its own. Benefits do not add up: two interventions can protect the
        same people. {investment.method?.costs_are === "annualised" ? "Costs are annualised." : ""}
      </p>
    </div>
  );
}

/** Local sort state, kept out of the list component's props. */
function useInvestmentSort() {
  const [sortBy, setSortBy] = useState<"people" | "score">("people");
  return [sortBy, setSortBy] as const;
}
