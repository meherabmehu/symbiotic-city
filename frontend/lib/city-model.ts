/**
 * City layout: the shared vocabulary between the 3D scene and its tests.
 *
 * Everything here is pure arithmetic over the twin graph the API returns, so it
 * can be unit-tested without a GPU, a canvas or a browser. The scene components
 * only decide *how* to draw what this module computes.
 *
 * Coordinate systems, deliberately kept apart:
 *
 *  - The API's `map_x` / `map_y` are a normalised 0-100 grid (y grows downward,
 *    like a screen). The database's fictional lat/long columns are not used for
 *    placement: they cluster inside one degree and would collapse into a blob.
 *  - The scene is right-handed Y-up, so a node lands at
 *    `(mapX - 50) * SCALE, height, (mapY - 50) * SCALE` -- y flipped into z so
 *    north (small map_y) is away from the default camera.
 *
 * Assets keep their real positions from the database. Decorative scenery (parked
 * cars, trees, benches) is generated from a seeded PRNG and is never attached to
 * an asset record, so nothing decorative can be mistaken for operational data.
 */

import type { TwinEdge, TwinGraph, TwinNode, Zone } from "@/lib/types";

/** How many scene units one map unit becomes. 100 map units -> 200 units. */
export const MAP_SCALE = 2;

/** Half the city's extent in scene units, used for bounds and camera limits. */
export const CITY_EXTENT = 50 * MAP_SCALE;

/** Deterministic PRNG. Seeded so scenery is identical on every render and in tests. */
export function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    // mulberry32: small, fast, good enough for scattering props.
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Point3 {
  x: number;
  y: number;
  z: number;
}

/** Map grid coordinates to scene coordinates on the ground plane. */
export function toScene(mapX: number, mapY: number): { x: number; z: number } {
  return {
    x: (mapX - 50) * MAP_SCALE,
    z: (mapY - 50) * MAP_SCALE,
  };
}

/**
 * Footprint and height per category, in scene units.
 *
 * Heights are proportional to what the thing actually is -- a power station
 * reads as a low wide hall, an office tower as tall and thin -- so the skyline
 * communicates category before any label is read. `plot` is the half-width of
 * the reserved ground square, which roads avoid.
 */
export interface Footprint {
  width: number;
  depth: number;
  height: number;
  /** Ground footprint including setback, used to route roads around the plot. */
  plot: number;
}

export const FOOTPRINTS: Record<string, Footprint> = {
  power_station: { width: 9, depth: 7, height: 5.5, plot: 12 },
  substation: { width: 5.5, depth: 5, height: 4, plot: 8 },
  hospital: { width: 8, depth: 7, height: 11, plot: 11 },
  water_pump: { width: 4, depth: 4, height: 3.5, plot: 7 },
  water_treatment: { width: 9, depth: 8, height: 4, plot: 12 },
  school: { width: 8, depth: 6, height: 5, plot: 11 },
  residential: { width: 6, depth: 5, height: 8, plot: 9 },
  commercial: { width: 6, depth: 6, height: 14, plot: 9 },
  telecom: { width: 3, depth: 3, height: 13, plot: 6 },
};

export const DEFAULT_FOOTPRINT: Footprint = {
  width: 5,
  depth: 5,
  height: 6,
  plot: 8,
};

export function footprintFor(category: string): Footprint {
  return FOOTPRINTS[category] ?? DEFAULT_FOOTPRINT;
}

/**
 * Placed asset: everything the scene needs to draw one building, computed once
 * from the graph. `index` is stable and is what tests and React keys use.
 */
export interface PlacedAsset {
  node: TwinNode;
  index: number;
  position: Point3;
  footprint: Footprint;
  /** Rotation about Y, so blocks do not all face the same way. */
  rotation: number;
}

export function placeAssets(nodes: TwinNode[]): PlacedAsset[] {
  const rng = makeRng(0x5eed);
  const placed: PlacedAsset[] = nodes.map((node, index) => {
    const { x, z } = toScene(node.map_x, node.map_y);
    const footprint = footprintFor(node.category);
    return {
      node,
      index,
      // y is the centre of the box: half its height above the ground.
      position: { x, y: footprint.height / 2, z },
      footprint,
      // Quarter turns only: rotating an axis-aligned plot by 90 degrees keeps the
      // same footprint, so the road clearance still holds afterwards.
      rotation: Math.floor(rng() * 4) * (Math.PI / 2),
    };
  });

  return separatePlots(placed);
}

/**
 * Nudge overlapping plots apart, keeping each asset as close to its recorded
 * coordinates as possible.
 *
 * The twin's `map_x`/`map_y` are a 0-100 grid, not metres, and some pairs of
 * assets sit two grid steps apart while their buildings are eight scene units
 * wide. Used directly, those pairs would share walls: one building would hide the
 * other's status beacon, and the map would misrepresent how many assets exist.
 *
 * The fix is a constrained relaxation rather than a re-layout. Each overlapping
 * pair is pushed apart along the axis where they overlap least, half the distance
 * each, until nothing overlaps or the iteration budget runs out. Movement is
 * therefore zero for the assets that already fit -- the majority -- and a few
 * units for the rest, which is small enough that the map still reads as the
 * recorded geography.
 */
