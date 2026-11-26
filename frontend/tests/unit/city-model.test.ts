import { describe, expect, it } from "vitest";
import {
  CITY_BOUNDS,
  CITY_EXTENT,
  type CityBounds,
  MAP_SCALE,
  STATUS_STYLES,
  buildCityModel,
  buildRoadGrid,
  buildTrafficLanes,
  buildZoneHulls,
  cameraPose,
  cascadeDepths,
  clampTarget,
  fillPose,
  fitPose,
  focusPose,
  projectedSpan,
  incidentPose,
  placeAssets,
  resolveVisualStatus,
  toScene,
  routePosition,
  vehiclePosition,
  visualStatusFor,
} from "@/lib/city-model";
import type { CameraPose } from "@/lib/city-model";
import type { TwinEdge, TwinGraph, TwinNode, Zone } from "@/lib/types";

/* --------------------------------------------------------------- fixtures */

function node(overrides: Partial<TwinNode> & { id: number }): TwinNode {
  return {
    id: overrides.id,
    code: overrides.code ?? `N-${overrides.id}`,
    name: overrides.name ?? `Node ${overrides.id}`,
    category: overrides.category ?? "substation",
    status: overrides.status ?? "operational",
    criticality: overrides.criticality ?? 3,
    map_x: overrides.map_x ?? 50,
    map_y: overrides.map_y ?? 50,
    zone: overrides.zone ?? "Z-CEN",
    capacity: overrides.capacity ?? 100,
    load_percent: overrides.load_percent ?? 50,
    active_incidents: overrides.active_incidents ?? 0,
  };
}

function edge(source: number, target: number): TwinEdge {
  return {
    id: source * 1000 + target,
    source,
    target,
    dependency_type: "power",
    impact_weight: 0.6,
    redundancy: 0.1,
  };
}

function graphOf(nodes: TwinNode[], edges: TwinEdge[] = []): TwinGraph {
  return {
    nodes,
    edges,
    zones: [],
    generated_at: "2026-11-22T00:00:00Z",
    stats: { nodes: nodes.length, edges: edges.length, by_status: {} },
  } as TwinGraph;
}

/** The real seed layout: 23 assets spread over a 0-100 grid, as the API sends it. */
const SEED_NODES: TwinNode[] = [
  node({ id: 1, code: "PS-01", category: "power_station", map_x: 48, map_y: 52, status: "operational" }),
  node({ id: 2, code: "PS-02", category: "power_station", map_x: 74, map_y: 30, status: "degraded" }),
  node({ id: 3, code: "SS-01", category: "substation", map_x: 50, map_y: 48 }),
  node({ id: 4, code: "SS-02", category: "substation", map_x: 62, map_y: 44 }),
  node({ id: 5, code: "HO-01", category: "hospital", map_x: 44, map_y: 58 }),
  node({ id: 6, code: "HO-02", category: "hospital", map_x: 82, map_y: 42 }),
  node({ id: 7, code: "WP-01", category: "water_pump", map_x: 56, map_y: 40 }),
  node({ id: 8, code: "WT-01", category: "water_treatment", map_x: 30, map_y: 64 }),
  node({ id: 9, code: "SC-01", category: "school", map_x: 40, map_y: 24 }),
  node({ id: 10, code: "RE-01", category: "residential", map_x: 52, map_y: 20 }),
  node({ id: 11, code: "CM-01", category: "commercial", map_x: 58, map_y: 54 }),
  node({ id: 12, code: "TX-01", category: "telecom", map_x: 66, map_y: 60, status: "offline" }),
];

/* ------------------------------------------------------------------ scaling */

describe("coordinates", () => {
  it("maps the 0-100 grid onto a centred scene with the documented scale", () => {
    expect(toScene(50, 50)).toEqual({ x: 0, z: 0 });
    expect(toScene(0, 0)).toEqual({ x: -CITY_EXTENT, z: -CITY_EXTENT });
    expect(toScene(100, 100)).toEqual({ x: CITY_EXTENT, z: CITY_EXTENT });
    // The mapper is linear: a quarter across the grid is a quarter of the extent.
    expect(toScene(25, 75)).toEqual({ x: -CITY_EXTENT / 2, z: CITY_EXTENT / 2 });
  });
});

/* ------------------------------------------------------------------- layout */

