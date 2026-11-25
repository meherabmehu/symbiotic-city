import { describe, expect, it } from "vitest";
import { STEP_SECONDS, replayDuration, replayFrame } from "@/lib/replay";
import type { Impact, SimulationRunDetail } from "@/lib/types";

/**
 * Cascade playback maths.
 *
 * These are the assertions that decide whether the animation is *honest*: that
 * the cascade is revealed in dependency order, that the numbers shown are the
 * numbers the engine produced, and that a replay cannot invent an operational
 * state the run did not contain.
 */

function impact(
  assetId: number,
  depth: number,
  level: Impact["impact_level"],
  population = 1000,
): Impact {
  return {
    asset_id: assetId,
    code: `A-${assetId}`,
    name: `Asset ${assetId}`,
    category: "substation",
    impact_level: level,
    depth,
    impact_score: 50,
    capacity_loss_percent: level === "failed" ? 100 : 40,
    affected_population: population,
    cause_asset_id: depth === 0 ? null : 1,
    explanation: "",
  };
}

function run(impacts: Impact[], overrides: Partial<SimulationRunDetail> = {}): SimulationRunDetail {
  return {
    id: 7,
    code: "SIM-0007",
    name: "Generator failure",
    status: "completed",
    failure_mode: "total_failure",
    cascade_threshold: 0.35,
    max_depth: 6,
    random_seed: 42,
    started_at: "2026-11-22T10:00:00Z",
    completed_at: "2026-11-22T10:00:01Z",
    duration_ms: 900,
    triggered_by_id: 1,
    incident_id: null,
    summary: {
      assets_total: 23,
      assets_impacted: impacts.length,
      assets_failed: impacts.filter((i) => i.impact_level === "failed").length,
      assets_degraded: impacts.filter((i) => i.impact_level === "degraded").length,
      assets_affected: impacts.filter((i) => i.impact_level === "affected").length,
      max_depth_reached: Math.max(...impacts.map((i) => i.depth)),
      affected_population: impacts.reduce((sum, i) => sum + i.affected_population, 0),
      critical_services_down: [],
      severity_index: 70,
      cascade_category_breakdown: {},
      failure_mode: "total_failure",
      cascade_threshold: 0.35,
    },
    initial_failure_ids: [1],
    impacts,
    ...overrides,
  } as SimulationRunDetail;
}

const CASCADE = run([
  impact(1, 0, "failed", 5000),
  impact(2, 1, "failed", 3000),
  impact(3, 1, "degraded", 2000),
  impact(4, 2, "affected", 800),
]);

describe("cascade replay", () => {
  it("reveals the origin first and the rest in dependency order", () => {
    const first = replayFrame(CASCADE, 0);
    expect(first.impacts.map((i) => i.asset_id)).toEqual([1]);
    expect(first.levels.get(1)).toBe("failed");
    expect(first.levels.has(2)).toBe(false);

    const second = replayFrame(CASCADE, STEP_SECONDS);
    expect(second.impacts.map((i) => i.asset_id).sort()).toEqual([1, 2, 3]);

    const end = replayFrame(CASCADE, STEP_SECONDS * 2);
    expect(end.impacts).toHaveLength(4);
  });

  it("reports the depth being revealed, so the UI can narrate it", () => {
    expect(replayFrame(CASCADE, 0).depth).toBe(1);
    expect(replayFrame(CASCADE, STEP_SECONDS).depth).toBe(2);
    expect(replayFrame(CASCADE, STEP_SECONDS * 5).depth).toBe(3);
    expect(replayFrame(CASCADE, 0).depthCount).toBe(3);
  });

  it("keeps the population figure equal to the impacts actually revealed", () => {
    // The number beside the animation has to move with the animation. Showing the
    // final population from the first frame would overstate the impact at that
    // moment.
    expect(replayFrame(CASCADE, 0).population).toBe(5000);
    expect(replayFrame(CASCADE, STEP_SECONDS).population).toBe(10_000);
    expect(replayFrame(CASCADE, 60).population).toBe(10_800);
  });

  it("reaches a complete, stable end state", () => {
    const end = replayFrame(CASCADE, 999);
    expect(end.complete).toBe(true);
    expect(end.impacts).toHaveLength(CASCADE.impacts.length);
    // Past the end the frame must not keep changing.
    expect(replayFrame(CASCADE, 5000)).toEqual(end);
  });

  it("never reports an asset as operational during replay", () => {
    // The overlay only ever adds failure states. An asset that is fine is simply
    // absent from the map, which is what keeps the live status visible underneath.
    for (const seconds of [0, 0.5, 2, 4, 10]) {
      const frame = replayFrame(CASCADE, seconds);
      for (const level of frame.levels.values()) {
        expect(["failed", "degraded", "affected"]).toContain(level);
      }
    }
  });

  it("uses the levels the engine produced, not a worst-case guess", () => {
    const frame = replayFrame(CASCADE, 999);
    expect(frame.levels.get(3)).toBe("degraded");
    expect(frame.levels.get(4)).toBe("affected");
  });

  it("handles a run with no impacts without pretending it is mid-cascade", () => {
    const quiet = replayFrame(run([]), 0);
    expect(quiet.impacts).toEqual([]);
    expect(quiet.depthCount).toBe(0);
    expect(quiet.complete).toBe(true);
    expect(replayDuration(run([]))).toBe(0);
  });

  it("handles a missing run", () => {
    expect(replayFrame(null, 3).impacts).toEqual([]);
    expect(replayDuration(null)).toBe(0);
  });

  it("makes the replay length equal to the number of depths", () => {
    expect(replayDuration(CASCADE)).toBeCloseTo(3 * STEP_SECONDS, 5);
  });

  it("is a pure function of the playhead", () => {
    // Same input, same output, every time: scrubbing back and forth must not
    // accumulate drift.
    const a = replayFrame(CASCADE, 2.1);
    replayFrame(CASCADE, 9);
    replayFrame(CASCADE, 0.2);
    const b = replayFrame(CASCADE, 2.1);
    expect(b.impacts.map((i) => i.asset_id)).toEqual(a.impacts.map((i) => i.asset_id));
    expect(b.depth).toBe(a.depth);
  });
});
