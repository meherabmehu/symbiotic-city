"use client";

/**
 * The 3D city canvas.
 *
 * Responsibilities, in order of importance:
 *
 *  1. Render the city model (`lib/city-model.ts`) as an interactive scene.
 *  2. Stay usable when WebGL is unavailable -- the caller renders the 2D twin in
 *     that case, and this component says so instead of throwing.
 *  3. Stay responsive on weak hardware: a quality preset controls shadows,
 *     scenery and traffic, and `prefers-reduced-motion` turns ambient movement
 *     off without losing the ability to inspect anything.
 *  4. Never invent data. Everything drawn comes from the `graph` prop, which is
 *     the API response; simulation overlays are passed separately and never
 *     written back.
 */

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import {
  CITY_BOUNDS,
  buildCityModel,
  cameraPose,
  cascadeDepths,
  clampTarget,
  fitPose,
  focusPose,
  incidentPose,
  resolveVisualStatus,
  type CameraMode,
  type PlacedAsset,
  type VisualStatus,
} from "@/lib/city-model";
import type { Impact, TwinGraph, TwinNode } from "@/lib/types";
import { Building } from "@/components/city3d/buildings";
import { SceneStatsReporter, type SceneStats } from "@/components/city3d/scene-stats";
import {
  CascadeOrigin,
  DependencyLinks,
  EmergencyTraffic,
  Ground,
  Markings,
  PropagationRings,
  Roads,
  Scenery,
  Traffic,
  TrafficSignals,
  ZoneDiscs,
} from "@/components/city3d/city-parts";

export type Quality = "high" | "balanced" | "low";

export interface City3DOverlay {
  /** Planned impacts from a simulation playback. Never persisted. */
  impacts?: Impact[];
  /**
   * The asset a simulation started from, so the cascade can be drawn outward from
   * its origin rather than as a set of equally-bad buildings.
   */
  originId?: number | null;
  /**
   * What kind of thing the overlay is showing. A hypothetical cascade and a
   * recorded one look identical in the geometry, and confusing the two is the most
   * consequential mistake this view can make, so the caller has to say which.
   */
  scenario?: "live" | "hypothetical" | "historical" | "proposed";
  /** Ids currently shown as recovering (approved plan, tasks not yet verified). */
  recovering?: number[];
  /** Zone resilience scores, for the heatmap overlay. */
  heat?: Map<string, { score: number; band: string }>;
  /**
   * Per-asset intensity, 0-100, for an analytical lens over the buildings.
   *
   * Used by the criticality ranking and by the investment planner's per-asset
   * benefit. One map rather than a mode enum: the canvas only needs to know how
   * strongly to light a building, and the caller decides what the number means.
   * The legend that gives it meaning lives in the panel that produced it.
   */
  intensity?: Map<number, { value: number; emphasis?: boolean }>;
}

/**
 * The words each overlay kind is labelled with.
 *
 * Kept next to the overlay type rather than in the page, because the point of the
 * label is that it cannot drift from the data it describes.
 */
export const SCENARIO_LABELS: Record<
  NonNullable<City3DOverlay["scenario"]>,
  { heading: string; detail: string }
> = {
  live: {
    heading: "Live",
    detail: "Drawn from the current state of the model.",
  },
  hypothetical: {
    heading: "Hypothetical",
    detail: "A simulated cascade. Nothing here is happening, and nothing is saved.",
  },
  historical: {
    heading: "Recorded",
    detail: "A past simulation, replayed against today's assets.",
  },
  proposed: {
    heading: "Proposed",
    detail: "Planned work. Not yet in effect; live state is unchanged.",
  },
};

export interface City3DProps {
  graph: TwinGraph | null;
  loading?: boolean;
  overlay?: City3DOverlay;
  selectedId?: number | null;
  onSelect?: (node: TwinNode | null) => void;
  showEdges?: boolean;
  showZones?: boolean;
  /** Zone to emphasise, e.g. the row chosen in the heatmap panel. */
  selectedZone?: string | null;
  showTraffic?: boolean;
  showScenery?: boolean;
  /**
   * Active incidents. Used only to decide whether emergency vehicles exist and how
   * many: a responder appearing is not a claim that this incident caused it.
   */
  activeIncidents?: number;
  quality?: Quality;
  /** Camera preset; changing it animates to that pose. */
  mode?: CameraMode;
  /** Called when a keyboard shortcut picks a preset. */
  onModeChange?: (mode: CameraMode) => void;
  /** An asset to fly to, or null for the whole city. */
  focusId?: number | null;
  /**
   * An incident to fly to: the failing asset *and* its surroundings, because what
   * makes an incident worth looking at is what it reaches.
   */
  focusIncidentId?: number | null;
  /**
   * When this changes, the camera frames the whole city for the current viewport.
   * A counter rather than a boolean: pressing "fit" twice should fit twice.
   */
  fitRequest?: number;
  /** Receives measured scene statistics roughly twice a second, when supplied. */
  onStats?: (stats: SceneStats) => void;
  className?: string;
  height?: number;
}