describe("asset placement", () => {
  const placed = placeAssets(SEED_NODES);

  it("keeps every asset that the graph contains", () => {
    expect(placed).toHaveLength(SEED_NODES.length);
  });

  it("gives each asset a footprint and a height proportional to its category", () => {
    for (const asset of placed) {
      expect(asset.footprint.width).toBeGreaterThan(0);
      expect(asset.footprint.height).toBeGreaterThan(0);
      // A telecom mast is tall and thin; a water treatment works is low and wide.
      if (asset.node.category === "telecom") {
        expect(asset.footprint.height).toBeGreaterThan(asset.footprint.width);
      }
    }
  });

  it("does not stack two assets on the same spot", () => {
    // Distinguish "nearby", which is fine and looks like a city, from "overlapping",
    // which would make two buildings share walls and hide each other's beacons.
    for (let i = 0; i < placed.length; i += 1) {
      for (let j = i + 1; j < placed.length; j += 1) {
        const a = placed[i];
        const b = placed[j];
        const dx = Math.abs(a.position.x - b.position.x);
        const dz = Math.abs(a.position.z - b.position.z);
        const overlapX = dx < (a.footprint.plot + b.footprint.plot) / 2 - 0.001;
        const overlapZ = dz < (a.footprint.plot + b.footprint.plot) / 2 - 0.001;
        expect(overlapX && overlapZ).toBe(false);
      }
    }
  });

  it("places assets inside the city extent", () => {
    for (const asset of placed) {
      expect(Math.abs(asset.position.x)).toBeLessThanOrEqual(CITY_EXTENT);
      expect(Math.abs(asset.position.z)).toBeLessThanOrEqual(CITY_EXTENT);
    }
  });
});

describe("road grid", () => {
  const placed = placeAssets(SEED_NODES);
  const grid = buildRoadGrid(placed);

  it("produces a connected network, not a single stripe", () => {
    expect(grid.segments.length).toBeGreaterThanOrEqual(4);
    // Every avenue is a full crossing of the map, which is what guarantees the
    // network is connected rather than a set of that do not meet.
    for (const segment of grid.segments) {
      const horizontal = Math.abs(segment.z2 - segment.z1) < 0.001;
      const span = horizontal
        ? Math.abs(segment.x2 - segment.x1)
        : Math.abs(segment.z2 - segment.z1);
      expect(span).toBeCloseTo(CITY_EXTENT * 2, 1);
    }
  });

  it("routes roads around building plots instead of through them", () => {
    // A road that crosses the map will pass some buildings on its way -- that is
    // what streets do. What it must never do is run *through* one, so the check is
    // per building: is this building's plot centre within half a plot of the road
    // line, while the road is within reach of that building along its length?
    for (const asset of placed) {
      for (const segment of grid.segments) {
        const horizontal = Math.abs(segment.z2 - segment.z1) < 0.001;
        const at = horizontal ? asset.position.z : asset.position.x;
        const line = horizontal ? segment.z1 : segment.x1;
        const gap = Math.abs(at - line);
        if (gap >= asset.footprint.plot / 2) continue;

        // The road is close on this axis. Is it also close on the other, i.e. does
        // it actually reach this building rather than stopping short of it?
        const along = horizontal ? asset.position.x : asset.position.z;
        const start = horizontal ? segment.x1 : segment.z1;
        const end = horizontal ? segment.x2 : segment.z2;
        const reaches = along >= start - asset.footprint.plot / 2 && along <= end + asset.footprint.plot / 2;
        expect(reaches).toBe(false);
      }
    }
  });

  it("keeps parallel avenues apart", () => {
    const horizontals = grid.segments
      .filter((segment) => Math.abs(segment.z2 - segment.z1) < 0.001)
      .map((segment) => segment.z1)
      .sort((a, b) => a - b);
    const verticals = grid.segments
      .filter((segment) => Math.abs(segment.x2 - segment.x1) < 0.001)
      .map((segment) => segment.x1)
      .sort((a, b) => a - b);

    for (const lines of [horizontals, verticals]) {
      for (let i = 1; i < lines.length; i += 1) {
        // Overlapping avenues would draw two roads on the same line and put two
        // lanes of traffic inside each other.
        expect(lines[i] - lines[i - 1]).toBeGreaterThan(8);
      }
    }
  });

  it("marks intersections where avenues cross", () => {
    expect(grid.intersections.length).toBeGreaterThan(0);
    for (const point of grid.intersections) {
      expect(Number.isFinite(point.x)).toBe(true);
      expect(Number.isFinite(point.z)).toBe(true);
    }
  });
});