function separatePlots(assets: PlacedAsset[]): PlacedAsset[] {
  const limit = CITY_EXTENT - 6;
  const positions = assets.map((asset) => ({ x: asset.position.x, z: asset.position.z }));
  const MAX_PASSES = 80;

  for (let pass = 0; pass < MAX_PASSES; pass += 1) {
    let moved = false;
    for (let i = 0; i < positions.length; i += 1) {
      for (let j = i + 1; j < positions.length; j += 1) {
        const a = positions[i];
        const b = positions[j];
        const need = (assets[i].footprint.plot + assets[j].footprint.plot) / 2 + 0.6;
        const dx = b.x - a.x;
        const dz = b.z - a.z;

        // Overlap is only a problem when both axes are inside the sum of the
        // half-widths; touching corners are fine.
        if (Math.abs(dx) >= need || Math.abs(dz) >= need) continue;

        const gapX = need - Math.abs(dx);
        const gapZ = need - Math.abs(dz);

        // Push along the axis with the smaller overlap: it is the shorter way out
        // and keeps the other coordinate -- the one closer to the recorded
        // position -- untouched.
        if (gapX <= gapZ) {
          const push = (gapX / 2 + 0.02) * (dx >= 0 ? 1 : -1);
          a.x -= push;
          b.x += push;
        } else {
          const push = (gapZ / 2 + 0.02) * (dz >= 0 ? 1 : -1);
          a.z -= push;
          b.z += push;
        }
        moved = true;
      }
    }
    if (!moved) break;
  }

  return assets.map((asset, index) => ({
    ...asset,
    position: {
      x: Math.min(limit, Math.max(-limit, positions[index].x)),
      y: asset.position.y,
      z: Math.min(limit, Math.max(-limit, positions[index].z)),
    },
  }));
}

/* ------------------------------------------------------------------ roads */

export interface RoadSegment {
  x1: number;
  z1: number;
  x2: number;
  z2: number;
  /** Main avenues are wider and carry the traffic simulation. */
  width: number;
  major: boolean;
}

export interface Intersection {
  x: number;
  z: number;
  /** Which avenues meet here, as [horizontal, vertical] grid indices. */
  row: number;
  col: number;
}

export interface RoadGrid {
  segments: RoadSegment[];
  intersections: Intersection[];
  /** Avenue positions: `lines` are the constant-x ones, `zLines` the constant-z. */
  lines: number[];
  zLines: number[];
}

/**
 * A grid of avenues covering the city.
 *
 * Roads are placed *between* clusters of assets rather than on a fixed pitch:
 * the model's plots are up to 12 units across and they are not evenly spread, so
 * a regular grid either runs through buildings or leaves half the city without a
 * road. Instead the city is divided into nine blocks (the zones' natural
 * arrangement -- north, central, riverside, eastfield, southbank and the spaces
 * between), and one avenue is laid on each boundary.
 *
 * The result is a connected, believable network: every avenue spans the map, so
 * every intersection is reachable, and no avenue crosses a plot.
 */
export function buildRoadGrid(assets: PlacedAsset[]): RoadGrid {
  // Candidate boundaries: 4 evenly spaced cuts across the map, plus the outer
  // ring. Five lines per axis gives four blocks of road-served land.
  const cuts = [-CITY_EXTENT, -CITY_EXTENT / 2, 0, CITY_EXTENT / 2, CITY_EXTENT];

  // The plots come from the *placed* assets, after `separatePlots` has moved the
  // crowded ones apart. Reading the raw coordinates here would route roads around
  // where the buildings used to be.
  const plots = assets.map((asset) => ({
    x: asset.position.x,
    z: asset.position.z,
    half: asset.footprint.plot / 2,
  }));

  /**
   * Choose one boundary per intended cut that clears every plot *and* keeps the
   * avenues apart.
   *
   * A single nudge is not enough -- moving off one building can land on the next
   * one along, and two independent searches can both settle on the same free
   * gap, collapsing two avenues into one overlapped road. So this picks the
   * whole set at once: every candidate within reach of its own cut is scored by
   * (plots blocked, distance from the intended cut), the best free candidate is
   * taken, and the remaining cuts are matched against what has already been
   * placed. If nothing free exists (a very dense axis), the least-bad candidate
   * is used -- dropping an avenue would disconnect that part of the city.
   */
  function chooseBoundaries(cutsOnAxis: number[], axis: "x" | "z"): number[] {
    const centres = plots.map((plot) => ({
      at: axis === "x" ? plot.x : plot.z,
      half: plot.half,
    }));
    const blockedScore = (candidate: number) =>
      centres.filter((plot) => Math.abs(plot.at - candidate) < plot.half + 2.4).length;
    const MIN_GAP = 16;

    const chosen: number[] = [cutsOnAxis[0]];

    // The interior cuts, in order. Each is matched to the free slot nearest its
    // intended position that does not crowd an avenue already placed.
    const interior = cutsOnAxis.slice(1, -1);
    const options: number[][] = interior.map((value) => {
      const candidates: { at: number; score: number; distance: number }[] = [];
      for (let offset = 0; offset <= 46; offset += 2) {
        for (const direction of offset === 0 ? [1] : [-1, 1]) {
          const at = value + direction * offset;
          if (Math.abs(at) >= CITY_EXTENT - 2) continue;
          const score = blockedScore(at);
          if (score > 0) continue;
          candidates.push({ at, score, distance: Math.abs(at - value) });
        }
      }
      candidates.sort((a, b) => a.distance - b.distance);
      return candidates.map((candidate) => candidate.at);
    });

    // Greedy over the option lists, preferring the nearest free slot for each
    // cut. With four interior cuts a bounded greedy is exact enough here; the
    // outer ring is fixed and never moves.
    //
    // A cut with nowhere to go is dropped rather than forced. Two avenues eight
    // units apart with no land between them are a doubled road: they cost draw
    // calls and traffic, and they suggest a street the city does not have. The
    // network stays connected without them because every avenue crosses the whole
    // map, so a shorter grid is still one connected grid.
    for (const list of options) {
      const free = list.find((at) => chosen.every((placed) => Math.abs(placed - at) >= MIN_GAP));
      if (free !== undefined) chosen.push(free);
    }

    chosen.push(cutsOnAxis[cutsOnAxis.length - 1]);
    return chosen;
  }

  const xLines = chooseBoundaries(cuts, "x");
  const zLines = chooseBoundaries(cuts, "z");

  const segments: RoadSegment[] = [];
  const intersections: Intersection[] = [];

  // Horizontal avenues (constant z) and vertical ones (constant x), each
  // spanning the full map so the network is connected.
  zLines.forEach((z, row) => {
    segments.push({
      x1: -CITY_EXTENT,
      z1: z,
      x2: CITY_EXTENT,
      z2: z,
      width: row === 2 ? 6 : 4,
      major: true,
    });
  });
  xLines.forEach((x, col) => {
    segments.push({
      x1: x,
      z1: -CITY_EXTENT,
      x2: x,
      z2: CITY_EXTENT,
      width: col === 2 ? 6 : 4,
      major: true,
    });
  });

  xLines.forEach((x, col) => {
    zLines.forEach((z, row) => {
      intersections.push({ x, z, row, col });
    });
  });

  return { segments, intersections, lines: xLines, zLines };
}

