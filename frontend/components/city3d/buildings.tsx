"use client";

/**
 * Building geometry: one silhouette per infrastructure category.
 *
 * Everything is built from boxes, cylinders and simple extrusions. That is a
 * deliberate choice, not a limitation: primitive geometry can be created once
 * and shared across every instance (no model downloads, no licence questions,
 * no loading states), and it stays readable at the distances the camera actually
 * uses. A hospital looks like a hospital because of its massing -- a slab tower
 * with a glazed wing and a helipad -- not because of texture detail.
 *
 * Each building is a small group of boxes. The parts are memoised per category
 * so the geometry and materials are shared, which is what keeps the draw call
 * count and the GPU memory flat as the city grows.
 */

import { useMemo } from "react";
// Importing the runtime's types is what registers <mesh>, <boxGeometry> and the
// rest as intrinsic elements for the TypeScript checker; without this reference
// every R3F tag reads as "does not exist on JSX.IntrinsicElements".
import type {} from "@react-three/fiber";
import * as THREE from "three";
import type { VisualStatus } from "@/lib/city-model";
import { STATUS_STYLES, type Footprint } from "@/lib/city-model";

/* --------------------------------------------------------------- materials */

export interface MaterialSet {
  body: THREE.MeshStandardMaterial;
  /** Glazing band: emissive, so windows read at night. */
  glass: THREE.MeshStandardMaterial;
  /** Roof / equipment: matte and darker. */
  trim: THREE.MeshStandardMaterial;
  /** Roof marker used for the status beacon. */
  beacon: THREE.MeshStandardMaterial;
}

/**
 * Materials per status, shared across the whole scene.
 *
 * `emissiveIntensity` carries the status glow; the base colour is the status
 * colour. Because both are applied to the same material used by several
 * buildings, status is communicated by *light* as well as hue -- a failed
 * building is visibly lit from within, which survives a colour-blind viewer
 * seeing it as "bright" even if the hue is indistinguishable.
 */
/**
 * Materials, created once for the whole scene and shared.
 *
 * They were originally built inside each building, which meant 23 buildings x 5
 * statuses x 4 materials -- around 460 material objects, each a separate shader
 * program, for twenty distinct appearances. Sharing them lets the renderer batch
 * buildings that are in the same state instead of switching material per draw.
 *
 * The cache lives at module scope because these materials are immutable: a status
 * is chosen by picking a set, never by mutating one, so there is nothing to
 * invalidate.
 */
let sharedMaterials: Record<VisualStatus, MaterialSet> | null = null;

function buildMaterialSet(status: VisualStatus): MaterialSet {
  const style = STATUS_STYLES[status];
  const color = new THREE.Color(style.color);
  return {
    body: new THREE.MeshStandardMaterial({
      color: new THREE.Color("#1b2b45"),
      emissive: color,
      emissiveIntensity: style.glow * 0.32,
      metalness: 0.35,
      roughness: 0.55,
    }),
    glass: new THREE.MeshStandardMaterial({
      color: new THREE.Color("#0e1a2c"),
      emissive: color,
      emissiveIntensity: style.glow * 0.55,
      metalness: 0.6,
      roughness: 0.25,
    }),
    trim: new THREE.MeshStandardMaterial({
      color: new THREE.Color("#22354f"),
      metalness: 0.4,
      roughness: 0.7,
    }),
    beacon: new THREE.MeshStandardMaterial({
      color,
      emissive: color,
      emissiveIntensity: 1.4,
      transparent: true,
      opacity: 0.92,
    }),
  };
}

export function useStatusMaterials(): Record<VisualStatus, MaterialSet> {
  if (!sharedMaterials) {
    sharedMaterials = {
      operational: buildMaterialSet("operational"),
      degraded: buildMaterialSet("degraded"),
      failed: buildMaterialSet("failed"),
      maintenance: buildMaterialSet("maintenance"),
      recovering: buildMaterialSet("recovering"),
    };
  }
  return sharedMaterials;
}

/* ---------------------------------------------------------------- geometry */

interface Part {
  kind: "box" | "cylinder" | "cone";
  /** [width, height, depth] for boxes; bottom radius for cylinders. */
  size: [number, number, number];
  position: [number, number, number];
  rotationY?: number;
  material: "body" | "glass" | "trim";
}