describe("traffic lanes", () => {
  const lanes = buildTrafficLanes(buildRoadGrid(placeAssets(SEED_NODES)));

  it("gives every avenue two directions", () => {
    const byAxis: Record<string, Set<number>> = { h: new Set(), v: new Set() };
    for (const lane of lanes) {
      byAxis[lane.axis].add(lane.at);
    }
    for (const [axis, positions] of Object.entries(byAxis)) {
      const directions = lanes.filter((lane) => lane.axis === axis).map((lane) => lane.direction);
      expect(directions).toContain(1);
      expect(directions).toContain(-1);
      expect(positions.size).toBeGreaterThan(0);
    }
  });

  it("keeps each direction on its own side of the road", () => {
    for (const lane of lanes) {
      // Offset is a fraction of a lane, always positive: the direction is carried
      // by `direction`, and the sign of `offset` is applied when positioning.
      expect(Math.abs(lane.offset)).toBeGreaterThan(0);
      expect(Math.abs(lane.offset)).toBeLessThan(3);
    }
  });
});

/**
 * A vehicle's local +x is forward, so its world heading is (cos angle, -sin angle).
 * Two lanes had this sign inverted, which drove northbound traffic backwards down
 * the street. Nothing noticed, because a box viewed from above looks the same
 * either way -- until you look at it from street level.
 */
function headingOf(angle: number) {
  return { x: Math.cos(angle), z: -Math.sin(angle) };
}

describe("traffic heading and turns", () => {
  it("faces every vehicle in the direction it is travelling", () => {
    const model = buildCityModel(graphOf(SEED_NODES))!;
    for (const lane of model.lanes) {
      const here = vehiclePosition(lane, 0, 9, 0.3);
      const next = vehiclePosition(lane, 0.5, 9, 0.3);
      const travel = { x: Math.sign(next.x - here.x), z: Math.sign(next.z - here.z) };
      const heading = headingOf(here.angle);
      const dot = heading.x * travel.x + heading.z * travel.z;
      expect(dot, `lane ${lane.id} faces away from its travel direction`).toBeGreaterThan(0.9);
    }
  });

  it("turns at intersections instead of driving straight forever", () => {
    // Straight lanes alone are a conveyor belt: no vehicle ever turns, so nothing
    // reads as a street network. Routes are loops around blocks, with corners
    // sampled as arcs.
    const model = buildCityModel(graphOf(SEED_NODES))!;
    expect(model.routes.length).toBeGreaterThan(0);

    for (const route of model.routes) {
      expect(route.length).toBeGreaterThan(12);
      // A loop must visit both axes, otherwise it is a straight line with a
      // doubling-back artefact at the end.
      expect(new Set(route.map((point) => Math.round(point.x))).size).toBeGreaterThan(1);
      expect(new Set(route.map((point) => Math.round(point.z))).size).toBeGreaterThan(1);
    }
  });

  it("keeps a turning vehicle at the same speed through corners", () => {
    const model = buildCityModel(graphOf(SEED_NODES))!;
    const route = model.routes[0];

    // Sample at equal time steps. Distance per step must stay roughly constant: if
    // corners were walked by point index rather than by arc length, a vehicle
    // would sprint through the turns.
    const steps = 80;
    const samples = Array.from({ length: steps }, (_, index) =>
      routePosition(route, index * 0.1, 12, 0),
    );
    const hops = samples
      .slice(1)
      .map((point, index) => Math.hypot(point.x - samples[index].x, point.z - samples[index].z));
    const mean = hops.reduce((sum, hop) => sum + hop, 0) / hops.length;
    for (const hop of hops) {
      expect(hop).toBeGreaterThan(mean * 0.6);
      expect(hop).toBeLessThan(mean * 1.6);
    }
  });

  it("follows the loop's direction of travel rather than sliding sideways", () => {
    const model = buildCityModel(graphOf(SEED_NODES))!;
    const route = model.routes[0];
    const here = routePosition(route, 0, 10, 0.2);
    const next = routePosition(route, 0.2, 10, 0.2);
    const heading = headingOf(here.angle);
    const travel = { x: Math.sign(next.x - here.x), z: Math.sign(next.z - here.z) };
    const dot = heading.x * travel.x + heading.z * travel.z;
    expect(dot).toBeGreaterThan(0.5);
  });
});