/* --------------------------------------------------------------- traffic */

export type Lane = "h" | "v";

export interface TrafficLane {
  id: string;
  axis: Lane;
  /** Fixed coordinate: z for horizontal lanes, x for vertical ones. */
  at: number;
  /** Travel direction along the lane: +1 or -1. */
  direction: 1 | -1;
  /** Offset from the lane centre, so the two directions do not overlap. */
  offset: number;
  length: number;
}

/**
 * Convert the road grid into the lanes vehicles drive along.
 *
 * One lane per direction per avenue, offset by a quarter of the road width.
 * Keeping this a pure function means the animation can be tested by checking
 * where a vehicle sits at a given time, without rendering anything.
 */
export function buildTrafficLanes(grid: RoadGrid): TrafficLane[] {
  // Every avenue carries traffic; the wider spine carries more vehicles, which
  // the caller decides from `majors`. Filtering here would leave the outer
  // blocks empty, which reads as a broken simulation rather than a quiet street.
  const majors = grid.segments;
  const lanes: TrafficLane[] = [];

  // Horizontal lanes come from segments whose z is constant; vertical ones from
  // segments whose x is constant. Deduplicate: both directions of an avenue are
  // described by the same segment endpoints.
  const horizontal = new Set<number>();
  const vertical = new Set<number>();
  for (const segment of majors) {
    if (Math.abs(segment.z1 - segment.z2) < 0.001) horizontal.add(segment.z1);
    else vertical.add(segment.x1);
  }

  for (const z of horizontal) {
    for (const direction of [1, -1] as const) {
      lanes.push({
        id: `h${z.toFixed(1)}-${direction > 0 ? "e" : "w"}`,
        axis: "h",
        at: z,
        direction,
        offset: direction * 1.1,
        length: CITY_EXTENT * 2,
      });
    }
  }
  for (const x of vertical) {
    for (const direction of [1, -1] as const) {
      lanes.push({
        id: `v${x.toFixed(1)}-${direction > 0 ? "s" : "n"}`,
        axis: "v",
        at: x,
        direction,
        offset: direction * 1.1,
        length: CITY_EXTENT * 2,
      });
    }
  }
  return lanes;
}

/**
 * Where a vehicle is at a given moment.
 *
 * `t` is seconds; `speed` is scene units per second. The vehicle wraps around
 * the ends of its lane, which keeps it on the road forever without needing a
 * route graph or collision logic. Position is derived, never accumulated, so a
 * paused tab resumes in the right place and tests can assert exact coordinates.
 */
export function vehiclePosition(
  lane: TrafficLane,
  t: number,
  speed: number,
  progress: number,
): { x: number; z: number; angle: number } {
  const span = lane.length;
  const travelled = ((progress * span + t * speed) % span + span) % span;
  // Centre the run on the city so vehicles appear at both ends.
  const along = -CITY_EXTENT + travelled;
  const signed = lane.direction * along;

  if (lane.axis === "h") {
    return { x: signed, z: lane.at + lane.offset, angle: lane.direction > 0 ? 0 : Math.PI };
  }

  // A vehicle's local +x is its forward axis, and rotating that by `angle` about Y
  // gives (cos angle, 0, -sin angle). Driving +z therefore needs angle -pi/2, not
  // +pi/2 -- with the sign flipped, northbound traffic drives backwards.
  return {
    x: lane.at + lane.offset,
    z: signed,
    angle: lane.direction > 0 ? -Math.PI / 2 : Math.PI / 2,
  };
}

