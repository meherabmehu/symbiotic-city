"use client";

/**
 * Scene statistics, measured from the live renderer.
 *
 * Every number here comes from three.js's own `renderer.info` and the scene graph
 * after a frame has actually been drawn. Nothing is estimated, and nothing is
 * hard-coded: if the scene gains a thousand meshes, this says so.
 *
 * What it deliberately does not do is claim a frame rate on hardware it cannot see.
 * The FPS shown is a rolling average measured in the user's own browser over the
 * last second, labelled as such, and it is the only number here that depends on the
 * machine rather than on the scene.
 */

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useRef, useState } from "react";

export interface SceneStats {
  /** Draw calls in the last frame, from `renderer.info.render.calls`. */
  drawCalls: number;
  /** Triangles submitted in the last frame. */
  triangles: number;
  /** Mesh objects in the scene graph. */
  meshes: number;
  /** InstancedMesh objects, and the instances they draw. */
  instancedMeshes: number;
  instances: number;
  /** Distinct material objects -- the ones that cost a shader each. */
  materials: number;
  /** Distinct geometries. */
  geometries: number;
  /** Textures currently resident. */
  textures: number;
  /** Three.js's own track of GPU-resident resources. */
  programs: number;
  /** Megabytes resident in JS, when the browser exposes it. null when it does not. */
  heapMb: number | null;
  /** Rolling FPS, measured over the last second in this browser. */
  fps: number;
}

/**
 * Collect scene statistics and report them upward roughly twice a second.
 *
 * The walk is deliberately throttled: traversing the scene graph on every frame
 * would itself be a measurable cost, and counting objects is not something a user
 * needs at 60Hz.
 */
export function SceneStatsReporter({
  onStats,
  enabled = true,
}: {
  onStats: (stats: SceneStats) => void;
  enabled?: boolean;
}) {
  const gl = useThree((state) => state.gl);
  const scene = useThree((state) => state.scene);
  const frames = useRef({ count: 0, elapsed: 0 });
  const callback = useRef(onStats);
  callback.current = onStats;

  useFrame((_, delta) => {
    if (!enabled) return;
    frames.current.count += 1;
    frames.current.elapsed += delta;

    // Twice a second is enough to watch the numbers settle and cheap enough to
    // leave on while the scene animates.
    if (frames.current.elapsed < 0.5) return;

    const fps = frames.current.count / frames.current.elapsed;
    frames.current = { count: 0, elapsed: 0 };

    // Counting is a full traversal, so it runs at the reporting rate rather than
    // the frame rate.
    let meshes = 0;
    let instancedMeshes = 0;
    let instances = 0;
    const materials = new Set<unknown>();
    const geometries = new Set<unknown>();

    scene.traverse((object) => {
      const candidate = object as unknown as {
        isMesh?: boolean;
        isInstancedMesh?: boolean;
        count?: number;
        material?: unknown;
        geometry?: unknown;
      };
      if (!candidate.isMesh && !candidate.isInstancedMesh) return;
      meshes += 1;
      if (candidate.isInstancedMesh) {
        instancedMeshes += 1;
        instances += candidate.count ?? 0;
      }
      // A material can be an array on a multi-material mesh; both forms count.
      const material = candidate.material;
      if (Array.isArray(material)) {
        for (const entry of material) materials.add(entry);
      } else if (material) {
        materials.add(material);
      }
      if (candidate.geometry) geometries.add(candidate.geometry);
    });

    const info = gl.info;
    const memory = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;

    callback.current({
      drawCalls: info.render.calls,
      triangles: info.render.triangles,
      meshes,
      instancedMeshes,
      instances,
      materials: materials.size,
      geometries: geometries.size,
      textures: info.memory.textures,
      programs: info.programs?.length ?? 0,
      heapMb: memory ? Math.round(memory.usedJSHeapSize / (1024 * 1024)) : null,
      fps: Math.round(fps),
    });

  });

  return null;
}

/**
 * Measures how long the scene took to appear, from the moment the component mounted
 * to the first frame that actually drew something.
 *
 * Reported separately from the per-frame stats because it happens once, and because
 * it is the number that answers "does this page feel slow to open".
 */
export function useFirstFrame(): [number | null, () => void] {
  const started = useRef<number | null>(null);
  const [value, setValue] = useState<number | null>(null);

  useEffect(() => {
    started.current = performance.now();
  }, []);

  return [
    value,
    () => {
      if (started.current == null) return;
      setValue(Math.round(performance.now() - started.current));
    },
  ];
}

