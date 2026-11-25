/**
 * Types for three.js's own OrbitControls addon.
 *
 * `three/examples/jsm/controls/OrbitControls.js` ships without a declaration file
 * (the examples folder is plain ESM, untyped). Rather than adding a whole
 * alternative controls package -- or a metapackage that re-exports this one and
 * pulls in two hundred other modules with it -- the surface this app actually uses
 * is declared here. Every member below is exercised by `components/city3d`, so a
 * three.js upgrade that changes the API fails the type check rather than the
 * runtime.
 */
declare module "three/examples/jsm/controls/OrbitControls.js" {
  import type { Camera, EventDispatcher, Vector3 } from "three";

  export interface OrbitControlsEventMap {
    change: Record<string, never>;
    start: Record<string, never>;
    end: Record<string, never>;
  }

  export class OrbitControls extends EventDispatcher<OrbitControlsEventMap> {
    constructor(camera: Camera, domElement?: HTMLElement);

    /** The point the camera orbits. Mutated directly by the app's focus animation. */
    target: Vector3;

    enableDamping: boolean;
    dampingFactor: number;
    rotateSpeed: number;
    zoomSpeed: number;
    panSpeed: number;
    minDistance: number;
    maxDistance: number;
    minPolarAngle: number;
    maxPolarAngle: number;
    enablePan: boolean;
    enableZoom: boolean;
    enableRotate: boolean;
    /** Touch: one finger rotates, two fingers dolly and pan. */
    touches: { ONE: number; TWO: number };

    update(deltaTime?: number): boolean;
    /**
     * Not in the documented public API, but present on the class and used by its own
     * wheel handler. Called here so a keyboard zoom takes exactly the same path as a
     * scroll wheel, including the min/max distance limits.
     */
    dollyIn(scale?: number): void;
    dollyOut(scale?: number): void;
    dispose(): void;
    /** Snapshot the current camera and target, for a later `reset()`. */
    saveState(): void;
    reset(): void;
  }
}