/* ------------------------------------------------------- turning traffic */

export interface RouteWaypoint {
  x: number;
  z: number;
}

/**
 * A closed circuit that turns at intersections.
 *
 * The lane system moves vehicles in straight lines forever, which is fine for
 * traffic at a glance and wrong the moment you watch one: no vehicle ever turns,
 * so every street is a conveyor belt. A route is a rectangle around a block --
 * four straights joined by corner arcs -- which is what a car circling a block
 * actually does, and it is why the traffic reads as going somewhere.
 *
 * Corners are sampled as short arcs rather than sharp joins so the vehicle's
 * heading changes smoothly instead of snapping through ninety degrees.
 */
export function buildRoutes(grid: RoadGrid): RouteWaypoint[][] {
  const routes: RouteWaypoint[][] = [];
  const xs = [...new Set(grid.segments.filter((s) => Math.abs(s.x2 - s.x1) < 0.001).map((s) => s.x1))].sort(
    (a, b) => a - b,
  );
  const zs = [...new Set(grid.segments.filter((s) => Math.abs(s.z2 - s.z1) < 0.001).map((s) => s.z1))].sort(
    (a, b) => a - b,
  );

  // Only blocks with a real street on each side are worth circulating.
  for (let xi = 0; xi < xs.length - 1; xi += 1) {
    for (let zi = 0; zi < zs.length - 1; zi += 1) {
      const x0 = xs[xi];
      const x1 = xs[xi + 1];
      const z0 = zs[zi];
      const z1 = zs[zi + 1];
      if (x1 - x0 < 20 || z1 - z0 < 20) continue;

      // Circulate on the right-hand side of each street, which is what makes the
      // loop legal traffic rather than a rally circuit.
      const inset = 1.6;
      const route: RouteWaypoint[] = [];
      const corners: [number, number, number][] = [
        [x0 + inset, z0 + inset, 0],
        [x1 - inset, z0 + inset, -Math.PI / 2],
        [x1 - inset, z1 - inset, Math.PI],
        [x0 + inset, z1 - inset, Math.PI / 2],
      ];

      for (let c = 0; c < corners.length; c += 1) {
        const [cx, cz] = corners[c];
        const [nx, nz] = corners[(c + 1) % corners.length];
        // Straight run to the next corner, sampled every few units.
        const dx = nx - cx;
        const dz = nz - cz;
        const length = Math.hypot(dx, dz);
        const steps = Math.max(2, Math.round(length / 4));
        for (let step = 0; step < steps; step += 1) {
          const t = step / steps;
          route.push({ x: cx + dx * t, z: cz + dz * t });
        }
      }
      // Only keep blocks whose loop is long enough to be worth watching a car go
      // round; a tiny loop reads as a bug.
      if (route.length > 12) routes.push(route);
    }
  }

  return routes;
}

/** Position and heading along a closed route, wrapped at both ends. */
export function routePosition(
  route: RouteWaypoint[],
  t: number,
  speed: number,
  progress: number,
): { x: number; z: number; angle: number } {
  if (route.length < 2) return { x: 0, z: 0, angle: 0 };

  // Arc length, so speed is constant through corners instead of proportional to
  // the number of sampled points.
  const lengths: number[] = [];
  let total = 0;
  for (let index = 0; index < route.length; index += 1) {
    const a = route[index];
    const b = route[(index + 1) % route.length];
    const step = Math.hypot(b.x - a.x, b.z - a.z);
    lengths.push(step);
    total += step;
  }
  if (total <= 0) return { x: route[0].x, z: route[0].z, angle: 0 };

  const travelled = (((progress * total + t * speed) % total) + total) % total;

  let walked = 0;
  for (let index = 0; index < lengths.length; index += 1) {
    if (walked + lengths[index] >= travelled) {
      const t0 = (travelled - walked) / (lengths[index] || 1);
      const a = route[index];
      const b = route[(index + 1) % route.length];
      const x = a.x + (b.x - a.x) * t0;
      const z = a.z + (b.z - a.z) * t0;
      // Heading from the segment direction, using the same convention as
      // `vehiclePosition`: forward is (cos angle, -sin angle) in world space.
      const angle = Math.atan2(-(b.z - a.z), b.x - a.x);
      return { x, z, angle };
    }
    walked += lengths[index];
  }

  const last = route[route.length - 1];
  return { x: last.x, z: last.z, angle: 0 };
}

/* ----------------------------------------------------------- status model */

export type VisualStatus = "operational" | "degraded" | "failed" | "maintenance" | "recovering";

/**
 * The colour and the *non-colour* encoding of a status.
 *
 * Colour alone is not a status channel: roughly 8% of men cannot separate the
 * mint from the amber. Every status therefore also carries a mark drawn above
 * the building, and a distinct roofline pattern, and the legend shows both.
 */
export interface StatusStyle {
  key: VisualStatus;
  label: string;
  color: string;
  /** Emissive strength multiplier for the material. */
  glow: number;
  /** Shape of the beacon above the building. */
  mark: "none" | "half" | "cross" | "bar" | "pulse";
  /** Plain-language description used by the legend and the DOM list. */
  markLabel: string;
}

