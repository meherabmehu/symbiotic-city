"use client";

/**
 * The living parts of the city: ground, roads, traffic, dependency links and the
 * zone discs.
 *
 * Everything that moves is derived from `clock` by a pure function in
 * `city-model.ts`, so:
 *
 *  - the traffic simulation cannot drift, pause incorrectly, or depend on frame
 *    rate (a stalled tab resumes at the right place);
 *  - it can be tested without a GPU (`vehiclePosition` is measured in the unit
 *    tests);
 *  - decorative movement is obviously decorative -- no vehicle carries an asset
 *    id, so nothing animated can be mistaken for operational data.
 */

import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import {
  CITY_EXTENT,
  routePosition,
  vehiclePosition,
  type CityModel,
  type ParkingBay,
  type Pavement,
  type PlacedEdge,
  type TrafficLane,
  type ZoneHull,
} from "@/lib/city-model";

/* ------------------------------------------------------------------ ground */

export function Ground({ reducedTexture = false }: { reducedTexture?: boolean }) {
  return (
    <group>
      {/* The base plate. Slightly larger than the city so the edge is not visible
          from the default camera. */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.02, 0]} receiveShadow>
        <planeGeometry args={[CITY_EXTENT * 2.6, CITY_EXTENT * 2.6]} />
        <meshStandardMaterial color="#0a1424" roughness={0.95} metalness={0.05} />
      </mesh>

      {/* Parkland ring: a lighter plate inset from the edge, so the city sits in
          a green belt rather than floating on a dark plane. Skipped entirely in
          reduced mode -- it is the largest single surface. */}
      {reducedTexture ? null : (
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.01, 0]}>
          <planeGeometry args={[CITY_EXTENT * 2.05, CITY_EXTENT * 2.05]} />
          <meshStandardMaterial color="#102235" roughness={0.92} />
        </mesh>
      )}
    </group>
  );
}

/* ------------------------------------------------------------------- roads */

/**
 * Roads, drawn as flat quads.
 *
 * One mesh per avenue rather than per tile: ten avenues in the current layout, so
 * ten draw calls for the whole network. Lane markings are skipped -- at the
 * camera distances this is used at they cost fill rate and add nothing, and the
 * traffic itself communicates direction.
 */
export function Roads({ model }: { model: CityModel }) {
  const segments = model.grid?.segments ?? [];
  const intersections = model.grid?.intersections ?? [];
  const geometry = useMemo(() => {
    return segments.map((segment) => {
      const length =
        Math.abs(segment.x2 - segment.x1) > 0.001
          ? Math.abs(segment.x2 - segment.x1)
          : Math.abs(segment.z2 - segment.z1);
      return { segment, length };
    });
  }, [segments]);

  return (
    <group>
      {geometry.map(({ segment, length }, index) => {
        const horizontal = Math.abs(segment.z2 - segment.z1) < 0.001;
        return (
          <mesh
            key={index}
            rotation={[-Math.PI / 2, 0, 0]}
            position={[
              (segment.x1 + segment.x2) / 2,
              0.01,
              (segment.z1 + segment.z2) / 2,
            ]}
          >
            <planeGeometry args={[horizontal ? length : segment.width, horizontal ? segment.width : length]} />
            <meshStandardMaterial
              color={segment.major ? "#24405f" : "#1b324c"}
              roughness={0.85}
              metalness={0.15}
            />
          </mesh>
        );
      })}

      {/* Intersection pads, slightly brighter, which is what makes the grid read
          as a street network instead of crossing stripes. */}
      {intersections.map((point, index) => (
        <mesh key={`i${index}`} rotation={[-Math.PI / 2, 0, 0]} position={[point.x, 0.015, point.z]}>
          <planeGeometry args={[6.5, 6.5]} />
          <meshStandardMaterial color="#2c4b6d" roughness={0.8} />
        </mesh>
      ))}
    </group>
  );
}

/* ----------------------------------------------------------------- traffic */

const VEHICLES_PER_LANE = 3;

