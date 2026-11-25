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
  vehiclePosition,
  type CityModel,
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
  const lanes = model.lanes ?? [];
  const total = lanes.length * VEHICLES_PER_LANE;
  const meshRef = useRef<THREE.InstancedMesh | null>(null);
  const dummy = useMemo(() => new THREE.Object3D(), []);
  const clock = useRef(0);

  // Fixed per-vehicle phase, so vehicles are spread along the lane and the pattern
  // is identical on every mount.
  const slots = useMemo(() => {
    const list: { lane: TrafficLane; progress: number }[] = [];
    lanes.forEach((lane, laneIndex) => {
      for (let i = 0; i < VEHICLES_PER_LANE; i += 1) {
        list.push({
          lane,
          progress: (i / VEHICLES_PER_LANE + laneIndex * 0.13) % 1,
        });
      }
    });
    return list;
  }, [lanes]);

  // Place every vehicle at its starting offset before the first frame, and keep
  // re-placing them whenever the lane layout changes. Without this the instance
  // matrices stay at the identity and the whole fleet sits at the origin until
  // something else triggers an update.
  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    slots.forEach((slot, index) => {
      const { x, z, angle } = vehiclePosition(slot.lane, 0, speed, slot.progress);
      dummy.position.set(x, 0.55, z);
      dummy.rotation.set(0, angle, 0);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      mesh.setMatrixAt(index, dummy.matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
  }, [slots, dummy, speed]);

  useFrame((_, delta) => {
    const mesh = meshRef.current;
    if (!mesh || !enabled) return;
    // Clamp the step: a backgrounded tab hands back a huge delta, which would
    // teleport every vehicle instead of resuming smoothly.
    clock.current += Math.min(delta, 0.1);

    slots.forEach((slot, index) => {
      const { x, z, angle } = vehiclePosition(slot.lane, clock.current, speed, slot.progress);
      dummy.position.set(x, 0.55, z);
      dummy.rotation.set(0, angle, 0);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      mesh.setMatrixAt(index, dummy.matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
  });

  if (!enabled) return null;

  return (
    <instancedMesh ref={meshRef} args={[undefined, undefined, total]} castShadow={false}>
      <boxGeometry args={[1.9, 0.7, 1.0]} />
      <meshStandardMaterial color="#7fc8ff" emissive="#3ea8ff" emissiveIntensity={0.55} roughness={0.4} metalness={0.5} />
    </instancedMesh>
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
  onSelect,
}: {
  edges: PlacedEdge[];
  show: boolean;
  compromised?: Set<number>;
  selectedId?: number | null;
  onSelect?: (id: number) => void;
}) {
  const { geometry } = useMemo(() => {
    const positions: number[] = [];
    const colors: number[] = [];

    const neutral = new THREE.Color("#3d6d93");
    const hot = new THREE.Color("#ff6b6b");
    const highlight = new THREE.Color("#45d8f5");

    for (const placed of edges) {
      const isCompromised = compromised?.has(placed.edge.target) || compromised?.has(placed.edge.source);
      const isHighlighted =
        selectedId != null && (placed.edge.source === selectedId || placed.edge.target === selectedId);
      const color = isCompromised ? hot : isHighlighted ? highlight : neutral;

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
          const x = oneMinus * oneMinus * placed.from.x + 2 * oneMinus * t * placed.from.x * 0.5 + t * t * placed.to.x;
          const z = oneMinus * oneMinus * placed.from.z + 2 * oneMinus * t * placed.from.z * 0.5 + t * t * placed.to.z;
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
  }, [edges, compromised, selectedId]);

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
  car: [
    { geometry: "box", args: [1.7, 0.62, 0.95], y: 0.42, colour: "#2c4a6e" },
    { geometry: "box", args: [1.0, 0.36, 0.82], y: 0.82, colour: "#101b2b" },
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