/** Probe for WebGL once, cached: creating a context is not free. */
let webglSupport: boolean | null = null;
export function hasWebGL(): boolean {
  if (webglSupport !== null) return webglSupport;
  if (typeof window === "undefined") return false;
  try {
    const canvas = document.createElement("canvas");
    webglSupport = Boolean(
      window.WebGLRenderingContext &&
        (canvas.getContext("webgl2") || canvas.getContext("webgl")),
    );
  } catch {
    webglSupport = false;
  }
  return webglSupport;
}

export function City3D(props: City3DProps) {
  const {
    graph,
    loading,
    overlay,
    selectedId = null,
    onSelect,
    showEdges = true,
    showZones = true,
    selectedZone = null,
    showTraffic = true,
    showScenery = true,
    activeIncidents = 0,
    quality = "balanced",
    mode = "perspective",
    onModeChange,
    focusId = null,
    focusIncidentId = null,
    fitRequest = 0,
    onStats,
    className,
    height = 520,
  } = props;

  const [supported] = useState(() => hasWebGL());
  const [reducedMotion, setReducedMotion] = useState(false);
  const controlRef = useRef<OrbitControls | null>(null);
  // The live camera, for the keyboard pan. OrbitControls keeps its own reference,
  // but does not expose it, and a pan has to move both the camera and the target.
  const cameraRef = useRef<THREE.Camera | null>(null);

  const model = useMemo(() => buildCityModel(graph), [graph]);

  const impactsById = useMemo(() => {
    const map = new Map<number, Impact>();
    for (const impact of overlay?.impacts ?? []) map.set(impact.asset_id, impact);
    return map;
  }, [overlay?.impacts]);

  const recovering = useMemo(() => new Set(overlay?.recovering ?? []), [overlay?.recovering]);

  /**
   * Propagation depth, per asset, from the run's origin. Computed in the model so it
   * can be tested against a real cascade rather than only against a screenshot.
   */
  const cascadeDepth = useMemo(
    () =>
      cascadeDepths(
        model?.edges.map((placed) => ({
          source: placed.edge.source,
          target: placed.edge.target,
        })) ?? [],
        overlay?.impacts?.map((impact) => impact.asset_id) ?? [],
        overlay?.originId ?? null,
      ),
    [model, overlay?.originId, overlay?.impacts],
  );

  const originAsset = useMemo(
    () => (overlay?.originId != null ? model?.assets.find((asset) => asset.node.id === overlay.originId) ?? null : null),
    [model, overlay?.originId],
  );

  const maxDepth = useMemo(
    () => [...cascadeDepth.values()].reduce((max, depth) => Math.max(max, depth), 0),
    [cascadeDepth],
  );

  /** Status per asset, resolved once per render pass. */
  const intensity = overlay?.intensity;

  const statusById = useMemo(() => {
    const map = new Map<number, VisualStatus>();
    for (const asset of model?.assets ?? []) {
      const impact = impactsById.get(asset.node.id);
      map.set(
        asset.node.id,
        resolveVisualStatus(asset.node.status, {
          impact: impact?.impact_level as "failed" | "degraded" | "affected" | undefined,
          recovering: recovering.has(asset.node.id),
        }),
      );
    }
    return map;
  }, [model, impactsById, recovering]);

  const compromised = useMemo(() => {
    const set = new Set<number>();
    for (const [id, status] of statusById) {
      if (status === "failed" || status === "degraded") set.add(id);
    }
    return set;
  }, [statusById]);

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReducedMotion(query.matches);
    const handler = (event: MediaQueryListEvent) => setReducedMotion(event.matches);
    query.addEventListener("change", handler);
    return () => query.removeEventListener("change", handler);
  }, []);

  const effectiveQuality: Quality = reducedMotion && quality === "high" ? "balanced" : quality;
  const shadows = effectiveQuality === "high";
  const sceneryOn = showScenery && effectiveQuality !== "low";
  const trafficOn = showTraffic && effectiveQuality !== "low" && !reducedMotion;

  if (!supported) {
    return (
      <div
        className={className}
        style={{ height }}
        role="img"
        aria-label="3D city unavailable: WebGL is not supported by this browser"
        data-testid="city3d-fallback"
      >
        <div className="flex h-full flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-white/15 bg-navy-900/40 px-6 text-center">
          <p className="text-sm font-semibold text-white">3D view needs WebGL</p>
          <p className="max-w-sm text-xs leading-relaxed text-ink-400">
            This browser reports no WebGL context, so the 3D city cannot be drawn here. The map view
            below shows the same assets, statuses and dependency links, and every action remains
            available.
          </p>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div
        className={className}
        style={{ height }}
        role="status"
        aria-live="polite"
        data-testid="city3d-loading"
      >
        <div className="flex h-full items-center justify-center rounded-2xl border border-white/10 bg-navy-900/40">
          <p className="text-xs text-ink-400">Building the city…</p>
        </div>
      </div>
    );
  }

  if (!model) {
    return (
      <div className={className} style={{ height }} data-testid="city3d-empty">
        <div className="flex h-full items-center justify-center rounded-2xl border border-dashed border-white/15 bg-navy-900/40">
          <p className="text-xs text-ink-400">No infrastructure records to draw.</p>
        </div>
      </div>
    );
  }

  return (
    <div className={className} style={{ height }} data-testid="city3d-canvas">
      {/* Keyboard access to the camera. The canvas itself cannot take focus and does
          not respond to keys, so keystrokes are handled on the wrapper: arrows pan,
          plus and minus zoom, and the number keys pick a preset. Everything here
          duplicates a pointer gesture, so nothing is keyboard-only. */}
      <div
        tabIndex={0}
        role="application"
        aria-label="City view: arrow keys pan, plus and minus zoom, 1 2 3 switch between perspective, isometric and top-down"
        onKeyDown={(event) => {
          const control = controlRef.current;
          if (!control) return;
          const step = event.shiftKey ? 28 : 12;
          const offset = new THREE.Vector3();
          switch (event.key) {
            case "ArrowLeft":
              offset.set(-step, 0, 0);
              break;
            case "ArrowRight":
              offset.set(step, 0, 0);
              break;
            case "ArrowUp":
              offset.set(0, 0, -step);
              break;
            case "ArrowDown":
              offset.set(0, 0, step);
              break;
            case "+":
            case "=":
            case "PageUp":
              control.dollyIn?.(0.8);
              control.update();
              event.preventDefault();
              return;
            case "-":
            case "PageDown":
              control.dollyOut?.(1.25);
              control.update();
              event.preventDefault();
              return;
            case "1":
              onModeChange?.("perspective");
              return;
            case "2":
              onModeChange?.("isometric");
              return;
            case "3":
              onModeChange?.("top");
              return;
            default:
              return;
          }
          // Pan both the camera and the orbit target by the same vector: moving
          // one without the other swings the view instead of sliding it.
          const next = clampTarget([
            control.target.x + offset.x,
            control.target.y,
            control.target.z + offset.z,
          ]);
          const delta = new THREE.Vector3(next[0] - control.target.x, 0, next[2] - control.target.z);
          control.target.add(delta);
          cameraRef.current?.position.add(delta);
          control.update();
          event.preventDefault();
        }}
      >
      <Canvas
        shadows={shadows}
        dpr={effectiveQuality === "high" ? [1, 2] : effectiveQuality === "balanced" ? [1, 1.5] : 1}
        camera={{ position: cameraPose("perspective").position, fov: 42, near: 0.5, far: 900 }}
        gl={{ antialias: effectiveQuality !== "low", powerPreference: "high-performance" }}
        onPointerMissed={() => onSelect?.(null)}
      >
        <CameraCapture cameraRef={cameraRef} />
        {onStats ? <SceneStatsReporter onStats={onStats} /> : null}
        <SceneColor />
        {/* Lighting: one hemisphere for ambient fill (cheap) and one directional
            key light. Shadows are high-quality only. */}
        <hemisphereLight args={["#9fd0ff", "#0b1626", 1.1]} />
        <directionalLight
          position={[70, 120, 45]}
          intensity={1.5}
          color="#bcd9ff"
          castShadow={shadows}
          shadow-mapSize={shadows ? [2048, 2048] : [512, 512]}
          shadow-camera-left={-140}
          shadow-camera-right={140}
          shadow-camera-top={140}
          shadow-camera-bottom={-140}
        />
        {effectiveQuality === "high" ? <pointLight position={[0, 60, 0]} intensity={60} color="#4fb8ff" distance={260} /> : null}

        <Suspense fallback={null}>
          <Ground reducedTexture={effectiveQuality === "low"} />
          <ZoneDiscs
            zones={model.zones}
            heat={overlay?.heat}
            show={showZones}
            selectedZone={selectedZone}
          />
          <Roads model={model} />
          <Scenery model={model} enabled={sceneryOn} />
          <Markings model={model} />
          <TrafficSignals model={model} enabled={trafficOn} />
          <Traffic model={model} enabled={trafficOn} />
          <EmergencyTraffic model={model} enabled={trafficOn} incidents={activeIncidents ?? 0} />

          {model.assets.map((asset) => (
            <Building
              key={asset.node.id}
              category={asset.node.category}
              status={statusById.get(asset.node.id) ?? "operational"}
              footprint={asset.footprint}
              position={asset.position}
              rotation={asset.rotation}
              selected={selectedId === asset.node.id}
              onSelect={() => onSelect?.(asset.node)}
              // Casting shadows is the single most expensive thing a building
              // does, and on a low preset it buys nothing at the camera distances
              // the preset is meant for.
              castShadow={shadows}
              intensity={intensity?.get(asset.node.id)}
            />
          ))}

          <PropagationRings
            origin={originAsset ? { ...originAsset.position, y: originAsset.footprint.height } : null}
            maxDepth={maxDepth}
            enabled={Boolean(overlay?.impacts?.length && overlay?.originId != null)}
            reducedMotion={reducedMotion}
          />
          <CascadeOrigin
            position={originAsset ? { ...originAsset.position, y: originAsset.footprint.height } : null}
            enabled={Boolean(overlay?.impacts?.length && overlay?.originId != null)}
          />

          <DependencyLinks
            edges={model.edges}
            show={showEdges}
            compromised={compromised}
            cascade={cascadeDepth}
            selectedId={selectedId}
            onSelect={(id) => {
              const node = graph?.nodes.find((candidate) => candidate.id === id) ?? null;
              onSelect?.(node);
            }}
          />
        </Suspense>

        <CameraRig
          mode={mode}
          focus={focusId != null ? findAsset(model.assets, focusId) : null}
          incident={focusIncidentId != null ? findAsset(model.assets, focusIncidentId) : null}
          fitRequest={fitRequest}
          reducedMotion={reducedMotion}
          controlRef={controlRef}
        />
        <CameraControls controlRef={controlRef} />
        <ControlLoop controlRef={controlRef} />
      </Canvas>
      </div>
    </div>
  );
}