/**
 * Moving traffic.
 *
 * Vehicles are instanced: one `InstancedMesh` for all of them, so the count can
 * rise without touching the draw-call budget. Each frame updates instance
 * matrices from the pure position function -- no per-vehicle React state, which
 * is what keeps this at 60fps on a laptop.
 */
export function Traffic({
  model,
  enabled,
  speed = 9,
}: {
  model: CityModel;
  enabled: boolean;
  speed?: number;
}) {
  const meshRef = useRef<THREE.InstancedMesh | null>(null);
  const dummy = useMemo(() => new THREE.Object3D(), []);

  /**
   * The fleet: three vehicles on each turning route, and a couple on each straight
   * lane for the avenues the block loops do not cover.
   *
   * Routes come first so that most of what you see is turning at intersections;
   * straight lanes fill in the outer streets. Every slot's phase is fixed, so the
   * same fleet appears on every mount and on every reload.
   */
  const slots = useMemo(() => {
    const list: {
      kind: "route" | "lane";
      route?: { x: number; z: number }[];
      lane?: TrafficLane;
      length: number;
      progress: number;
      /** Seconds of travel offset, so the whole fleet is not one solid block. */
      phase: number;
    }[] = [];

    model.routes.forEach((route, routeIndex) => {
      const count = 3;
      for (let i = 0; i < count; i += 1) {
        list.push({
          kind: "route",
          route,
          length: route.length,
          progress: 0,
          phase: (i / count + routeIndex * 0.37) % 1,
        });
      }
    });

    model.lanes.forEach((lane, laneIndex) => {
      for (let i = 0; i < 2; i += 1) {
        list.push({
          kind: "lane",
          lane,
          length: lane.length,
          progress: (i / 2 + laneIndex * 0.21) % 1,
          phase: 0,
        });
      }
    });

    return list;
  }, [model.routes, model.lanes]);

  const total = slots.length;

  // A constant clock, advanced in the frame loop and clamped so a backgrounded tab
  // does not teleport the whole fleet on resume.
  const clock = useRef(0);

  useEffect(() => {
    // Place the fleet before the first frame; otherwise every instance sits at the
    // identity matrix, stacked at the origin.
    const mesh = meshRef.current;
    if (!mesh) return;
    slots.forEach((slot, index) => {
      const pose =
        slot.kind === "route" && slot.route
          ? routePosition(slot.route, clock.current, speed, slot.phase)
          : vehiclePosition(slot.lane!, clock.current, speed, slot.progress);
      dummy.position.set(pose.x, 0.55, pose.z);
      dummy.rotation.set(0, pose.angle, 0);
      dummy.updateMatrix();
      mesh.setMatrixAt(index, dummy.matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
  }, [slots, dummy, speed]);

  useFrame((_, delta) => {
    const mesh = meshRef.current;
    if (!mesh || !enabled) return;
    clock.current += Math.min(delta, 0.1);

    slots.forEach((slot, index) => {
      const pose =
        slot.kind === "route" && slot.route
          ? routePosition(slot.route, clock.current, speed, slot.phase)
          : vehiclePosition(slot.lane!, clock.current, speed, slot.progress);
      dummy.position.set(pose.x, 0.55, pose.z);
      dummy.rotation.set(0, pose.angle, 0);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      mesh.setMatrixAt(index, dummy.matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
  });

  if (!enabled) return null;

  return (
    <instancedMesh ref={meshRef} args={[undefined, undefined, total]} castShadow={false}>
      {/* A car body with a cabin is two boxes; at this scale one rounded box reads
          fine and stays a single instanced draw call. */}
      <boxGeometry args={[1.9, 0.65, 1.0]} />
      <meshStandardMaterial color="#8fd0ff" emissive="#3ea8ff" emissiveIntensity={0.45} roughness={0.45} metalness={0.4} />
    </instancedMesh>
  );
}

/**
 * Emergency vehicles: the ones you would actually see going somewhere.
 *
 * They follow the same turning routes as ordinary traffic but faster, and they
 * carry a flashing light bar. The number is driven by live incidents -- one ambulance
 * per active incident, capped -- so a quiet city has none and a bad afternoon has
 * several. That is the difference between decoration and telemetry: nothing here
 * moves *because* of an incident, but whether these exist at all is read from it.
 */
export function EmergencyTraffic({
  model,
  enabled,
  incidents,
}: {
  model: CityModel;
  enabled: boolean;
  /** Active incidents, which decide how many vehicles respond. */
  incidents: number;
}) {
  const meshRef = useRef<THREE.InstancedMesh | null>(null);
  const lampRef = useRef<THREE.InstancedMesh | null>(null);
  const lampMaterial = useRef<THREE.MeshStandardMaterial | null>(null);
  const dummy = useMemo(() => new THREE.Object3D(), []);
  const clock = useRef(0);
  const flashing = useRef(0);

  const count = Math.min(6, Math.max(0, incidents));

  const slots = useMemo(
    () =>
      model.routes.slice(0, count).map((route, index) => ({
        route,
        phase: (index * 0.31) % 1,
      })),
    [model.routes, count],
  );

  useFrame((_, delta) => {
    const mesh = meshRef.current;
    const lamps = lampRef.current;
    if (!mesh || !enabled) return;

    clock.current += Math.min(delta, 0.1);
    // Faster than the flow they are moving through, which is the only way an
    // emergency vehicle reads as responding rather than cruising.
    const speed = 17;

    slots.forEach((slot, index) => {
      const pose = routePosition(slot.route, clock.current, speed, slot.phase);
      dummy.position.set(pose.x, 0.6, pose.z);
      dummy.rotation.set(0, pose.angle, 0);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      mesh.setMatrixAt(index, dummy.matrix);

      if (lamps) {
        // The bar sits above the cabin, offset along the vehicle's forward axis.
        dummy.position.set(
          pose.x + Math.cos(pose.angle) * 0.1,
          1.05,
          pose.z - Math.sin(pose.angle) * 0.1,
        );
        dummy.rotation.set(0, pose.angle, 0);
        dummy.updateMatrix();
        lamps.setMatrixAt(index, dummy.matrix);
      }
    });

    mesh.instanceMatrix.needsUpdate = true;
    if (lamps) lamps.instanceMatrix.needsUpdate = true;

    // Flashing at roughly the rate a light bar actually flashes.
    flashing.current += delta;
    const material = lampMaterial.current;
    if (material) {
      const on = Math.sin(flashing.current * Math.PI * 2.4) > 0;
      material.emissiveIntensity = on ? 2.2 : 0.25;
    }
  });

  // Place the fleet once so it is not at the origin before the first frame.
  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    slots.forEach((slot, index) => {
      const pose = routePosition(slot.route, clock.current, 17, slot.phase);
      dummy.position.set(pose.x, 0.6, pose.z);
      dummy.rotation.set(0, pose.angle, 0);
      dummy.updateMatrix();
      mesh.setMatrixAt(index, dummy.matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
  }, [slots, dummy]);

  if (!enabled || slots.length === 0) return null;

  return (
    <group>
      <instancedMesh ref={meshRef} args={[undefined, undefined, slots.length]}>
        <boxGeometry args={[2.1, 0.75, 1.05]} />
        <meshStandardMaterial color="#f2f6ff" emissive="#20304a" emissiveIntensity={0.2} roughness={0.4} metalness={0.3} />
      </instancedMesh>
      <instancedMesh ref={lampRef} args={[undefined, undefined, slots.length]}>
        <boxGeometry args={[0.9, 0.16, 0.3]} />
        <meshStandardMaterial ref={lampMaterial} color="#ff5d5d" emissive="#ff3d3d" emissiveIntensity={2} />
      </instancedMesh>
    </group>
  );
}

/**
 * Traffic signals at the junctions.
 *
 * Two lamps per approach on the diagonal corners, so the junction reads as
 * signalised from any angle. The lamp colour cycles on a fixed period rather than
 * reacting to the traffic: the vehicles are decoration and do not stop, so a
 * signal that responded to them would be a simulation of something that is not
 * happening. It cycles because a city's lights visibly cycle, and that is the
 * whole claim being made.
 */
export function TrafficSignals({ model, enabled }: { model: CityModel; enabled: boolean }) {
  const meshRef = useRef<THREE.InstancedMesh | null>(null);
  const materialRef = useRef<THREE.MeshStandardMaterial | null>(null);
  const dummy = useMemo(() => new THREE.Object3D(), []);

  // Four signal heads per junction: two along each axis, on opposite corners.
  const heads = useMemo(
    () =>
      model.grid.intersections.flatMap((point) => [
        { x: point.x + 4.2, z: point.z + 4.2 },
        { x: point.x - 4.2, z: point.z - 4.2 },
        { x: point.x + 4.2, z: point.z - 4.2 },
        { x: point.x - 4.2, z: point.z + 4.2 },
      ]),
    [model.grid.intersections],
  );

  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    heads.forEach((head, index) => {
      dummy.position.set(head.x, 2.4, head.z);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      mesh.setMatrixAt(index, dummy.matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
  }, [heads, dummy]);

  useFrame(({ clock }) => {
    const material = materialRef.current;
    if (!material || !enabled) return;
    // 9-second cycle: long enough to notice, short enough to see all three phases
    // without waiting. The emissive colour is what changes, so it costs no geometry.
    const phase = (clock.elapsedTime % 9) / 9;
    const colour = phase < 0.45 ? "#37e08a" : phase < 0.52 ? "#ffc24d" : "#ff5d5d";
    material.emissive.set(colour);
    material.color.set(colour);
  });

  if (!enabled || heads.length === 0) return null;

  return (
    <instancedMesh ref={meshRef} args={[undefined, undefined, heads.length]}>
      <boxGeometry args={[0.4, 0.55, 0.4]} />
      <meshStandardMaterial ref={materialRef} color="#37e08a" emissive="#37e08a" emissiveIntensity={1.1} roughness={0.4} />
    </instancedMesh>
  );
}

/**
 * Lane markings and zebra crossings.
 *
 * One instanced mesh for the dashes down the middle of every avenue and one for the
 * crossing bars at each junction. Painted rather than modelled: they sit two
 * centimetres above the tarmac so there is no z-fighting with the road surface.
 */
export function Markings({ model }: { model: CityModel }) {
  const dashRef = useRef<THREE.InstancedMesh | null>(null);
  const crossingRef = useRef<THREE.InstancedMesh | null>(null);
  const dummy = useMemo(() => new THREE.Object3D(), []);

  const dashes = useMemo(() => {
    const list: { x: number; z: number; rotation: number }[] = [];
    for (const segment of model.grid.segments) {
      const horizontal = Math.abs(segment.z2 - segment.z1) < 0.001;
      const from = horizontal ? Math.min(segment.x1, segment.x2) : Math.min(segment.z1, segment.z2);
      const to = horizontal ? Math.max(segment.x1, segment.x2) : Math.max(segment.z1, segment.z2);
      const at = horizontal ? segment.z1 : segment.x1;
      for (let along = from + 6; along < to - 6; along += 6) {
        list.push({ x: horizontal ? along : at, z: horizontal ? at : along, rotation: horizontal ? 0 : Math.PI / 2 });
      }
    }
    return list;
  }, [model.grid.segments]);

  const bars = useMemo(() => {
    const list: { x: number; z: number; rotation: number }[] = [];
    for (const point of model.grid.intersections) {
      // Four bars per crossing, on both approaches of both axes.
      for (const side of [-1, 1]) {
        for (let bar = -2; bar <= 2; bar += 1) {
          list.push({ x: point.x + side * 4.4, z: point.z + bar * 1.1, rotation: Math.PI / 2 });
          list.push({ x: point.x + bar * 1.1, z: point.z + side * 4.4, rotation: 0 });
        }
      }
    }
    return list;
  }, [model.grid.intersections]);

  useEffect(() => {
    const mesh = dashRef.current;
    if (!mesh) return;
    dashes.forEach((dash, index) => {
      dummy.position.set(dash.x, 0.035, dash.z);
      dummy.rotation.set(0, dash.rotation, 0);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      mesh.setMatrixAt(index, dummy.matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
  }, [dashes, dummy]);

  useEffect(() => {
    const mesh = crossingRef.current;
    if (!mesh) return;
    bars.forEach((bar, index) => {
      dummy.position.set(bar.x, 0.04, bar.z);
      dummy.rotation.set(0, bar.rotation, 0);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      mesh.setMatrixAt(index, dummy.matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
  }, [bars, dummy]);

  return (
    <group>
      {dashes.length > 0 ? (
        <instancedMesh ref={dashRef} args={[undefined, undefined, dashes.length]}>
          <boxGeometry args={[2.6, 0.02, 0.17]} />
          <meshStandardMaterial color="#5b7ea8" roughness={0.85} />
        </instancedMesh>
      ) : null}
      {bars.length > 0 ? (
        <instancedMesh ref={crossingRef} args={[undefined, undefined, bars.length]}>
          <boxGeometry args={[0.7, 0.02, 3.4]} />
          <meshStandardMaterial color="#8ea9c6" roughness={0.8} />
        </instancedMesh>
      ) : null}
    </group>
  );
}

/* ------------------------------------------------------------------- edges */

/**
 * Dependency links, drawn as arcs between supplier and dependent.
 *
 * Drawn with a single `LineSegments` buffer rather than one object per edge: 25
 * edges today, but the layout is data-driven and could be hundreds. Colour is per
 * vertex, so a compromised edge is red without splitting the buffer.
 */
export function DependencyLinks({
  edges,
  show,
  compromised,
  selectedId,
  cascade,
  onSelect,
}: {
  edges: PlacedEdge[];
  show: boolean;
  compromised?: Set<number>;
  selectedId?: number | null;
  /**
   * Hop count from a cascade's origin, per asset. When present, every link that
   * carries the cascade is coloured by how far along the chain it sits, so an
   * edge deep in the cascade is visibly cooler than one next to the origin.
   */
  cascade?: Map<number, number>;
  onSelect?: (id: number) => void;
}) {
  const { geometry } = useMemo(() => {
    const positions: number[] = [];
    const colors: number[] = [];

    const neutral = new THREE.Color("#3d6d93");
    const hot = new THREE.Color("#ff6b6b");
    const highlight = new THREE.Color("#45d8f5");
    // The far end of a cascade is a duller red than the near end. Same hue, so the
    // meaning is still "carrying a failure", but the ordering is legible without a
    // legend.
    const far = new THREE.Color("#8a4650");

    for (const placed of edges) {
      const isCompromised = compromised?.has(placed.edge.target) || compromised?.has(placed.edge.source);
      const isHighlighted =
        selectedId != null && (placed.edge.source === selectedId || placed.edge.target === selectedId);

      const targetDepth = cascade?.get(placed.edge.target);
      const sourceDepth = cascade?.get(placed.edge.source);
      const depth = targetDepth ?? sourceDepth;
      const colour =
        cascade && depth != null && cascade.size > 1
          ? hot.clone().lerp(far, Math.min(1, (depth - 1) / Math.max(1, Math.max(...cascade.values()))))
          : null;

      const color = colour ?? (isCompromised ? hot : isHighlighted ? highlight : neutral);

      // An arc, sampled in a few steps: a straight line between two towers would
      // pass through whatever stands between them.
      const steps = 8;
      const midY = Math.max(placed.from.y, placed.to.y) + 6;
      for (let step = 0; step < steps; step += 1) {
        const t1 = step / steps;
        const t2 = (step + 1) / steps;
        for (const t of [t1, t2]) {
          // Quadratic bezier: endpoints on the rooftops, control point above.
          const oneMinus = 1 - t;
          // Control point at the horizontal midpoint. Using one endpoint as the
          // control -- which this did -- pulls every arc towards that end, so all
          // the links in the city bow the same way.
          const cx = (placed.from.x + placed.to.x) / 2;
          const cz = (placed.from.z + placed.to.z) / 2;
          const x = oneMinus * oneMinus * placed.from.x + 2 * oneMinus * t * cx + t * t * placed.to.x;
          const z = oneMinus * oneMinus * placed.from.z + 2 * oneMinus * t * cz + t * t * placed.to.z;
          const y = oneMinus * oneMinus * placed.from.y + 2 * oneMinus * t * midY + t * t * placed.to.y;
          positions.push(x, y, z);
          colors.push(color.r, color.g, color.b);
        }
      }
    }

    const buffer = new THREE.BufferGeometry();
    buffer.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    buffer.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    return { geometry: buffer };
  }, [edges, compromised, selectedId, cascade]);

  // Nothing to draw: an empty buffer still creates an object, which would show up
  // as a dependency layer that exists but explains nothing.
  if (!show || edges.length === 0) return null;

  return (
    <group>
      <lineSegments geometry={geometry}>
        <lineBasicMaterial vertexColors transparent opacity={0.55} />
      </lineSegments>
      {/* Clickable proxies at the midpoints, so a link can be inspected without
          having to hit a 1px line. */}
      {edges.map((placed, index) => {
        const mid = {
          x: (placed.from.x + placed.to.x) / 2,
          y: (Math.max(placed.from.y, placed.to.y) + 6 + placed.from.y + placed.to.y) / 3,
          z: (placed.from.z + placed.to.z) / 2,
        };
        return (
          <mesh
            key={index}
            position={[mid.x, mid.y, mid.z]}
            onClick={(event: THREE.Event & { stopPropagation: () => void }) => {
              event.stopPropagation();
              onSelect?.(placed.edge.target);
            }}
          >
            <sphereGeometry args={[0.55, 8, 8]} />
            <meshBasicMaterial color="#45d8f5" transparent opacity={0.35} />
          </mesh>
        );
      })}
    </group>
  );
}

/* ------------------------------------------------------------------- zones */

/**
 * Zone discs: the ground footprint of each district, sized by population.
 *
 * A heatmap overlay replaces the tint with the resilience score when one is
 * supplied, so the same geometry serves the plain view and the analytical one.
 */
export function ZoneDiscs({
  zones,
  heat,
  show,
  selectedZone,
  onSelect,
}: {
  zones: ZoneHull[];
  heat?: Map<string, { score: number; band: string }>;
  show: boolean;
  selectedZone?: string | null;
  onSelect?: (code: string) => void;
}) {
  if (!show) return null;

  return (
    <group>
      {zones.map((hull) => {
        const reading = heat?.get(hull.zone.code);
        const color = reading ? heatColor(reading.score) : "#45d8f5";
        const selected = selectedZone === hull.zone.code;
        return (
          <group key={hull.zone.code} position={[hull.position.x, 0, hull.position.z]}>
            <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.02, 0]} onClick={() => onSelect?.(hull.zone.code)}>
              <circleGeometry args={[hull.radius, 48]} />
              <meshBasicMaterial color={color} transparent opacity={selected ? 0.2 : 0.09} />
            </mesh>
            <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.025, 0]}>
              <ringGeometry args={[hull.radius - 0.6, hull.radius, 64]} />
              <meshBasicMaterial color={color} transparent opacity={selected ? 0.9 : 0.45} />
            </mesh>
          </group>
        );
      })}
    </group>
  );
}

/** Heat bands, matching the palette the 2D resilience map already uses. */
export function heatColor(score: number): string {
  if (score >= 80) return "#3ee6a5";
  if (score >= 65) return "#a3e635";
  if (score >= 50) return "#ffb545";
  if (score >= 35) return "#fb923c";
  return "#ff6b6b";
}

/* ----------------------------------------------------------------- scenery */

/**
 * Decorative props, one instanced mesh per part.
 *
 * A tree is a trunk and a canopy; at 220 props drawn individually that is 440
 * objects and as many draw calls, for geometry that is entirely static. Instead
 * each part of each kind becomes a single `InstancedMesh`, so the whole scatter
 * costs a fixed handful of draw calls regardless of how much of it there is.
 *
 * They are never clickable and carry no asset id -- the separation from
 * operational infrastructure is structural, not a naming convention.
 */
export function Scenery({ model, enabled }: { model: CityModel; enabled: boolean }) {
  if (!enabled) return null;
  return <InstancedScenery scenery={model.scenery} />;
}

/** Part definitions per prop kind: the same shapes the single-prop renderer uses. */
const PROP_PARTS: Record<
  string,
  { geometry: "cylinder" | "icosahedron" | "box" | "sphere"; args: number[]; y: number; colour: string; emissive?: string; emissiveIntensity?: number; flat?: boolean }[]
> = {
  tree: [
    { geometry: "cylinder", args: [0.16, 0.22, 1.8, 6], y: 0.9, colour: "#2b2119" },
    { geometry: "icosahedron", args: [1.15, 0], y: 2.4, colour: "#1f6f52", flat: true },
  ],
  lamp: [
    { geometry: "cylinder", args: [0.07, 0.1, 4, 6], y: 2, colour: "#33465e" },
    { geometry: "sphere", args: [0.22, 8, 8], y: 4.1, colour: "#ffd9a0", emissive: "#ffb545", emissiveIntensity: 1.6 },
  ],
  bench: [
    { geometry: "box", args: [1.5, 0.12, 0.45], y: 0.35, colour: "#3a4f6b" },
  ],
};

function InstancedScenery({ scenery }: { scenery: CityModel["scenery"] }) {
  const byKind = useMemo(() => {
    const groups = new Map<string, CityModel["scenery"]>();
    for (const prop of scenery) {
      const list = groups.get(prop.kind) ?? [];
      list.push(prop);
      groups.set(prop.kind, list);
    }
    return groups;
  }, [scenery]);

  return (
    <group>
      {[...byKind].map(([kind, props]) => (
        <InstancedKind key={kind} kind={kind} props={props} />
      ))}
    </group>
  );
}

function InstancedKind({ kind, props }: { kind: string; props: CityModel["scenery"] }) {
  const parts = PROP_PARTS[kind] ?? PROP_PARTS.bench;
  const refs = useRef<(THREE.InstancedMesh | null)[]>([]);
  const dummy = useMemo(() => new THREE.Object3D(), []);

  // Matrices are set once: scenery never moves, so this is a mount-time cost and
  // not a per-frame one.
  useEffect(() => {
    props.forEach((prop, index) => {
      dummy.position.set(prop.position.x, 0, prop.position.z);
      dummy.rotation.set(0, prop.rotation, 0);
      dummy.scale.setScalar(prop.scale);
      dummy.updateMatrix();
      refs.current.forEach((mesh) => mesh?.setMatrixAt(index, dummy.matrix));
    });
    refs.current.forEach((mesh) => {
      if (mesh) mesh.instanceMatrix.needsUpdate = true;
    });
  }, [props, dummy]);

  return (
    <group>
      {parts.map((part, partIndex) => (
        <instancedMesh
          key={partIndex}
          ref={(node) => {
            refs.current[partIndex] = node;
          }}
          args={[undefined, undefined, props.length]}
          // Each part sits at its own height above the prop's base. Applying it to
          // the mesh rather than to the geometry keeps one matrix per instance,
          // which is what makes the instancing worth doing.
          position={[0, part.y, 0]}
          castShadow={kind === "tree"}
        >
          {part.geometry === "cylinder" ? (
            <cylinderGeometry args={part.args as [number, number, number, number]} />
          ) : part.geometry === "icosahedron" ? (
            <icosahedronGeometry args={part.args as [number, number]} />
          ) : part.geometry === "sphere" ? (
            <sphereGeometry args={part.args as [number, number, number]} />
          ) : (
            <boxGeometry args={part.args as [number, number, number]} />
          )}
          <meshStandardMaterial
            color={part.colour}
            roughness={part.flat ? 0.85 : 0.9}
            flatShading={part.flat}
            emissive={part.emissive ?? "#000000"}
            emissiveIntensity={part.emissiveIntensity ?? 0}
          />
        </instancedMesh>
      ))}
    </group>
  );
}


/**
 * Propagation rings: one expanding ring per cascade hop, centred on the origin.
 *
 * The point is not decoration. A cascade is a sequence -- the hospital is not
 * affected until the substation is -- and a static red set hides that ordering.
 * Rings expand outward from the origin and fade, so the depth of any given asset is
 * visible as distance from the centre rather than as a number in a table.
 *
 * Drawn as a single instanced ring mesh: one draw call no matter how deep the
 * cascade goes. Nothing here changes colour on its own; the caller decides whether
 * the overlay is live, hypothetical or historical.
 */
export function PropagationRings({
  origin,
  maxDepth,
  enabled,
  reducedMotion = false,
}: {
  /** Centre of the cascade, in scene coordinates, with its height. */
  origin: { x: number; y: number; z: number } | null;
  maxDepth: number;
  enabled: boolean;
  reducedMotion?: boolean;
}) {
  const meshRef = useRef<THREE.InstancedMesh | null>(null);
  const materialRef = useRef<THREE.MeshBasicMaterial | null>(null);
  const dummy = useMemo(() => new THREE.Object3D(), []);
  const rings = Math.max(0, Math.min(maxDepth, 6));

  useFrame(({ clock }) => {
    const mesh = meshRef.current;
    const material = materialRef.current;
    if (!mesh || !origin || !enabled) return;

    // One ring per hop. Each is offset in phase so the wave travels outward
    // continuously instead of all hops pulsing together.
    const period = 3.2;
    for (let index = 0; index < rings; index += 1) {
      const phase = reducedMotion ? (index + 1) / rings : ((clock.elapsedTime / period + index / rings) % 1);
      const radius = 8 + index * 13 + phase * 6;
      dummy.position.set(origin.x, 0.25, origin.z);
      dummy.rotation.set(-Math.PI / 2, 0, 0);
      dummy.scale.set(radius, radius, 1);
      dummy.updateMatrix();
      mesh.setMatrixAt(index, dummy.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;

    if (material && !reducedMotion) {
      // Fade with the wave rather than flashing: a pulse at this size is a
      // distraction, and a fade reads as spreading.
      material.opacity = 0.34 + 0.18 * Math.sin(clock.elapsedTime * 1.6);
    }
  });

  if (!origin || !enabled || rings === 0) return null;

  return (
    <instancedMesh ref={meshRef} args={[undefined, undefined, rings]}>
      {/* A unit annulus: inner radius 0.86 so the ring has visible thickness. */}
      <ringGeometry args={[0.86, 1, 48]} />
      <meshBasicMaterial
        ref={materialRef}
        color="#ff8a5c"
        transparent
        opacity={0.4}
        side={THREE.DoubleSide}
        depthWrite={false}
      />
    </instancedMesh>
  );
}

/**
 * The origin marker: a taller, brighter column on the asset the cascade started at.
 *
 * Without it every failed asset looks equally responsible, and the one asset whose
 * loss started the whole thing is indistinguishable from the twelve downstream of
 * it.
 */
export function CascadeOrigin({
  position,
  enabled,
}: {
  position: { x: number; y: number; z: number } | null;
  enabled: boolean;
}) {
  const meshRef = useRef<THREE.Mesh | null>(null);

  useFrame(({ clock }) => {
    const mesh = meshRef.current;
    if (!mesh) return;
    // Slow bob, so the eye finds it in a scene of static buildings.
    mesh.position.y = (position?.y ?? 0) + 1.2 + Math.sin(clock.elapsedTime * 1.8) * 0.35;
  });

  if (!position || !enabled) return null;

  return (
    <mesh ref={meshRef} position={[position.x, position.y + 1.2, position.z]}>
      <cylinderGeometry args={[0.5, 0.9, 14, 12, 1, true]} />
      <meshBasicMaterial color="#ff5d5d" transparent opacity={0.42} side={THREE.DoubleSide} depthWrite={false} />
    </mesh>
  );
}