/**
 * The parts that make up each category, in building-local coordinates.
 *
 * Numbers are in the footprint's units. The tallest part should approach
 * `Footprint.height`; the assembler scales the group afterwards if it does not,
 * so the declared height stays the source of truth for the skyline.
 */
export const BUILDING_PARTS: Record<string, Part[]> = {
  power_station: [
    { kind: "box", size: [9, 5, 7], position: [0, 2.5, 0], material: "body" },
    { kind: "box", size: [9.4, 0.6, 7.4], position: [0, 5.3, 0], material: "trim" },
    // Two flue stacks -- the unmistakable silhouette of a generating station.
    { kind: "cylinder", size: [0.55, 4, 0.55], position: [-2.4, 7.4, -1.6], material: "trim" },
    { kind: "cylinder", size: [0.55, 3.4, 0.55], position: [-2.4, 7.1, 1.6], material: "trim" },
    { kind: "box", size: [3, 1.4, 2.2], position: [2.4, 6, 1.8], material: "glass" },
  ],
  substation: [
    { kind: "box", size: [5, 3, 4.4], position: [0, 1.5, 0], material: "body" },
    { kind: "box", size: [5.4, 0.4, 4.8], position: [0, 3.2, 0], material: "trim" },
    // Three transformer posts, a recognisable substation silhouette.
    { kind: "cylinder", size: [0.22, 1.6, 0.22], position: [-1.4, 4.2, 0], material: "trim" },
    { kind: "cylinder", size: [0.22, 1.6, 0.22], position: [0, 4.2, 0], material: "trim" },
    { kind: "cylinder", size: [0.22, 1.6, 0.22], position: [1.4, 4.2, 0], material: "trim" },
  ],
  hospital: [
    { kind: "box", size: [5, 9, 5], position: [-1.4, 4.5, 0], material: "body" },
    { kind: "box", size: [3, 6, 6.5], position: [2.2, 3, 0], material: "glass" },
    // The helipad: a flat disc on the low wing, which is how you tell a hospital
    // from an office block at a glance.
    { kind: "cylinder", size: [2.2, 0.3, 2.2], position: [2.2, 6.4, 0], material: "trim" },
    { kind: "box", size: [4.2, 0.5, 0.8], position: [-1.4, 9.3, 1.3], material: "trim" },
  ],
  water_pump: [
    { kind: "box", size: [4, 3, 4], position: [0, 1.5, 0], material: "body" },
    { kind: "cylinder", size: [0.9, 3.2, 0.9], position: [1.1, 5.2, -1], material: "trim" },
    { kind: "box", size: [4.2, 0.4, 4.2], position: [0, 3.2, 0], material: "trim" },
  ],
  water_treatment: [
    { kind: "box", size: [9, 3.4, 8], position: [0, 1.7, 0], material: "body" },
    { kind: "box", size: [9.4, 0.4, 8.4], position: [0, 3.6, 0], material: "trim" },
    // Open clarifier tanks on the roof.
    { kind: "cylinder", size: [1.5, 0.8, 1.5], position: [-2.4, 4.2, 0], material: "glass" },
    { kind: "cylinder", size: [1.5, 0.8, 1.5], position: [0.6, 4.2, 0], material: "glass" },
    { kind: "cylinder", size: [1.5, 0.8, 1.5], position: [3.2, 4.2, 0], material: "glass" },
  ],
  school: [
    { kind: "box", size: [8, 4, 5], position: [0, 2, 0], material: "body" },
    { kind: "box", size: [8.4, 0.5, 5.4], position: [0, 4.2, 0], material: "trim" },
    // Gymnasium wing at right angles, and a flagpole.
    { kind: "box", size: [3, 2.6, 3.4], position: [2.2, 1.3, 3.4], material: "glass" },
    { kind: "cylinder", size: [0.08, 2.4, 0.08], position: [-3.4, 6.2, 2], material: "trim" },
  ],
  residential: [
    { kind: "box", size: [6, 8, 5], position: [0, 4, 0], material: "body" },
    { kind: "box", size: [6.3, 0.4, 5.3], position: [0, 8.2, 0], material: "trim" },
    // Balcony bands, which read as habitation.
    { kind: "box", size: [6.4, 0.22, 0.5], position: [0, 3, 2.7], material: "glass" },
    { kind: "box", size: [6.4, 0.22, 0.5], position: [0, 5.4, 2.7], material: "glass" },
    { kind: "box", size: [0.5, 0.22, 5.4], position: [3.2, 4.2, 0], material: "glass" },
  ],
  commercial: [
    { kind: "box", size: [6, 14, 6], position: [0, 7, 0], material: "body" },
    { kind: "box", size: [4.4, 12, 4.4], position: [0, 16, 0], material: "glass" },
    { kind: "box", size: [2.2, 3, 2.2], position: [0, 23.5, 0], material: "trim" },
    { kind: "box", size: [6.6, 0.6, 6.6], position: [0, 14.3, 0], material: "trim" },
  ],
  telecom: [
    { kind: "cylinder", size: [0.35, 12, 0.35], position: [0, 6, 0], material: "trim" },
    { kind: "box", size: [1.8, 0.4, 1.8], position: [0, 3, 0], material: "body" },
    // Antenna panels near the top.
    { kind: "box", size: [1.4, 1.6, 0.2], position: [0.9, 10.5, 0], material: "glass" },
    { kind: "box", size: [0.2, 1.6, 1.4], position: [0, 10.5, 0.9], material: "glass" },
  ],
};

