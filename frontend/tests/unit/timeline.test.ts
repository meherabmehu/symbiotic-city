import { describe, expect, it } from "vitest";
import { changedAssets, describeFrame, frameAt, statusSteps } from "@/lib/timeline";
import type { Timeline, TimelineStep, TwinNode } from "@/lib/types";

/**
 * Time travel.
 *
 * The point of these tests is that a scrubbed frame is *reconstructed from the
 * recorded log*, never guessed. Where the log is silent the asset keeps its live
 * status, because the live status is the only thing known to be true.
 */

function step(
  index: number,
  assetId: number,
  from: string,
  to: string,
  kind: TimelineStep["kind"] = "status",
): TimelineStep {
  return {
    index,
    at: `2026-11-2${index}T00:00:00Z`,
    kind,
    summary: `${assetId}: ${from} → ${to}`,
    detail: "",
    from,
    to,
    asset_id: assetId,
    asset_code: `A-${assetId}`,
    was: from,
    now: to,
  };
}

function timeline(steps: TimelineStep[]): Timeline {
  return {
    window: { since: "2026-11-01T00:00:00Z", until: "2026-11-22T00:00:00Z" },
    steps,
    step_count: steps.length,
    total_changes: steps.length,
    truncated: false,
    snapshot_at_end: {},
    sources: {},
    notes: [],
  };
}

function node(id: number, status: string): TwinNode {
  return {
    id,
    code: `A-${id}`,
    name: `Asset ${id}`,
    category: "substation",
    status,
    criticality: 3,
    map_x: 50,
    map_y: 50,
    zone: "Z-CEN",
    capacity: 100,
    load_percent: 50,
    active_incidents: 0,
  } as TwinNode;
}

// The current state of the world: 1 is offline, 2 degraded, 3 fine.
const NODES = [node(1, "offline"), node(2, "degraded"), node(3, "operational"), node(4, "maintenance")];

// What happened, oldest first.
const STEPS = [
  step(1, 1, "operational", "degraded"), // asset 1 degraded
  step(2, 2, "operational", "degraded"), // asset 2 degraded
  step(3, 1, "degraded", "offline"), // asset 1 went down
];

describe("time travel", () => {
  it("uses only status transitions, not every activity in the log", () => {
    const mixed = timeline([
      step(1, 1, "operational", "degraded"),
      { ...step(2, 9, "a", "b", "dispatch"), from: undefined, to: undefined },
      step(3, 2, "operational", "degraded"),
    ]);
    expect(statusSteps(mixed).map((s) => s.index)).toEqual([1, 3]);
  });

  it("returns the live state at the end of the log", () => {
    const frame = frameAt(timeline(STEPS), NODES, STEPS.length);
    expect(frame.statuses.get(1)).toBe("offline");
    expect(frame.statuses.get(2)).toBe("degraded");
    expect(frame.statuses.get(3)).toBe("operational");
  });

  it("rewinds transitions in reverse order", () => {
    // One step back: asset 1's last change is undone, so it is degraded again --
    // not operational, which would skip a transition.
    const oneBack = frameAt(timeline(STEPS), NODES, 2);
    expect(oneBack.statuses.get(1)).toBe("degraded");
    expect(oneBack.statuses.get(2)).toBe("degraded");

    // Two back: asset 2 is back to operational, asset 1 still degraded.
    const twoBack = frameAt(timeline(STEPS), NODES, 1);
    expect(twoBack.statuses.get(1)).toBe("degraded");
    expect(twoBack.statuses.get(2)).toBe("operational");
  });

  it("leaves assets with no recorded transition at their live status", () => {
    // Silence in the log is not evidence of a different state.
    const frame = frameAt(timeline(STEPS), NODES, 0);
    expect(frame.statuses.get(3)).toBe("operational");
    expect(frame.statuses.get(4)).toBe("maintenance");
  });

  it("keeps a maintenance window in place, because it is real work", () => {
    const withMaintenance = timeline([...STEPS, step(4, 4, "operational", "maintenance")]);
    const frame = frameAt(withMaintenance, NODES, withMaintenance.steps.length);
    expect(frame.statuses.get(4)).toBe("maintenance");
    expect(frame.maintenance.has(4)).toBe(true);

    // Rewinding past the maintenance start puts it back to operational, which is
    // what the log says -- and it stops being protected.
    const rewound = frameAt(withMaintenance, NODES, 0);
    expect(rewound.statuses.get(4)).toBe("operational");
    expect(rewound.maintenance.has(4)).toBe(false);
  });

  it("clamps a scrub past either end instead of producing an undefined state", () => {
    expect(frameAt(timeline(STEPS), NODES, -5).index).toBe(0);
    expect(frameAt(timeline(STEPS), NODES, 999).index).toBe(STEPS.length);
  });

  it("says which transition the frame sits on", () => {
    const frame = frameAt(timeline(STEPS), NODES, 2);
    expect(frame.step?.index).toBe(2);
    expect(describeFrame(frame)).toContain("2");
    expect(describeFrame(frameAt(null, NODES, 0))).toBe("No status changes recorded");
  });

  it("lists exactly the assets that differ from the present", () => {
    const frame = frameAt(timeline(STEPS), NODES, 0);
    const changed = changedAssets(frame, NODES);
    // Asset 1 and 2 were operational/operational in the past; 3 and 4 did not
    // change, so they must not appear.
    expect(changed.map((entry) => entry.node.id).sort()).toEqual([1, 2]);
    expect(changed.every((entry) => entry.was !== entry.now)).toBe(true);
  });

  it("handles a missing timeline", () => {
    const frame = frameAt(null, NODES, 5);
    expect(frame.total).toBe(0);
    expect(frame.statuses.get(1)).toBe("offline");
  });
});