describe("vehicle motion", () => {
  const lanes = buildTrafficLanes(buildRoadGrid(placeAssets(SEED_NODES)));
  const lane = lanes[0];

  it("wraps progress so a vehicle stays on its lane forever", () => {
    for (const t of [0, 3.5, 17, 120, 1000]) {
      const { x, z } = vehiclePosition(lane, t, 9, 0);
      const onAxis = lane.axis === "h" ? Math.abs(z - lane.at) < 4 : Math.abs(x - lane.at) < 4;
      expect(onAxis).toBe(true);
      expect(Math.abs(x)).toBeLessThanOrEqual(CITY_EXTENT + 0.001);
      expect(Math.abs(z)).toBeLessThanOrEqual(CITY_EXTENT + 0.001);
    }
  });

  it("moves along its own axis, never across it", () => {
    const start = vehiclePosition(lane, 0, 9, 0);
    const later = vehiclePosition(lane, 2, 9, 0);
    if (lane.axis === "h") {
      expect(later.z).toBeCloseTo(start.z, 5);
      expect(later.x).not.toBeCloseTo(start.x, 2);
    } else {
      expect(later.x).toBeCloseTo(start.x, 5);
      expect(later.z).not.toBeCloseTo(start.z, 2);
    }
  });

  it("faces the direction it travels", () => {
    const start = vehiclePosition(lane, 0, 9, 0);
    const later = vehiclePosition(lane, 1, 9, 0);
    const heading = lane.axis === "h" ? Math.sign(later.x - start.x) : Math.sign(later.z - start.z);
    // A vehicle driving backwards along its lane would read as traffic going the
    // wrong way, which is a visible bug even in a decorative system.
    expect(heading).toBe(lane.direction);
  });

  it("is identical for the same clock reading, so nothing drifts", () => {
    expect(vehiclePosition(lane, 7.25, 9, 0.3)).toEqual(vehiclePosition(lane, 7.25, 9, 0.3));
  });
});

/* -------------------------------------------------------------------- zones */

describe("zone hulls", () => {
  const zones: Zone[] = [
    { id: 1, code: "Z-CEN", name: "Central", district: "Aurora", population: 38500, center_x: 50, center_y: 48 },
    { id: 2, code: "Z-NOR", name: "North", district: "Aurora", population: 26000, center_x: 46, center_y: 18 },
    { id: 3, code: "Z-SOU", name: "South", district: "Aurora", population: 22500, center_x: 55, center_y: 82 },
  ];

  it("scales a zone by its population, so the biggest district reads as biggest", () => {
    const hulls = buildZoneHulls(zones);
    const central = hulls.find((hull) => hull.zone.code === "Z-CEN")!;
    const south = hulls.find((hull) => hull.zone.code === "Z-SOU")!;
    expect(central.radius).toBeGreaterThan(south.radius);
  });

  it("centres each hull on the zone's declared centre", () => {
    const hulls = buildZoneHulls(zones);
    const central = hulls.find((hull) => hull.zone.code === "Z-CEN")!;
    expect(central.position).toEqual(toScene(50, 48));
  });

  it("handles a zone with no population without producing a degenerate hull", () => {
    const hulls = buildZoneHulls([{ ...zones[0], population: 0 }]);
    expect(hulls[0].radius).toBeGreaterThan(0);
    expect(Number.isFinite(hulls[0].radius)).toBe(true);
  });
});

/* ------------------------------------------------------------------ status */

