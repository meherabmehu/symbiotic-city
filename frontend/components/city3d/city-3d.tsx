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
  clampTarget,
  focusPose,
  resolveVisualStatus,
  type CameraMode,
  type PlacedAsset,
  type VisualStatus,
} from "@/lib/city-model";
import type { Impact, TwinGraph, TwinNode } from "@/lib/types";
import { Building } from "@/components/city3d/buildings";
import { DependencyLinks, Ground, Roads, Scenery, Traffic, ZoneDiscs } from "@/components/city3d/city-parts";

export type Quality = "high" | "balanced" | "low";

export interface City3DOverlay {
  /** Planned impacts from a simulation playback. Never persisted. */
  impacts?: Impact[];
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
  quality?: Quality;
  /** Camera preset; changing it animates to that pose. */
  mode?: CameraMode;
  /** An asset to fly to, or null for the whole city. */
  focusId?: number | null;
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
    quality = "balanced",
    mode = "perspective",
    focusId = null,
    className,
    height = 520,
  } = props;

  const [supported] = useState(() => hasWebGL());
  const [reducedMotion, setReducedMotion] = useState(false);
  const controlRef = useRef<OrbitControls | null>(null);

  const model = useMemo(() => buildCityModel(graph), [graph]);

  const impactsById = useMemo(() => {
    const map = new Map<number, Impact>();
    for (const impact of overlay?.impacts ?? []) map.set(impact.asset_id, impact);
    return map;
  }, [overlay?.impacts]);

  const recovering = useMemo(() => new Set(overlay?.recovering ?? []), [overlay?.recovering]);

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
      <Canvas
        shadows={shadows}
        dpr={effectiveQuality === "high" ? [1, 2] : effectiveQuality === "balanced" ? [1, 1.5] : 1}
        camera={{ position: cameraPose("perspective").position, fov: 42, near: 0.5, far: 900 }}
        gl={{ antialias: effectiveQuality !== "low", powerPreference: "high-performance" }}
        onPointerMissed={() => onSelect?.(null)}
      >
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
          <Traffic model={model} enabled={trafficOn} />

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

          <DependencyLinks
            edges={model.edges}
            show={showEdges}
            compromised={compromised}
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
          reducedMotion={reducedMotion}
          controlRef={controlRef}
        />
        <CameraControls controlRef={controlRef} />
        <ControlLoop controlRef={controlRef} />
      </Canvas>
    </div>
  );
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
  reducedMotion,
  controlRef,
}: {
  mode: CameraMode;
  focus: PlacedAsset | null;
  reducedMotion: boolean;
  controlRef: React.MutableRefObject<OrbitControls | null>;
}) {
  const goal = useRef<{ position: THREE.Vector3; target: THREE.Vector3 } | null>(null);

  // React to preset and focus changes by computing a new goal pose.
  useEffect(() => {
    const pose = focus ? focusPose(focus.position, focus.footprint) : cameraPose(mode);
    goal.current = {
      position: new THREE.Vector3(...pose.position),
      target: new THREE.Vector3(...pose.target),
    };
  }, [mode, focus]);

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

    const speed = reducedMotion ? 1 : Math.min(1, delta * 4.2);
    camera.position.lerp(destination.position, speed);
    control.target.lerp(destination.target, speed);
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