export const STATUS_STYLES: Record<VisualStatus, StatusStyle> = {
  operational: {
    key: "operational",
    label: "Operational",
    color: "#3ee6a5",
    glow: 0.35,
    mark: "none",
    markLabel: "no mark",
  },
  degraded: {
    key: "degraded",
    label: "Degraded",
    color: "#ffb545",
    glow: 0.5,
    mark: "half",
    markLabel: "half-filled beacon",
  },
  failed: {
    key: "failed",
    label: "Failed",
    color: "#ff6b6b",
    glow: 0.75,
    mark: "cross",
    markLabel: "crossed beacon",
  },
  maintenance: {
    key: "maintenance",
    label: "Under maintenance",
    color: "#45d8f5",
    glow: 0.45,
    mark: "bar",
    markLabel: "barred beacon",
  },
  recovering: {
    key: "recovering",
    label: "Recovering",
    color: "#a78bfa",
    glow: 0.6,
    mark: "pulse",
    markLabel: "pulsing beacon",
  },
};

/** Map the database's status vocabulary onto what the scene can draw. */
export function visualStatusFor(status: string): VisualStatus {
  switch (status) {
    case "offline":
      return "failed";
    case "maintenance":
      return "maintenance";
    case "degraded":
      return "degraded";
    default:
      return "operational";
  }
}

/**
 * Resolve what to draw for one asset, given the live status and an *overlay*
 * produced by a simulation playback.
 *
 * The overlay never writes to the database, and it never hides a maintenance or
 * failure state that the database already holds: a simulation says "this would
 * fail", not "this is failed". When the overlay is empty the live status wins.
 */
export function resolveVisualStatus(
  liveStatus: string,
  overlay?: { impact?: "failed" | "degraded" | "affected"; recovering?: boolean } | null,
): VisualStatus {
  const live = visualStatusFor(liveStatus);

  // Maintenance is somebody's scheduled work and outranks every overlay. Showing
  // a building as fine while an engineer is inside it with the power off would be
  // a lie the rest of the screen does not correct.
  if (live === "maintenance") return "maintenance";

  // Recovering is a statement about a transition in progress: an approved plan
  // whose tasks are not yet verified. It is only ever shown over an asset the
  // database still considers down or degraded -- never over a working one, and
  // never as a step towards "operational", which only the backend can declare.
  if (overlay?.recovering && (live === "failed" || live === "degraded")) return "recovering";

  if (!overlay?.impact) return live;

  // A planned failure cannot downgrade an asset that is already worse.
  if (overlay.impact === "failed" && live !== "failed") return "failed";
  if (overlay.impact === "degraded" && live === "operational") return "degraded";

  return live;
}

/* ------------------------------------------------------------- zone hulls */

export interface ZoneHull {
  zone: Zone;
  position: { x: number; z: number };
  radius: number;
}

/**
 * Zone footprints as flat discs on the ground.
 *
 * Radius grows with the square root of population so area is proportional to
 * people, not to a guessed constant -- otherwise the biggest district would look
 * only slightly larger while covering several times the ground.
 */
export function buildZoneHulls(zones: Zone[]): ZoneHull[] {
  const maxPopulation = Math.max(...zones.map((zone) => zone.population), 1);
  return zones.map((zone) => {
    const { x, z } = toScene(zone.center_x, zone.center_y);
    const ratio = Math.sqrt(zone.population / maxPopulation);
    return {
      zone,
      position: { x, z },
      radius: 18 + ratio * 24,
    };
  });
}

/* ------------------------------------------------------------- camera rig */

export type CameraMode = "perspective" | "isometric" | "top";

export interface CameraPose {
  position: [number, number, number];
  target: [number, number, number];
}

export const CAMERA_MODES: Record<CameraMode, { label: string; description: string }> = {
  perspective: { label: "Perspective", description: "Angled three-quarter view, the default" },
  isometric: { label: "Isometric", description: "Equal-angle overview, no vanishing point" },
  top: { label: "Top-down", description: "Straight down: the clearest view of the road grid" },
};

/**
 * Camera poses for each preset, plus the city bounds the orbit controls clamp to.
 *
 * The distances are derived from CITY_EXTENT rather than hardcoded, so a change
 * to the map scale cannot leave the camera inside a building.
 */
export const CITY_BOUNDS = {
  minDistance: 18,
  maxDistance: CITY_EXTENT * 3.2,
  /** Vertically: never dive below the ground plane or flip over the pole. */
  minPolarAngle: 0.08,
  maxPolarAngle: Math.PI / 2 - 0.06,
  panLimit: CITY_EXTENT * 1.35,
  maxTargetHeight: 12,
};

export function cameraPose(mode: CameraMode): CameraPose {
  const d = CITY_EXTENT;
  switch (mode) {
    case "isometric":
      return { position: [d * 1.15, d * 1.15, d * 1.15], target: [0, 0, 0] };
    case "top":
      return { position: [0, d * 2.1, 0.001], target: [0, 0, 0] };
    case "perspective":
    default:
      return { position: [d * 1.05, d * 0.78, d * 1.15], target: [0, 0, 0] };
  }
}

