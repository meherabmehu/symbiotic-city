"use client";

/**
 * Side-by-side comparison of two stored simulation runs.
 *
 * The failure lab produces runs one at a time, and each answer is a whole column of
 * numbers. This panel answers the other question -- which of two is worse -- in
 * terms of the assets themselves, because two runs can fail the same number of
 * buildings and not overlap on one of them.
 *
 * Read-only in the strongest sense: it fetches two stored results and renders a
 * comparison. It cannot run a simulation, and it never writes.
 */

import { useMemo } from "react";
import { ArrowRight, Equal, Minus, TrendingDown, TrendingUp } from "lucide-react";
import { Badge, Select } from "@/components/ui";
import { formatNumber } from "@/lib/format";
import { diffRuns, type AssetDelta, type ImpactLevel } from "@/lib/run-diff";
import type { SimulationRun, SimulationRunDetail } from "@/lib/types";

const LEVEL_TONE: Record<ImpactLevel, string> = {
  failed: "text-coral",
  degraded: "text-amber",
  affected: "text-accent",
};

const LEVEL_LABEL: Record<ImpactLevel, string> = {
  failed: "Failed",
  degraded: "Degraded",
  affected: "Affected",
};

export interface RunComparePanelProps {
  runs: SimulationRun[];
  aId: number | null;
  bId: number | null;
  onSelectA: (id: number | null) => void;
  onSelectB: (id: number | null) => void;
  a: SimulationRunDetail | null;
  b: SimulationRunDetail | null;
  loading?: boolean;
  error?: string | null;
}

export function RunComparePanel({
  runs,
  aId,
  bId,
  onSelectA,
  onSelectB,
  a,
  b,
  loading,
  error,
}: RunComparePanelProps) {
  const completed = useMemo(() => runs.filter((run) => run.status === "completed"), [runs]);

  const runA = completed.find((run) => run.id === aId) ?? null;
  const runB = completed.find((run) => run.id === bId) ?? null;

  const diff = useMemo(
    () => (runA && runB ? diffRuns({ run: runA, detail: a }, { run: runB, detail: b }) : null),
    [runA, runB, a, b],
  );

  if (completed.length < 2) {
    return (
      <p className="text-xs leading-relaxed text-ink-500">
        Two completed runs are needed to compare. Run a second failure in the lab; this panel only
        reads stored results and cannot start one.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <div className="grid gap-2 sm:grid-cols-[1fr_auto_1fr] sm:items-end">
        <label className="block text-[11px]">
          <span className="mb-1 block uppercase tracking-[0.14em] text-ink-500">Run A</span>
          <Select
            value={aId ?? ""}
            onChange={(event) => onSelectA(event.target.value ? Number(event.target.value) : null)}
            aria-label="First run to compare"
            className="w-full py-1.5 text-xs"
          >
            <option value="">Choose a run…</option>
            {completed.map((run) => (
              <option key={run.id} value={run.id}>
                {run.code} · {run.name}
              </option>
            ))}
          </Select>
        </label>
        <span className="hidden pb-2 text-ink-600 sm:block" aria-hidden>
          <ArrowRight className="h-4 w-4" />
        </span>
        <label className="block text-[11px]">
          <span className="mb-1 block uppercase tracking-[0.14em] text-ink-500">Run B</span>
          <Select
            value={bId ?? ""}
            onChange={(event) => onSelectB(event.target.value ? Number(event.target.value) : null)}
            aria-label="Second run to compare"
            className="w-full py-1.5 text-xs"
          >
            <option value="">Choose a run…</option>
            {completed.map((run) => (
              <option key={run.id} value={run.id}>
                {run.code} · {run.name}
              </option>
            ))}
          </Select>
        </label>
      </div>

      {error ? (
        <p className="rounded-lg border border-coral/30 bg-coral/10 px-3 py-2 text-xs text-coral" role="alert">
          {error}
        </p>
      ) : null}

      {loading ? <p className="text-xs text-ink-500">Loading both runs…</p> : null}

      {diff ? (
        <>
          <p className="rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-xs leading-relaxed text-ink-200">
            {diff.verdict}
          </p>

          <div className="grid grid-cols-2 gap-2">
            {[
              { label: runA!.code, counts: diff.totals.a },
              { label: runB!.code, counts: diff.totals.b },
            ].map((side) => (
              <div key={side.label} className="rounded-lg border border-white/10 bg-white/[0.02] px-2 py-1.5">
                <p className="font-mono text-[10px] text-ink-500">{side.label}</p>
                <p className="mt-0.5 text-[11px] text-ink-200">
                  <span className="text-coral">{side.counts.failed} failed</span>
                  {" · "}
                  <span className="text-amber">{side.counts.degraded} degraded</span>
                  {" · "}
                  <span className="text-accent">{side.counts.affected} affected</span>
                </p>
              </div>
            ))}
          </div>

          <div className="space-y-1">
            <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-500">
              What differs ({diff.onlyA.length + diff.onlyB.length + diff.shared.filter((row) => row.worse !== 0).length})
            </p>
            {diff.rows.length === 0 ? (
              <p className="text-[11px] text-ink-500">Neither run reached any asset.</p>
            ) : (
              <ul className="max-h-64 space-y-1 overflow-y-auto pr-1">
                {diff.rows.slice(0, 40).map((row) => (
                  <CompareRow key={row.asset_id} row={row} />
                ))}
              </ul>
            )}
            {diff.rows.length > 40 ? (
              <p className="text-[10px] text-ink-600">
                Showing the 40 most severe of {diff.rows.length}. The counts above cover all of them.
              </p>
            ) : null}
          </div>

          <p className="text-[10px] leading-snug text-ink-600">
            Both columns come from stored results, replayed against today&apos;s asset names. Neither run
            has been re-executed, and this comparison changes nothing.
          </p>
        </>
      ) : (
        <p className="text-[11px] text-ink-500">Choose two different runs to compare them.</p>
      )}
    </div>
  );
}

function CompareRow({ row }: { row: AssetDelta }) {
  // Three cases, and each says something different: only A, only B, or both with a
  // change in severity. A row where both agree is still listed -- it is the bulk of
  // the answer, and hiding it would make the two runs look less alike than they are.
  const Icon = row.worse === 1 ? TrendingUp : row.worse === -1 ? TrendingDown : row.a && row.b ? Equal : Minus;

  return (
    <li className="flex items-center justify-between gap-2 rounded bg-white/[0.03] px-2 py-1 text-[11px]">
      <span className="flex min-w-0 items-center gap-1.5">
        <Icon
          className={
            row.worse === 1 ? "h-3 w-3 shrink-0 text-coral" : row.worse === -1 ? "h-3 w-3 shrink-0 text-mint" : "h-3 w-3 shrink-0 text-ink-600"
          }
          aria-hidden
        />
        <span className="font-mono text-[10px] text-ink-500">{row.code}</span>
        <span className="truncate text-ink-300">{row.name}</span>
      </span>
      <span className="shrink-0 font-mono text-[10px]">
        <Level level={row.a} />
        <span className="text-ink-600"> → </span>
        <Level level={row.b} />
      </span>
    </li>
  );
}

function Level({ level }: { level: ImpactLevel | null }) {
  if (!level) return <span className="text-ink-600">—</span>;
  return (
    <span className={LEVEL_TONE[level]}>
      {LEVEL_LABEL[level]}
    </span>
  );
}