/** Records the live camera so the DOM keyboard handler can move it. */
function CameraCapture({ cameraRef }: { cameraRef: React.MutableRefObject<THREE.Camera | null> }) {
  const camera = useThree((state) => state.camera);
  useEffect(() => {
    cameraRef.current = camera;
    return () => {
      cameraRef.current = null;
    };
  }, [camera, cameraRef]);
  return null;
}

function findAsset(assets: PlacedAsset[], id: number): PlacedAsset | null {
  return assets.find((asset) => asset.node.id === id) ?? null;
}

/** Scene background and fog, so distant buildings fade instead of aliasing. */
function SceneColor() {
  return (
    <>
      <color attach="background" args={["#060d18"]} />
      <fog attach="fog" args={["#060d18", 190, 460]} />
    </>
  );
}

/* --------------------------------------------------------------- camera rig */

/**
 * Orbit controls plus animated preset/focus transitions.
 *
 * The transition is a damped lerp toward a target pose rather than a tween
 * library: at this scale it is a few lines, has no dependency, and cannot leave
 * the camera mid-flight if a frame is dropped.
 */
function CameraRig({
  mode,
  focus,
  incident,
  fitRequest,
  reducedMotion,
  controlRef,
}: {
  mode: CameraMode;
  focus: PlacedAsset | null;
  incident: PlacedAsset | null;
  fitRequest: number;
  reducedMotion: boolean;
  controlRef: React.MutableRefObject<OrbitControls | null>;
}) {
  const goal = useRef<{ position: THREE.Vector3; target: THREE.Vector3 } | null>(null);
  const camera = useThree((state) => state.camera);
  const size = useThree((state) => state.size);

  // React to preset and focus changes by computing a new goal pose. The incident
  // framing wins over the asset framing: if both are set the user asked for the
  // incident, and an incident view already contains its asset.
  useEffect(() => {
    const pose = incident
      ? incidentPose(incident.position, incident.footprint)
      : focus
        ? focusPose(focus.position, focus.footprint)
        : cameraPose(mode);
    goal.current = {
      position: new THREE.Vector3(...pose.position),
      target: new THREE.Vector3(...pose.target),
    };
  }, [mode, focus, incident]);

  // Fit the whole city into whatever viewport is on screen right now. The aspect
  // ratio comes from the renderer rather than from the window, so a split view or
  // a sheet-open layout frames correctly too.
  useEffect(() => {
    if (fitRequest === 0) return;
    const aspect = size.width / Math.max(size.height, 1);
    const pose = fitPose(mode, aspect, (camera as THREE.PerspectiveCamera).fov ?? 42);
    goal.current = {
      position: new THREE.Vector3(...pose.position),
      target: new THREE.Vector3(...pose.target),
    };
    // Only the request counter should re-fit; `size` and `mode` are read at the
    // moment of the press, not tracked continuously.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitRequest]);

  useEffect(() => {
    const control = controlRef.current;
    if (!control) return;
    // Reduce the damping when the user has asked for less motion: the camera
    // still follows the pointer, but does not coast afterwards.
    control.enableDamping = !reducedMotion;
  }, [reducedMotion, controlRef]);

  useFrame((state, delta) => {
    const camera = state.camera;
    const control = controlRef.current;
    const destination = goal.current;
    if (!control || !destination) return;

    // Exponential damping rather than `delta * k`: at 144Hz a linear step arrives
    // at a different speed than at 30Hz, so the same button press feels different
    // on different machines. This settles in the same time everywhere.
    const alpha = reducedMotion ? 1 : 1 - Math.exp(-delta * 4.6);
    camera.position.lerp(destination.position, alpha);
    control.target.lerp(destination.target, alpha);
    const clamped = clampTarget([control.target.x, control.target.y, control.target.z]);
    control.target.set(clamped[0], clamped[1], clamped[2]);

    // Close enough: release the goal so the user's own orbiting is not fought.
    if (camera.position.distanceTo(destination.position) < 0.6) {
      goal.current = null;
    }
  });

  return null;
}

/**
 * OrbitControls, mounted imperatively.
 *
 * three.js's OrbitControls is a plain class that wants a camera and a DOM element,
 * and manages its own listeners. It does not need a React binding -- constructing
 * it once inside the canvas and disposing it on unmount is fewer moving parts than
 * a wrapper component, and it means the controls are a direct dependency of the
 * renderer rather than of a controls metapackage.
 *
 * The ref is shared with `CameraRig` above, which needs the live instance to lerp
 * its target during a focus transition.
 */
function CameraControls({ controlRef }: { controlRef: React.MutableRefObject<OrbitControls | null> }) {
  const camera = useThree((state) => state.camera);
  const gl = useThree((state) => state.gl);
  const get = useThree((state) => state.get);

  useEffect(() => {
    const controls = new OrbitControls(camera, gl.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.rotateSpeed = 0.6;
    controls.zoomSpeed = 0.9;
    controls.panSpeed = 0.7;
    controls.minDistance = CITY_BOUNDS.minDistance;
    controls.maxDistance = CITY_BOUNDS.maxDistance;
    controls.minPolarAngle = CITY_BOUNDS.minPolarAngle;
    controls.maxPolarAngle = CITY_BOUNDS.maxPolarAngle;
    // Left drag rotates, right drag pans, wheel zooms, and the same two gestures
    // work with two fingers on touch -- which is what makes this usable on a phone.
    controls.enablePan = true;
    controls.enableZoom = true;
    controls.enableRotate = true;
    // Write the current target back into the camera so a reset() is meaningful.
    controls.saveState();
    controlRef.current = controls;

    const invalidate = get().invalidate;
    const onChange = () => invalidate?.();
    controls.addEventListener("change", onChange);

    return () => {
      controls.removeEventListener("change", onChange);
      controls.dispose();
      controlRef.current = null;
    };
    // `camera` and `gl` are stable for the life of the canvas; re-creating the
    // controls on every render would drop the user's drag mid-gesture.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camera, gl]);

  return null;
}

/** Drive damping every frame; OrbitControls does not run itself. */
function ControlLoop({ controlRef }: { controlRef: React.MutableRefObject<OrbitControls | null> }) {
  useFrame(() => {
    controlRef.current?.update();
  });
  return null;
}

/* -------------------------------------------------------------- imperative */

/**
 * Small imperative handle for the surrounding UI: reset the view, and friendlier
 * camera controls on touch. Kept separate from the canvas so the page does not
 * need to know about three.js.
 */
export function useCityCamera() {
  const [mode, setMode] = useState<CameraMode>("perspective");
  const [focusId, setFocusId] = useState<number | null>(null);
  const reset = useCallback(() => {
    setFocusId(null);
    setMode("perspective");
  }, []);
  return { mode, setMode, focusId, setFocusId, reset };
}