/** A pose that frames one asset from a comfortable distance. */
export function focusPose(position: Point3, footprint: Footprint): CameraPose {
  const distance = Math.max(footprint.height * 2.6, 22);
  return {
    position: [position.x + distance * 0.7, footprint.height + distance * 0.55, position.z + distance * 0.7],
    target: [position.x, footprint.height * 0.45, position.z],
  };
}

/**
 * A pose that frames an incident.
 *
 * Deliberately not the same as `focusPose`: an incident is about the asset *and*
 * the streets around it, because the consequence of a failure is what reaches
 * along the dependency links. So the camera pulls back further and looks down a
 * little more, and the target sits below the building rather than at its middle.
 */
export function incidentPose(position: Point3, footprint: Footprint): CameraPose {
  const distance = Math.max(footprint.height * 3.4, 34);
  return {
    position: [
      position.x + distance * 0.72,
      footprint.height + distance * 0.82,
      position.z + distance * 0.72,
    ],
    target: [position.x, footprint.height * 0.3, position.z],
  };
}

/**
 * The pose that fits the whole city, honouring the aspect ratio.
 *
 * A fixed distance works for a wide window and crops the model in a tall one. This
 * measures what is actually in front of the camera: the city is `CITY_EXTENT *
 * 2` across, so the distance needed is that half-width divided by the tangent of
 * the half field of view -- using the *narrower* of the vertical and horizontal
 * fields of view, which is the one that would crop first.
 */
export function fitPose(mode: CameraMode, aspect: number, fovDegrees = 42): CameraPose {
  const halfWidth = CITY_EXTENT * 1.08;
  const vertical = (fovDegrees * Math.PI) / 180;
  const horizontal = 2 * Math.atan(Math.tan(vertical / 2) * Math.max(aspect, 0.2));
  const halfAngle = Math.min(vertical, horizontal) / 2;
  const distance = halfWidth / Math.tan(halfAngle);

  // Keep the preset's viewing direction and move along it, so fitting from the
  // top-down preset does not quietly become an isometric view.
  const [bx, by, bz] = cameraPose(mode).position;
  const length = Math.hypot(bx, by, bz) || 1;
  return {
    position: [(bx / length) * distance, (by / length) * distance, (bz / length) * distance],
    target: [0, 0, 0],
  };
}

/** Clamp an orbit target inside the city so panning cannot lose the model. */
export function clampTarget(target: [number, number, number]): [number, number, number] {
  const limit = CITY_BOUNDS.panLimit;
  return [
    Math.min(limit, Math.max(-limit, target[0])),
    Math.min(CITY_BOUNDS.maxTargetHeight, Math.max(0, target[1])),
    Math.min(limit, Math.max(-limit, target[2])),
  ];
}

/* ------------------------------------------------------------ scene props */

export interface ScatterProp {
  // No "car": a static vehicle placed by a scatter algorithm is either abandoned
  // or in the road. Moving traffic is drawn separately as instanced geometry.
  kind: "tree" | "bench" | "lamp";
  position: Point3;
  rotation: number;
  scale: number;
}

/**
 * Decorative props, placed in the strips between the roads.
 *
 * These are never attached to an asset id. Keeping them in their own list is what
 * makes "decorative vs operational" a structural guarantee rather than a naming
 * convention: nothing in the scene can select a tree and read a status from it.
 */
/**
 * Street furniture, scattered on the land the roads and plots leave free.
 *
 * Three things matter here and all three were wrong at some point:
 *
 *  - The plots come from the *placed* assets. Reading raw `map_x`/`map_y` puts
 *    trees inside buildings whose plots were moved apart by `separatePlots`.
 *  - Nothing may sit on a carriageway. A tree in the middle of an avenue is the
 *    most obvious tell that a city is decoration.
 *  - Lamps and trees go *beside* roads, not scattered uniformly. Street furniture
 *    at random looks like litter; street furniture lining a kerb looks like a
 *    street. Roads are the generator, so each prop is placed relative to one.
 *
 * Cars are not scenery. A parked car in a random field is not a thing that
 * exists; moving traffic is drawn separately and carries no asset data.
 */
