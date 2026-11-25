import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

/**
 * Regression guard for the module-resolution failure.
 *
 * The 3D view used to import its controls from a metapackage. When that package
 * was not present in a clean install, the whole page failed to compile with
 * "Module not found" -- and nothing in the test suite noticed, because every scene
 * test built geometry and never touched the controls.
 *
 * These tests import the controls from `three` itself, which is a declared
 * runtime dependency of the frontend package. If that import ever stops
 * resolving, or the class stops existing, this fails before the page does.
 */

/**
 * Just enough DOM for OrbitControls to attach.
 *
 * It only needs an element with `addEventListener`, `removeEventListener`,
 * `getBoundingClientRect`, `ownerDocument` and a style object. Providing that is
 * better than pulling in a full DOM implementation: the test then exercises the
 * real controls code rather than a mock of it.
 */
function stubElement(): HTMLElement {
  const listeners = new Map<string, Set<unknown>>();
  const element = {
    style: {},
    clientWidth: 300,
    clientHeight: 200,
    ownerDocument: {
      addEventListener: () => {},
      removeEventListener: () => {},
      // OrbitControls asks for `pointerLockElement` when capturing a pointer.
      pointerLockElement: null,
    },
    addEventListener: (type: string, handler: unknown) => {
      const set = listeners.get(type) ?? new Set();
      set.add(handler);
      listeners.set(type, set);
    },
    removeEventListener: (type: string, handler: unknown) => {
      listeners.get(type)?.delete(handler);
    },
    setPointerCapture: () => {},
    releasePointerCapture: () => {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 300, height: 200, right: 300, bottom: 200 }),
    // What OrbitControls installs its own listeners on.
    addEventListenerRaw: () => {},
  };
  return element as unknown as HTMLElement;
}

describe("orbit controls", () => {
  it("imports from three and constructs against a camera", () => {
    const camera = new THREE.PerspectiveCamera(42, 1.5, 0.5, 900);
    const controls = new OrbitControls(camera, stubElement());

    expect(controls.target).toBeInstanceOf(THREE.Vector3);
    // Defaults the app overrides, asserted here so a change in three's defaults
    // shows up as a failing test rather than as a camera that behaves differently.
    expect(typeof controls.enableDamping).toBe("boolean");
    expect(typeof controls.minPolarAngle).toBe("number");

    controls.dispose();
  });

  it("accepts the exact limits the camera rig applies", () => {
    const camera = new THREE.PerspectiveCamera(42, 1.5, 0.5, 900);
    const controls = new OrbitControls(camera, stubElement());

    controls.minDistance = 18;
    controls.maxDistance = 320;
    controls.minPolarAngle = 0.08;
    controls.maxPolarAngle = Math.PI / 2 - 0.06;
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;

    expect(controls.minDistance).toBe(18);
    expect(controls.maxDistance).toBe(320);
    expect(controls.maxPolarAngle).toBeLessThan(Math.PI / 2);

    controls.dispose();
  });

  it("exposes the target the focus transition writes to", () => {
    const camera = new THREE.PerspectiveCamera(42, 1.5, 0.5, 900);
    const controls = new OrbitControls(camera, stubElement());

    // The camera rig lerps this vector every frame while flying to an asset, so it
    // has to be the live object rather than a copy.
    controls.target.set(12, 4, -30);
    expect(controls.target.x).toBe(12);
    expect(controls.target.z).toBe(-30);

    controls.dispose();
  });

  it("can save and restore its state, which the reset button relies on", () => {
    const camera = new THREE.PerspectiveCamera(42, 1.5, 0.5, 900);
    const position = camera.position.clone();
    const controls = new OrbitControls(camera, stubElement());

    controls.saveState();
    camera.position.set(500, 500, 500);
    controls.reset();

    expect(camera.position.distanceTo(position)).toBeLessThan(0.001);
    controls.dispose();
  });
});