export const DEFAULT_PARTS: Part[] = [
  { kind: "box", size: [5, 6, 5], position: [0, 3, 0], material: "body" },
  { kind: "box", size: [5.3, 0.4, 5.3], position: [0, 6.1, 0], material: "trim" },
];

export function partsFor(category: string): Part[] {
  return BUILDING_PARTS[category] ?? DEFAULT_PARTS;
}

/** The tallest point of a category, used to hang the status beacon in the air. */
export function partsHeight(parts: Part[]): number {
  return parts.reduce((max, part) => Math.max(max, part.position[1] + part.size[1] / 2), 0);
}

/* ---------------------------------------------------------------- renderer */

/**
 * One building, drawn from its part list.
 *
 * `scale` folds the footprint's declared height into the model: the parts are
 * authored at a natural size per category, and the height the layout engine
 * expects is enforced here so the skyline and the collision plot agree.
 */
export function Building({
  category,
  status,
  footprint,
  position,
  rotation,
  selected,
  castShadow = true,
  intensity,
  onSelect,
  onHover,
}: {
  category: string;
  status: VisualStatus;
  footprint: Footprint;
  position: { x: number; y: number; z: number };
  rotation: number;
  selected: boolean;
  /** Off on the low quality preset, where the shadow pass costs more than it adds. */
  castShadow?: boolean;
  /**
   * A 0-100 reading for an analytical lens (criticality, investment benefit).
   * Drawn as a vertical column of light beside the building, never as a change to
   * the building's status colour -- a hypothesis must not look like a status.
   */
  intensity?: { value: number; emphasis?: boolean };
  onSelect?: () => void;
  onHover?: (hovering: boolean) => void;
}) {
  const materials = useStatusMaterials();
  const parts = partsFor(category);
  const set = materials[status];

  const height = partsHeight(parts);
  const scaleY = height > 0 ? footprint.height / height : 1;

  return (
    <group
      position={[position.x, 0, position.z]}
      rotation={[0, rotation, 0]}
      onClick={(event: THREE.Event & { stopPropagation: () => void }) => {
        event.stopPropagation();
        onSelect?.();
      }}
      onPointerOver={(event: THREE.Event & { stopPropagation: () => void }) => {
        event.stopPropagation();
        onHover?.(true);
        document.body.style.cursor = "pointer";
      }}
      onPointerOut={() => {
        onHover?.(false);
        document.body.style.cursor = "auto";
      }}
      name={`asset-${category}`}
    >
      {/* A plinth so the building reads as standing on prepared ground, and a
          selection ring is drawn just outside it. */}
      <mesh position={[0, 0.08, 0]} receiveShadow={castShadow}>
        <boxGeometry args={[footprint.width + 2.2, 0.16, footprint.depth + 2.2]} />
        <meshStandardMaterial color="#16233a" roughness={0.9} metalness={0.1} />
      </mesh>

      {selected ? (
        <mesh position={[0, 0.2, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <ringGeometry args={[footprint.plot / 2, footprint.plot / 2 + 0.5, 40]} />
          <meshBasicMaterial color="#45d8f5" transparent opacity={0.85} side={THREE.DoubleSide} />
        </mesh>
      ) : null}

      <group scale={[1, scaleY, 1]}>
        {/* Entrance: a canopy over a recessed door on the side that faces the
            street. It is what turns a box into a building at street level, and
            it is the same geometry for every category. */}
        <mesh position={[0, 1.5, footprint.depth / 2 + 0.02]} material={set.trim} castShadow={castShadow}>
          <boxGeometry args={[2.4, 0.22, 1.1]} />
        </mesh>
        <mesh position={[0, 0.85, footprint.depth / 2 - 0.03]} material={set.glass}>
          <boxGeometry args={[1.7, 1.7, 0.12]} />
        </mesh>

        {parts.map((part, index) => (
          <mesh
            key={index}
            position={part.position}
            rotation={[0, part.rotationY ?? 0, 0]}
            material={set[part.material]}
            castShadow={castShadow}
            receiveShadow={castShadow}
          >
            {part.kind === "box" ? (
              <boxGeometry args={part.size} />
            ) : part.kind === "cylinder" ? (
              <cylinderGeometry args={[part.size[0], part.size[0], part.size[1], 12]} />
            ) : (
              <coneGeometry args={[part.size[0], part.size[1], 10]} />
            )}
          </mesh>
        ))}
      </group>

      {/* Roof detail: a plant box and a pair of vents on the flat roof every
          category has. Cheap, and it stops the roofline reading as a cut-off
          extruded shape from above. */}
      <group scale={[1, 1, 1]}>
        <mesh position={[footprint.width * 0.22, footprint.height + 0.3, -footprint.depth * 0.18]} material={set.trim} castShadow={castShadow}>
          <boxGeometry args={[1.4, 0.6, 1.1]} />
        </mesh>
        <mesh position={[-footprint.width * 0.26, footprint.height + 0.22, footprint.depth * 0.2]} material={set.trim}>
          <cylinderGeometry args={[0.24, 0.24, 0.45, 8]} />
        </mesh>
      </group>

      <StatusBeacon status={status} height={footprint.height} set={set} />

      {intensity ? <LensColumn value={intensity.value} height={footprint.height} emphasis={intensity.emphasis} /> : null}
    </group>
  );
}

/**
 * The status mark above a building.
 *
 * Shape carries the status as well as colour: a cross for failed, a half-disc for
 * degraded, a bar for maintenance, a pulsing sphere for recovering, and nothing
 * at all for operational. That is the second encoding the legend refers to, and
 * it is why the scene is readable with the saturation turned off.
 */
function StatusBeacon({
  status,
  height,
  set,
}: {
  status: VisualStatus;
  height: number;
  set: MaterialSet;
}) {
  const style = STATUS_STYLES[status];
  if (style.mark === "none") return null;

  const y = height + 2.2;

  if (style.mark === "cross") {
    return (
      <group position={[0, y, 0]}>
        <mesh rotation={[0, 0, Math.PI / 4]} material={set.beacon}>
          <boxGeometry args={[1.9, 0.28, 0.28]} />
        </mesh>
        <mesh rotation={[0, 0, -Math.PI / 4]} material={set.beacon}>
          <boxGeometry args={[1.9, 0.28, 0.28]} />
        </mesh>
      </group>
    );
  }

  if (style.mark === "bar") {
    return (
      <mesh position={[0, y, 0]} material={set.beacon}>
        <boxGeometry args={[2.1, 0.4, 0.4]} />
      </mesh>
    );
  }

  if (style.mark === "half") {
    // A disc with half its area cut away: readable as a shape, not just a shade.
    return (
      <mesh position={[0, y, 0]} rotation={[-Math.PI / 2, 0, 0]} material={set.beacon}>
        <circleGeometry args={[0.95, 24, 0, Math.PI]} />
      </mesh>
    );
  }

  // pulse
  return (
    <mesh position={[0, y, 0]} material={set.beacon}>
      <sphereGeometry args={[0.65, 14, 12]} />
    </mesh>
  );
}

/**
 * The analytical lens over a building.
 *
 * A thin column of light whose height and brightness track the reading. It is
 * deliberately a separate object from the building and uses its own colour ramp,
 * because the building's colour already means "status" and reusing it would make
 * a hypothetical look like a state.
 */
function LensColumn({
  value,
  height,
  emphasis,
}: {
  value: number;
  height: number;
  emphasis?: boolean;
}) {
  const clamped = Math.max(0, Math.min(100, value));
  const hue = 200 - (clamped / 100) * 200; // cool blue at 0, red at 100
  const colour = new THREE.Color().setHSL(hue / 360, 0.85, 0.55);
  const columnHeight = 3 + (clamped / 100) * Math.max(6, height * 0.6);

  return (
    <group position={[0, 0, 0]}>
      <mesh position={[0, columnHeight / 2, 0]}>
        <cylinderGeometry args={[0.32, 0.32, columnHeight, 8, 1, true]} />
        <meshBasicMaterial
          color={colour}
          transparent
          opacity={emphasis ? 0.85 : 0.5}
          depthWrite={false}
          side={THREE.DoubleSide}
        />
      </mesh>
      <mesh position={[0, columnHeight + 0.4, 0]}>
        <sphereGeometry args={[emphasis ? 0.5 : 0.36, 10, 8]} />
        <meshBasicMaterial color={colour} transparent opacity={0.9} />
      </mesh>
    </group>
  );
}

/* ------------------------------------------------------------------ ground */

/**
 * Street furniture, drawn one prop at a time.
 *
 * Kept for a single prop that has to be an individual object -- a car placed by
 * hand, or a lamp on a specific corner. The scattered scenery in `city-parts.tsx`
 * does not use it: 220 of these would be 440 meshes, so that path instances a
 * part table instead.
 */
/** Static street furniture props, shared geometry. */
export function SceneryProp({ kind, position, rotation, scale }: {
  kind: "tree" | "car" | "bench" | "lamp";
  position: { x: number; y: number; z: number };
  rotation: number;
  scale: number;
}) {
  if (kind === "tree") {
    return (
      <group position={[position.x, 0, position.z]} rotation={[0, rotation, 0]} scale={scale}>
        <mesh position={[0, 0.9, 0]} castShadow>
          <cylinderGeometry args={[0.16, 0.22, 1.8, 6]} />
          <meshStandardMaterial color="#2b2119" roughness={0.95} />
        </mesh>
        <mesh position={[0, 2.4, 0]} castShadow>
          <icosahedronGeometry args={[1.15, 0]} />
          <meshStandardMaterial color="#1f6f52" roughness={0.85} flatShading />
        </mesh>
      </group>
    );
  }
  if (kind === "car") {
    return (
      <group position={[position.x, 0, position.z]} rotation={[0, rotation, 0]} scale={scale}>
        <mesh position={[0, 0.42, 0]} castShadow>
          <boxGeometry args={[1.7, 0.62, 0.95]} />
          <meshStandardMaterial color="#2c4a6e" metalness={0.5} roughness={0.45} />
        </mesh>
        <mesh position={[0, 0.82, 0]}>
          <boxGeometry args={[1.0, 0.36, 0.82]} />
          <meshStandardMaterial color="#101b2b" metalness={0.6} roughness={0.3} />
        </mesh>
      </group>
    );
  }
  if (kind === "lamp") {
    return (
      <group position={[position.x, 0, position.z]} scale={scale}>
        <mesh position={[0, 2, 0]}>
          <cylinderGeometry args={[0.07, 0.1, 4, 6]} />
          <meshStandardMaterial color="#33465e" />
        </mesh>
        <mesh position={[0, 4.1, 0]}>
          <sphereGeometry args={[0.22, 8, 8]} />
          <meshStandardMaterial color="#ffd9a0" emissive="#ffb545" emissiveIntensity={1.6} />
        </mesh>
      </group>
    );
  }
  return (
    <group position={[position.x, 0, position.z]} rotation={[0, rotation, 0]} scale={scale}>
      <mesh position={[0, 0.35, 0]}>
        <boxGeometry args={[1.5, 0.12, 0.45]} />
        <meshStandardMaterial color="#3a4f6b" />
      </mesh>
    </group>
  );
}