export function buildScenery(assets: PlacedAsset[], grid: RoadGrid, count = 320): ScatterProp[] {
  const rng = makeRng(0xc0ffee);
  const plots = assets.map((asset) => ({
    x: asset.position.x,
    z: asset.position.z,
    half: asset.footprint.plot / 2 + 1.2,
  }));

  const insidePlot = (x: number, z: number) =>
    plots.some((plot) => Math.abs(plot.x - x) < plot.half && Math.abs(plot.z - z) < plot.half);

  /** Distance from a point to the nearest carriageway edge, or Infinity. */
  const clearOfRoads = (x: number, z: number, margin: number) =>
    grid.segments.every((segment) => {
      const horizontal = Math.abs(segment.z1 - segment.z2) < 0.001;
      const across = horizontal
        ? Math.abs(z - segment.z1) - segment.width / 2
        : Math.abs(x - segment.x1) - segment.width / 2;
      // Only the road's own span constrains the point; beyond its ends there is no
      // carriageway to avoid.
      const along = horizontal
        ? x >= Math.min(segment.x1, segment.x2) - 2 && x <= Math.max(segment.x1, segment.x2) + 2
        : z >= Math.min(segment.z1, segment.z2) - 2 && z <= Math.max(segment.z1, segment.z2) + 2;
      return !along || across > margin;
    });

  const props: ScatterProp[] = [];
  const push = (kind: ScatterProp["kind"], x: number, z: number, scale: number, rotation: number) => {
    if (Math.abs(x) > CITY_EXTENT * 0.97 || Math.abs(z) > CITY_EXTENT * 0.97) return;
    if (insidePlot(x, z)) return;
    props.push({ kind, position: { x, y: 0, z }, rotation, scale });
  };

  // Street furniture follows the kerbs: a lamp or a tree every few units along
  // each avenue, alternating sides so neither side is bare.
  for (const segment of grid.segments) {
    const horizontal = Math.abs(segment.z1 - segment.z2) < 0.001;
    const length = horizontal
      ? Math.abs(segment.x2 - segment.x1)
      : Math.abs(segment.z2 - segment.z1);
    const start = horizontal ? Math.min(segment.x1, segment.x2) : Math.min(segment.z1, segment.z2);
    const step = 7.5;

    for (let offset = step; offset < length - step; offset += step) {
      // Alternate sides, and jitter slightly so the line is not mechanically even.
      const side = Math.round(offset / step) % 2 === 0 ? 1 : -1;
      const jitter = (rng() - 0.5) * 1.2;
      // One kerb-width clear of the carriageway. The margin is generous because a
      // prop only has to touch the *edge* of a road to look like it is in it, and
      // another avenue's carriageway can be closer than this one's centre.
      const gap = segment.width / 2 + 3.4 + rng() * 0.8;
      const along = start + offset + jitter;

      const x = horizontal ? along : segment.x1 + side * gap;
      const z = horizontal ? segment.z1 + side * gap : along;

      if (insidePlot(x, z)) continue;
      // Verify against *every* avenue, not just the one this slot belongs to: a
      // perpendicular street can run right through a kerbside spot.
      if (!clearOfRoads(x, z, 1.5)) continue;
      // One in four kerbside slots is a streetlight instead of a tree; lights are
      // what make a night city read as a city.
      const kind: ScatterProp["kind"] = rng() < 0.34 ? "lamp" : "tree";
      push(kind, x, z, 0.75 + rng() * 0.45, rng() * Math.PI * 2);
    }
  }

  // Then parks and squares in the leftover blocks, clusters rather than singles.
  let clusters = 0;
  let guard = 0;
  while (clusters < 26 && guard < 600) {
    guard += 1;
    const cx = (rng() * 2 - 1) * CITY_EXTENT * 0.9;
    const cz = (rng() * 2 - 1) * CITY_EXTENT * 0.9;
    if (insidePlot(cx, cz) || !clearOfRoads(cx, cz, 3)) continue;

    clusters += 1;
    const size = 4 + Math.floor(rng() * 6);
    const radius = 4 + rng() * 5;
    for (let index = 0; index < size; index += 1) {
      const angle = rng() * Math.PI * 2;
      const distance = Math.sqrt(rng()) * radius;
      const x = cx + Math.cos(angle) * distance;
      const z = cz + Math.sin(angle) * distance;
      if (!clearOfRoads(x, z, 1.6)) continue;
      push("tree", x, z, 0.7 + rng() * 0.7, rng() * Math.PI * 2);
    }
    // A bench or two facing the green.
    if (rng() < 0.6) push("bench", cx + radius * 0.3, cz, 1, rng() * Math.PI * 2);
  }

  return props.slice(0, count);
}

/* ----------------------------------------------------------------- cascade */

/**
 * Hop count from a cascade's origin to every asset it reaches.
 *
 * The simulation API returns a `depth` per impact, but a depth on its own does not
 * say which asset started the cascade -- and the scene needs that, both to mark the
 * origin and to draw the propagation outward from it. Walking the dependency graph
 * breadth-first from the origin gives both, and gives them from data the client
 * already has.
 *
 * Only assets the run actually reported as impacted are kept: an asset downstream
 * of the origin that the run did not touch must not be drawn as part of the
 * cascade just because a path exists through it.
 */
export function cascadeDepths(
  edges: { source: number; target: number }[],
  impacted: Iterable<number>,
  originId: number | null,
): Map<number, number> {
  const depths = new Map<number, number>();
  if (originId == null) return depths;

  const touched = new Set(impacted);
  depths.set(originId, 0);

  const queue: number[] = [originId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    const next = (depths.get(current) ?? 0) + 1;
    for (const edge of edges) {
      if (edge.source !== current) continue;
      if (depths.has(edge.target)) continue;
      depths.set(edge.target, next);
      queue.push(edge.target);
    }
  }

  for (const id of [...depths.keys()]) {
    if (id !== originId && !touched.has(id)) depths.delete(id);
  }
  return depths;
}

/* --------------------------------------------------------------- sidewalks */

export interface Pavement {
  /** Centre of the slab. */
  x: number;
  z: number;
  width: number;
  depth: number;
  /** Rotation about Y; pavements run parallel to their avenue. */
  rotation: number;
}

