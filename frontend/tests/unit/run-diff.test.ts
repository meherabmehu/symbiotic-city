import { describe, expect, it } from "vitest";
import { diffRuns, type RunSide } from "@/lib/run-diff";
import type { Impact, SimulationRun, SimulationRunDetail } from "@/lib/types";

function run(id: number, code: string): SimulationRun {
  return {
    id,
    code,
    name: code,
    status: "completed",
    failure_mode: "total_failure",
    cascade_threshold: 0.35,
    max_depth: 4,
    random_seed: 1,
    started_at: "2026-01-01T00:00:00Z",
    completed_at: "2026-01-01T00:01:00Z",
    duration_ms: 60000,
    triggered_by_id: 1,
    incident_id: null,
    summary: {
      assets_total: 23,
      assets_impacted: 0,
      assets_failed: 0,
      assets_degraded: 0,
      assets_affected: 0,
      max_depth_reached: 0,
      population_at_risk: 0,
      population_affected: 0,
      critical_services_lost: [],
      total_capacity_loss: 0,
      cascade_depth_histogram: {},
      generated_at: "2026-01-01T00:01:00Z",
    } as unknown as SimulationRun["summary"],
    initial_failure_ids: [1],
  };
}

function impact(asset_id: number, code: string, level: Impact["impact_level"]): Impact {
  return {
    asset_id,
    code,
    name: `Asset ${code}`,
    category: "substation",
    impact_level: level,
    depth: 1,
    impact_score: 1,
    capacity_loss_percent: 100,
    affected_population: 100,
    cause_asset_id: 1,
    explanation: "because",
  };
}

function side(id: number, code: string, impacts: Impact[]): RunSide {
  return {
    run: run(id, code),
    detail: { ...run(id, code), impacts, timeline: [], graph_warnings: [], assumptions: [], snapshot_hash: "x" } as SimulationRunDetail,
  };
}

describe("run comparison", () => {
  it("reports a strictly better run without hedging", () => {
    const a = side(1, "SIM-A", [impact(2, "SS-01", "failed"), impact(3, "HO-01", "degraded")]);
    const b = side(2, "SIM-B", [impact(2, "SS-01", "failed")]);
    const diff = diffRuns(a, b);

    expect(diff.onlyA.map((row) => row.code)).toEqual(["HO-01"]);
    expect(diff.onlyB).toHaveLength(0);
    expect(diff.verdict).toContain("trades nothing");
  });

  it("calls a run worse when it adds a failure the other does not have", () => {
    const a = side(1, "SIM-A", [impact(2, "SS-01", "failed")]);
    const b = side(2, "SIM-B", [impact(2, "SS-01", "failed"), impact(3, "HO-01", "failed")]);
    const diff = diffRuns(a, b);
    expect(diff.totals.lostToB).toBe(1);
    expect(diff.verdict).toContain("strictly worse");
  });

  it("does not pretend a trade-off is a win", () => {
    const a = side(1, "SIM-A", [impact(2, "SS-01", "failed"), impact(3, "HO-01", "failed")]);
    const b = side(2, "SIM-B", [impact(4, "WP-01", "failed"), impact(5, "WT-01", "degraded")]);
    const diff = diffRuns(a, b);
    expect(diff.totals.savedByB).toBe(2);
    expect(diff.totals.lostToB).toBe(1);
    expect(diff.verdict).toContain("Neither run dominates");
  });

  it("says so plainly when two runs agree", () => {
    const a = side(1, "SIM-A", [impact(2, "SS-01", "failed")]);
    const b = side(2, "SIM-B", [impact(2, "SS-01", "failed")]);
    expect(diffRuns(a, b).verdict).toContain("exactly the same");
  });

  it("marks severity changes on a shared asset, not just presence", () => {
    const a = side(1, "SIM-A", [impact(2, "SS-01", "affected")]);
    const b = side(2, "SIM-B", [impact(2, "SS-01", "failed")]);
    const row = diffRuns(a, b).shared[0];
    expect(row.a).toBe("affected");
    expect(row.b).toBe("failed");
    // Worse in B, so +1: the sign follows severity rather than which side is A.
    expect(row.worse).toBe(1);
  });

  it("keeps the worse level when a run reports the same asset twice", () => {
    const a = side(1, "SIM-A", [impact(2, "SS-01", "affected"), impact(2, "SS-01", "failed")]);
    expect(diffRuns(a, side(2, "SIM-B", [])).rows[0].a).toBe("failed");
  });

  it("refuses to compare against a run that has not loaded", () => {
    // An unloaded run is not an empty run. Rendering it as "no changes" would be
    // the most misleading answer possible.
    const diff = diffRuns(side(1, "SIM-A", [impact(2, "SS-01", "failed")]), { run: run(2, "SIM-B"), detail: null });
    expect(diff.verdict).toBeNull();
  });

  it("puts the worst asset at the top", () => {
    const a = side(1, "SIM-A", [impact(2, "AA-01", "affected"), impact(3, "ZZ-01", "failed")]);
    expect(diffRuns(a, side(2, "SIM-B", [])).rows[0].code).toBe("ZZ-01");
  });
});