describe("status resolution", () => {
  it("maps the database statuses onto what the scene can draw", () => {
    expect(visualStatusFor("operational")).toBe("operational");
    expect(visualStatusFor("degraded")).toBe("degraded");
    // The API has no "failed" status; offline is how a dead asset is stored, and
    // the scene shows it as failed so the two vocabularies do not leak.
    expect(visualStatusFor("offline")).toBe("failed");
    expect(visualStatusFor("maintenance")).toBe("maintenance");
    expect(visualStatusFor("archived")).toBe("operational");
  });

  it("lets a simulation overlay promote a status, never demote it", () => {
    // A planned failure is shown on top of the live status...
    expect(resolveVisualStatus("operational", { impact: "failed" })).toBe("failed");
    expect(resolveVisualStatus("operational", { impact: "degraded" })).toBe("degraded");
    // ...but an unaffected asset in a simulation stays as the database says.
    expect(resolveVisualStatus("offline", {})).toBe("failed");
    expect(resolveVisualStatus("degraded", {})).toBe("degraded");
  });

  it("does not let a simulation overwrite a maintenance window", () => {
    // Maintenance is somebody's real, scheduled work. A what-if run must not be
    // able to hide it, or the twin would show a building as fine while an
    // engineer is standing inside it with the power off.
    expect(resolveVisualStatus("maintenance", { impact: "failed" })).toBe("maintenance");
    expect(resolveVisualStatus("maintenance", { impact: "degraded" })).toBe("maintenance");
    expect(resolveVisualStatus("maintenance", { recovering: true })).toBe("maintenance");
    expect(resolveVisualStatus("maintenance", {})).toBe("maintenance");
  });

  it("shows recovering only when the backend says a plan is approved but unverified", () => {
    expect(resolveVisualStatus("offline", { recovering: true })).toBe("recovering");
    expect(resolveVisualStatus("degraded", { recovering: true })).toBe("recovering");

    // Recovery never claims success on its own: an asset the database still calls
    // offline stays failed unless the caller explicitly marked it recovering.
    expect(resolveVisualStatus("offline", {})).toBe("failed");

    // And it cannot be claimed for something that is working: there is no
    // transition to recover from, so the label would be meaningless.
    expect(resolveVisualStatus("operational", { recovering: true })).toBe("operational");
  });

  it("gives every status a colour, a label and a non-colour mark", () => {
    for (const status of ["operational", "degraded", "failed", "maintenance", "recovering"] as const) {
      const style = STATUS_STYLES[status];
      expect(style.color).toMatch(/^#[0-9a-f]{6}$/i);
      expect(style.label.length).toBeGreaterThan(0);
      expect(style.markLabel.length).toBeGreaterThan(0);
      expect(style.glow).toBeGreaterThanOrEqual(0);
    }
    // The marks must differ from each other, otherwise the second encoding is
    // decorative rather than informative.
    const marks = new Set(
      (["operational", "degraded", "failed", "maintenance", "recovering"] as const).map(
        (status) => STATUS_STYLES[status].mark,
      ),
    );
    expect(marks.size).toBe(5);
  });
});

/* ------------------------------------------------------------------ camera */

describe("camera", () => {
  it("provides the three documented presets, each looking at the city centre", () => {
    for (const mode of ["perspective", "isometric", "top"] as const) {
      const pose = cameraPose(mode);
      expect(pose.position).toHaveLength(3);
      expect(pose.target).toEqual([0, 0, 0]);
      // Every preset direction must sit inside the range OrbitControls will
      // allow, or the controls clamp the camera somewhere the framing solver
      // never optimised -- the projection on screen would not be the one the
      // solver proved correct.
      const polar = Math.atan2(
        Math.hypot(pose.position[0], pose.position[2]),
        Math.abs(pose.position[1]),
      );
      expect(polar, `${mode} polar`).toBeGreaterThanOrEqual(CITY_BOUNDS.minPolarAngle - 1e-9);
      expect(polar, `${mode} polar`).toBeLessThanOrEqual(CITY_BOUNDS.maxPolarAngle + 1e-9);
      // A camera inside the city would render the inside of a building: every
      // preset sits outside the model's half-diagonal (~1.41 * CITY_EXTENT).
      // Anchored to the city's own scale rather than to maxDistance, which is a
      // framing budget and may move independently of where presets sit.
      const distance = Math.hypot(...pose.position);
      expect(distance).toBeGreaterThan(CITY_EXTENT * 1.5);
    }
  });

  it("uses a top-down pose that is not exactly vertical, so orbit controls do not flip", () => {
    const pose = cameraPose("top");
    expect(pose.position[0]).toBe(0);
    expect(pose.position[2]).not.toBe(0);
  });

  it("clamps a pan target to the city, however far the pointer drags", () => {
    const limit = CITY_BOUNDS.panLimit;
    expect(clampTarget([9999, 999, -9999])).toEqual([limit, CITY_BOUNDS.maxTargetHeight, -limit]);
    expect(clampTarget([0, 0, 0])).toEqual([0, 0, 0]);
    // A camera dragged downwards must not end up under the ground plane.
    expect(clampTarget([0, -50, 0])[1]).toBeGreaterThanOrEqual(0);
  });

  it("frames a building from a distance proportional to its height", () => {
    const short = focusPose({ x: 0, y: 0, z: 0 }, { width: 6, depth: 6, height: 4, plot: 8 });
    const tall = focusPose({ x: 0, y: 0, z: 0 }, { width: 6, depth: 6, height: 24, plot: 8 });
    const shortDistance = Math.hypot(...short.position);
    const tallDistance = Math.hypot(...tall.position);
    expect(tallDistance).toBeGreaterThan(shortDistance);
    // The focus target sits on the building, part-way up it, so a tall tower is
    // framed around its mass rather than its front door.
    expect(short.target[0]).toBe(0);
    expect(short.target[2]).toBe(0);
    expect(short.target[1]).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------- model */

describe("cascade depth", () => {
  const edges = [
    { source: 1, target: 2 },
    { source: 1, target: 3 },
    { source: 2, target: 4 },
    { source: 4, target: 5 },
    // A separate branch, unrelated to the origin.
    { source: 7, target: 8 },
  ];

  it("measures hops out from the origin", () => {
    const depths = cascadeDepths(edges, [2, 3, 4, 5], 1);
    expect(depths.get(1)).toBe(0);
    expect(depths.get(2)).toBe(1);
    expect(depths.get(3)).toBe(1);
    expect(depths.get(4)).toBe(2);
    // Longest path, not shortest: 5 is reached through 2 then 4, so it is three
    // hops out even though a shorter chain to it does not exist.
    expect(depths.get(5)).toBe(3);
  });

  it("leaves out assets a path reaches but the run did not touch", () => {
    // A dependency path is not a prediction. If the engine stopped before
    // cascading to 5, drawing it as part of the cascade would overstate the result.
    const depths = cascadeDepths(edges, [2, 4], 1);
    expect(depths.has(5)).toBe(false);
    expect(depths.has(8)).toBe(false);
  });

  it("returns nothing without an origin", () => {
    expect(cascadeDepths(edges, [2], null).size).toBe(0);
  });

  it("does not loop on a cycle in the dependency graph", () => {
    const cyclic = [
      { source: 1, target: 2 },
      { source: 2, target: 3 },
      { source: 3, target: 1 },
    ];
    const depths = cascadeDepths(cyclic, [2, 3], 1);
    expect(depths.get(3)).toBe(2);
    expect(depths.size).toBe(3);
  });
});

describe("camera framing", () => {
  it("frames the whole city in a narrow viewport by pulling back further", () => {
    // A fixed distance crops the model in a tall window. The fit has to use the
    // narrower of the two fields of view, which is the one that would crop first.
    const wide = fitPose("perspective", 2.2);
    const tall = fitPose("perspective", 0.6);

    const reach = (pose: CameraPose) => Math.hypot(...pose.position);
    expect(reach(tall)).toBeGreaterThan(reach(wide));
  });

  it("keeps the preset's viewing direction when fitting", () => {
    const top = fitPose("top", 1.6);
    // Top-down means looking straight down: x and z must stay near zero relative
    // to the height, or "fit" would quietly turn into an isometric view. The
    // threshold is the controls' own minPolarAngle -- the preset leans by
    // exactly that much (see cameraPose), and the fit preserves the lean.
    const height = Math.hypot(...top.position);
    const polar = Math.atan2(Math.hypot(top.position[0], top.position[2]), Math.abs(top.position[1]));
    expect(polar).toBeCloseTo(CITY_BOUNDS.minPolarAngle, 5);
    // Still unmistakably top-down, nowhere near the 45-degree isometric lean.
    expect(polar).toBeLessThan(0.2);
    expect(height).toBeGreaterThan(CITY_EXTENT);
  });

  it("clears the whole city at every aspect ratio", () => {
    for (const aspect of [0.5, 0.9, 1.6, 2.4]) {
      const pose = fitPose("isometric", aspect);
      const reach = Math.hypot(...pose.position);
      // The city's half-diagonal is ~CITY_EXTENT * 1.41; a fit distance shorter
      // than that would put the camera inside the model.
      expect(reach, `aspect ${aspect} is too close`).toBeGreaterThan(CITY_EXTENT * 1.2);
    }
  });

  it("frames an incident further out than the asset it started at", () => {
    // An incident is about what it reaches, not just the building: the camera has
    // to include the streets the consequence runs along.
    const asset = { position: { x: 10, y: 0, z: -20 }, footprint: { width: 6, depth: 6, height: 9, plot: 12 } };
    const assetPose = focusPose(asset.position, asset.footprint);
    const incident = incidentPose(asset.position, asset.footprint);

    const reach = (pose: CameraPose) =>
      Math.hypot(pose.position[0] - pose.target[0], pose.position[1] - pose.target[1], pose.position[2] - pose.target[2]);
    expect(reach(incident)).toBeGreaterThan(reach(assetPose));
    // And it must still be looking at the incident.
    expect(incident.target[0]).toBeCloseTo(10, 5);
    expect(incident.target[2]).toBeCloseTo(-20, 5);
  });
});

/* --------------------------------------------------- projected coverage */

describe("projected viewport coverage", () => {
  // The brief's target: the default shot spans ~85-95% of the viewport width.
  // Measured on *projected bounds* (projectedSpan), never on distances or
  // canvas size -- a tiny city in a correctly-sized canvas must fail these.
  const desktopAspects = [0.9, 1.0, 1.17, 1.33, 1.6, 2.08, 2.4, 2.66];

  it("the immersive opening shot spans 85-95% of the viewport width", () => {
    for (const aspect of desktopAspects) {
      const span = projectedSpan(fillPose("perspective", aspect, 42), aspect, 42);
      const pct = span.width * 100;
      expect(pct, `aspect ${aspect} width ${pct.toFixed(1)}%`).toBeGreaterThanOrEqual(85);
      expect(pct, `aspect ${aspect} width ${pct.toFixed(1)}%`).toBeLessThanOrEqual(95);
    }
  });

  it("keeps the far district inside the frame; only the near road may crop", () => {
    for (const aspect of desktopAspects) {
      const span = projectedSpan(fillPose("perspective", aspect, 42), aspect, 42);
      expect(span.maxY, `aspect ${aspect} far edge`).toBeLessThanOrEqual(1);
      // FILL_NEAR is the budget for the near boundary hanging past the bottom.
      expect(span.minY, `aspect ${aspect} near edge`).toBeGreaterThan(-2.85);
    }
  });

  it("fit entire city contains every corner of the city bounds", () => {
    for (const aspect of [0.5, 0.9, 1.33, 2.08, 3.0]) {
      const span = projectedSpan(fitPose("perspective", aspect, 42), aspect, 42);
      expect(Math.max(Math.abs(span.minY), span.maxY), `aspect ${aspect}`).toBeLessThanOrEqual(0.95);
      expect(span.width, `aspect ${aspect}`).toBeLessThanOrEqual(0.95);
      expect(span.height, `aspect ${aspect}`).toBeLessThanOrEqual(0.95);
    }
  });

  it("the immersive shot and the whole-city fit are deliberately different framings", () => {
    for (const aspect of desktopAspects) {
      const immersive = Math.hypot(...fillPose("perspective", aspect).position);
      const entire = Math.hypot(...fitPose("perspective", aspect).position);
      expect(immersive, `aspect ${aspect}`).toBeLessThan(entire);
    }
  });

  it("solves against explicit bounds when the scene differs from the analytic box", () => {
    // A rendered scene whose content extends past the analytic city box must
    // frame *that* box -- otherwise "fit" crops the very content the probe
    // reports as on screen.
    const wider: CityBounds = {
      min: [-140, 0, -140],
      max: [140, 24, 140],
    };
    const pose = fitPose("perspective", 1.6, 42, wider);
    const span = projectedSpan(pose, 1.6, 42, wider);
    expect(span.width).toBeLessThanOrEqual(0.95);
    expect(Math.max(Math.abs(span.minY), span.maxY)).toBeLessThanOrEqual(0.95);
    // The wider content needs a longer reach than the analytic box does.
    const analytic = fitPose("perspective", 1.6, 42);
    expect(Math.hypot(...pose.position)).toBeGreaterThan(Math.hypot(...analytic.position));
  });
});

describe("city model", () => {
  it("returns null for a missing graph instead of an empty scene", () => {
    expect(buildCityModel(null)).toBeNull();
  });

  it("builds one placed asset per graph node, and one edge per graph edge", () => {
    const nodes = SEED_NODES;
    const edges = [edge(1, 3), edge(3, 4), edge(3, 5), edge(1, 12)];
    const model = buildCityModel(graphOf(nodes, edges))!;
    expect(model.assets).toHaveLength(nodes.length);
    expect(model.edges).toHaveLength(edges.length);
  });

  it("resolves an edge to the actual endpoints, so links land on buildings", () => {
    const nodes = [node({ id: 1, map_x: 20, map_y: 20 }), node({ id: 2, map_x: 80, map_y: 80 })];
    const model = buildCityModel(graphOf(nodes, [edge(1, 2)]))!;
    const placed = model.edges[0];
    expect(placed.from.x).toBeCloseTo(-60, 0);
    expect(placed.to.x).toBeCloseTo(60, 0);
    // Links start above the roof, not at the ground, otherwise they disappear
    // inside the building they belong to.
    expect(placed.from.y).toBeGreaterThan(0);
  });

  it("drops edges whose endpoints are not in the graph rather than drawing them to nowhere", () => {
    const nodes = [node({ id: 1 })];
    const model = buildCityModel(graphOf(nodes, [edge(1, 99)]))!;
    expect(model.edges).toHaveLength(0);
  });

  it("keeps decorative scenery off the building plots", () => {
    const model = buildCityModel(graphOf(SEED_NODES))!;
    for (const prop of model.scenery) {
      for (const asset of model.assets) {
        const dx = Math.abs(prop.position.x - asset.position.x);
        const dz = Math.abs(prop.position.z - asset.position.z);
        const inside = dx < asset.footprint.plot / 2 && dz < asset.footprint.plot / 2;
        expect(inside).toBe(false);
      }
    }
  });

  it("keeps scenery off every carriageway, not just its own", () => {
    // A tree in the middle of a road is the clearest sign that a city is
    // decoration rather than a place. Checking against the nearest avenue only is
    // not enough: a perpendicular street can run through a kerbside slot.
    const model = buildCityModel(graphOf(SEED_NODES))!;
    for (const prop of model.scenery) {
      for (const segment of model.grid.segments) {
        const horizontal = Math.abs(segment.z2 - segment.z1) < 0.001;
        const across = horizontal
          ? Math.abs(prop.position.z - segment.z1)
          : Math.abs(prop.position.x - segment.x1);
        const within = horizontal
          ? prop.position.x >= Math.min(segment.x1, segment.x2) &&
            prop.position.x <= Math.max(segment.x1, segment.x2)
          : prop.position.z >= Math.min(segment.z1, segment.z2) &&
            prop.position.z <= Math.max(segment.z1, segment.z2);
        if (within) expect(across).toBeGreaterThan(segment.width / 2);
      }
    }
  });

  it("puts street furniture along the streets rather than scattered at random", () => {
    const model = buildCityModel(graphOf(SEED_NODES))!;
    const trees = model.scenery.filter((prop) => prop.kind === "tree");
    expect(trees.length).toBeGreaterThan(20);

    // Most trees should be nearer a road than the middle of a block: the kerbs are
    // where they are placed, and a uniform scatter would not clear this.
    const nearRoad = trees.filter((prop) =>
      model.grid.segments.some((segment) => {
        const horizontal = Math.abs(segment.z2 - segment.z1) < 0.001;
        const across = horizontal
          ? Math.abs(prop.position.z - segment.z1)
          : Math.abs(prop.position.x - segment.x1);
        return across < 9;
      }),
    );
    expect(nearRoad.length / trees.length).toBeGreaterThan(0.5);
  });

  it("draws no parked cars, because a car in a field is not scenery", () => {
    // Moving traffic is its own instanced mesh and carries no asset data. A static
    // "car" prop scattered at random would read as abandoned vehicles.
    const model = buildCityModel(graphOf(SEED_NODES))!;
    expect(model.scenery.some((prop) => (prop.kind as string) === "car")).toBe(false);
  });

  it("builds the same city twice from the same data", () => {
    // A deterministic layout is what makes placement testable at all, and stops
    // the city from rearranging itself on every refresh.
    const a = buildCityModel(graphOf(SEED_NODES))!;
    const b = buildCityModel(graphOf(SEED_NODES))!;
    expect(a.assets.map((asset) => asset.position)).toEqual(b.assets.map((asset) => asset.position));
    expect(a.scenery.map((prop) => prop.position)).toEqual(b.scenery.map((prop) => prop.position));
  });
});