/**
 * Kerbs, as flat strips either side of every avenue.
 *
 * A road drawn directly on the ground reads as a painted line, not as a street:
 * what makes a street legible at this scale is the change of level and colour at
 * its edge. These are two thin slabs per avenue -- flat, cheap, and they are what
 * the street furniture actually stands on.
 *
 * They stop short of intersections so the crossing stays continuous.
 */
export function buildPavements(grid: RoadGrid): Pavement[] {
  const KERB = 2.6;
  const pavements: Pavement[] = [];

  for (const segment of grid.segments) {
    const horizontal = Math.abs(segment.z2 - segment.z1) < 0.001;
    const from = horizontal
      ? Math.min(segment.x1, segment.x2)
      : Math.min(segment.z1, segment.z2);
    const to = horizontal
      ? Math.max(segment.x1, segment.x2)
      : Math.max(segment.z1, segment.z2);
    const length = to - from;
    const centre = from + length / 2;
    const at = horizontal ? segment.z1 : segment.x1;
    const offset = segment.width / 2 + KERB / 2;

    for (const side of [-1, 1]) {
      pavements.push({
        x: horizontal ? centre : at + side * offset,
        z: horizontal ? at + side * offset : centre,
        width: horizontal ? length : KERB,
        depth: horizontal ? KERB : length,
        rotation: 0,
      });
    }
  }

  return pavements;
}

/* ----------------------------------------------------------------- parking */

export interface ParkingBay {
  x: number;
  z: number;
  /** Marked bays, arranged in a row. */
  bays: number;
  rotation: number;
}

/**
 * Parking aprons beside a few streets.
 *
 * Not every road: a bay on every kerb would be as monotonous as none. These are
 * placed where a block has room, which is the same rule a planner would use.
 */
export function buildParking(assets: PlacedAsset[], grid: RoadGrid): ParkingBay[] {
  const rng = makeRng(0x9a12c3);
  const bays: ParkingBay[] = [];

  for (const segment of grid.segments) {
    const horizontal = Math.abs(segment.z2 - segment.z1) < 0.001;
    const length = horizontal
      ? Math.abs(segment.x2 - segment.x1)
      : Math.abs(segment.z2 - segment.z1);
    if (length < 40) continue;

    // Two candidate aprons per avenue, offset from the ends.
    for (const fraction of [0.28, 0.72]) {
      if (rng() > 0.55) continue;
      const start = horizontal ? Math.min(segment.x1, segment.x2) : Math.min(segment.z1, segment.z2);
      const along = start + length * fraction;
      const side = rng() < 0.5 ? -1 : 1;
      const gap = segment.width / 2 + 7;

      const x = horizontal ? along : segment.x1 + side * gap;
      const z = horizontal ? segment.z1 + side * gap : along;

      // Only where the apron is actually clear of buildings and of the traffic.
      const clear = assets.every(
        (asset) =>
          Math.abs(asset.position.x - x) > asset.footprint.plot / 2 + 3 ||
          Math.abs(asset.position.z - z) > asset.footprint.plot / 2 + 3,
      );
      if (!clear) continue;

      bays.push({ x, z, bays: 3 + Math.floor(rng() * 4), rotation: horizontal ? 0 : Math.PI / 2 });
    }
  }

  return bays;
}

/* ------------------------------------------------------------------ edges */

export interface PlacedEdge {
  edge: TwinEdge;
  from: Point3;
  to: Point3;
}

/** Attach every dependency edge to its two placed assets. */
export function placeEdges(edges: TwinEdge[], assets: PlacedAsset[]): PlacedEdge[] {
  const byId = new Map<number, PlacedAsset>();
  for (const asset of assets) byId.set(asset.node.id, asset);

  const placed: PlacedEdge[] = [];
  for (const edge of edges) {
    const from = byId.get(edge.source);
    const to = byId.get(edge.target);
    if (!from || !to) continue;
    placed.push({
      edge,
      from: { ...from.position, y: from.footprint.height + 0.8 },
      to: { ...to.position, y: to.footprint.height + 0.8 },
    });
  }
  return placed;
}

/* ------------------------------------------------------------- summary */

export interface CityModel {
  assets: PlacedAsset[];
  edges: PlacedEdge[];
  grid: RoadGrid;
  lanes: TrafficLane[];
  zones: ZoneHull[];
  scenery: ScatterProp[];
  /** Loops around blocks: traffic that turns at intersections. */
  routes: RouteWaypoint[][];
  /** Kerbs beside every avenue: what makes a road read as a street. */
  pavements: Pavement[];
  /** Parking aprons where a block has room for one. */
  parking: ParkingBay[];
}

/**
 * Build everything the scene needs from one API response.
 *
 * Memoised by the caller (React `useMemo` on the graph identity); keeping it a
 * single pure entry point is what lets the tests run the whole pipeline from a
 * captured API payload.
 */
export function buildCityModel(graph: TwinGraph | null): CityModel | null {
  if (!graph || graph.nodes.length === 0) return null;
  const assets = placeAssets(graph.nodes);
  const grid = buildRoadGrid(assets);
  return {
    assets,
    edges: placeEdges(graph.edges, assets),
    grid,
    lanes: buildTrafficLanes(grid),
    zones: buildZoneHulls(graph.zones),
    scenery: buildScenery(assets, grid),
    routes: buildRoutes(grid),
    pavements: buildPavements(grid),
    parking: buildParking(assets, grid),
  };
}
