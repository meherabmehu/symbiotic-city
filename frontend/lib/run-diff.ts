/**
 * Comparing two simulation runs.
 *
 * A single run answers "what would this failure cost me". The question people
 * actually ask is "which of these two is worse", and the answer is almost never
 * just the summary counts: two runs can fail the same number of assets and not
 * overlap on a single one of them.
 *
 * Everything here is pure and derived from stored results. Nothing is re-run, and
 * nothing is written back to the model.
 */

import type { Impact, SimulationRun, SimulationRunDetail } from "@/lib/types";

export type ImpactLevel = "failed" | "degraded" | "affected";

/** One side of a comparison, reduced to what a diff needs. */
export interface RunSide {
  run: SimulationRun;
  detail: SimulationRunDetail | null;
}

export interface AssetDelta {
  asset_id: number;
  code: string;
  name: string;
  /** Level in run A, or null when A did not touch the asset. */
  a: ImpactLevel | null;
  /** Level in run B, or null when B did not touch the asset. */
  b: ImpactLevel | null;
  /**
   * -1 when B is better than A, +1 when B is worse, 0 when they agree.
   *
   * "Better" means lower severity: affected < degraded < failed. An asset that
   * only A breaks is worse in A, so the sign follows severity, not run order.
   */
  worse: -1 | 0 | 1;
}

export interface RunDiff {
  /** Union of every asset either run touched, worst first. */
  rows: AssetDelta[];
  onlyA: AssetDelta[];
  onlyB: AssetDelta[];
  shared: AssetDelta[];
  totals: {
    a: { failed: number; degraded: number; affected: number };
    b: { failed: number; degraded: number; affected: number };
    /** Assets broken by A and not by B, and the reverse. */
    savedByB: number;
    lostToB: number;
  };
  /** The one-line verdict, or null when the two runs agree completely. */
  verdict: string | null;
}

const RANK: Record<ImpactLevel, number> = { affected: 1, degraded: 2, failed: 3 };

function indexOf(detail: SimulationRunDetail | null): Map<number, Impact> {
  const map = new Map<number, Impact>();
  for (const impact of detail?.impacts ?? []) {
    // A run that reports an asset twice should not have the weaker entry win.
    const existing = map.get(impact.asset_id);
    if (!existing || RANK[impact.impact_level] > RANK[existing.impact_level]) {
      map.set(impact.asset_id, impact);
    }
  }
  return map;
}

function counts(detail: SimulationRunDetail | null) {
  const totals = { failed: 0, degraded: 0, affected: 0 };
  for (const impact of detail?.impacts ?? []) {
    const level = impact.impact_level;
    if (level === "failed" || level === "degraded" || level === "affected") totals[level] += 1;
  }
  return totals;
}

/**
 * Compare two runs by the assets they impact.
 *
 * Returns an empty diff when either side is missing: a comparison against a run
 * that has not loaded is not a comparison, and rendering it as "no changes" would
 * be the most misleading possible answer.
 */
export function diffRuns(a: RunSide, b: RunSide): RunDiff {
  const left = indexOf(a.detail);
  const right = indexOf(b.detail);

  const rows: AssetDelta[] = [];
  for (const id of new Set([...left.keys(), ...right.keys()])) {
    const impactA = left.get(id) ?? null;
    const impactB = right.get(id) ?? null;
    const levelA = impactA?.impact_level ?? null;
    const levelB = impactB?.impact_level ?? null;

    const rankA = levelA ? RANK[levelA] : 0;
    const rankB = levelB ? RANK[levelB] : 0;
    const worse = rankB === rankA ? 0 : rankB > rankA ? 1 : -1;

    const source = impactA ?? impactB;
    rows.push({
      asset_id: id,
      code: source?.code ?? `#${id}`,
      name: source?.name ?? `Asset ${id}`,
      a: levelA,
      b: levelB,
      worse,
    });
  }

  // Worst first, then alphabetical: the reader wants the reason to care at the top.
  rows.sort((x, y) => {
    const severity = Math.max(RANK[y.a ?? "affected"], RANK[y.b ?? "affected"], 0) -
      Math.max(RANK[x.a ?? "affected"], RANK[x.b ?? "affected"], 0);
    if (severity !== 0) return severity;
    return x.code.localeCompare(y.code);
  });

  const onlyA = rows.filter((row) => row.a && !row.b);
  const onlyB = rows.filter((row) => row.b && !row.a);
  const shared = rows.filter((row) => row.a && row.b);

  const savedByB = onlyA.filter((row) => row.a === "failed").length;
  const lostToB = onlyB.filter((row) => row.b === "failed").length;

  return {
    rows,
    onlyA,
    onlyB,
    shared,
    totals: { a: counts(a.detail), b: counts(b.detail), savedByB, lostToB },
    verdict: verdictFor(a, b, savedByB, lostToB, onlyA.length, onlyB.length),
  };
}

function verdictFor(
  a: RunSide,
  b: RunSide,
  savedByB: number,
  lostToB: number,
  onlyACount: number,
  onlyBCount: number,
): string | null {
  if (!a.detail || !b.detail) return null;
  if (onlyACount === 0 && onlyBCount === 0) {
    return "Both runs reach exactly the same assets at the same severity.";
  }
  if (onlyBCount === 0) {
    return `${b.run.code} trades nothing for its result: it reaches ${onlyACount} asset${
      onlyACount === 1 ? "" : "s"
    } that ${a.run.code} breaks, and none the other way.`;
  }
  if (onlyACount === 0) {
    return `${b.run.code} is strictly worse: it reaches ${onlyBCount} asset${
      onlyBCount === 1 ? "" : "s"
    } that ${a.run.code} does not, and breaks the same things otherwise.`;
  }
  const saved = savedByB > 0 ? `spares ${savedByB} failure${savedByB === 1 ? "" : "s"}` : "spares no failures";
  const lost = lostToB > 0 ? `but adds ${lostToB}` : "and adds none";
  return `${b.run.code} ${saved} ${lost}, against ${a.run.code}. Neither run dominates; the choice is a judgement.`;
}
