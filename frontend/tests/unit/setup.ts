/**
 * Minimal browser surface for the scene tests.
 *
 * `@react-three/fiber` touches a few DOM APIs on mount (pointer events, canvas
 * measurement, media queries). Rather than pull in a full DOM emulator -- which
 * would make the tests slower and less representative than they look -- only the
 * handful of calls the renderer actually makes are provided here.
 */

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

class IntersectionObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}

if (!("ResizeObserver" in globalThis)) {
  globalThis.ResizeObserver = ResizeObserverStub;
}
if (!("IntersectionObserver" in globalThis)) {
  // @ts-expect-error -- deliberate stub for the node test environment
  globalThis.IntersectionObserver = IntersectionObserverStub;
}

if (!("matchMedia" in globalThis)) {
  // The lib.dom types declare matchMedia on Window; this file assigns it to the
  // node global object, which is the same slot at runtime but a narrower type.
  (globalThis as unknown as { matchMedia: (query: string) => unknown }).matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  });
}

if (typeof globalThis.requestAnimationFrame !== "function") {
  const globals = globalThis as unknown as {
    requestAnimationFrame: (callback: (time: number) => void) => number;
    cancelAnimationFrame: (handle: number) => void;
  };
  globals.requestAnimationFrame = (callback) =>
    setTimeout(() => callback(performance.now()), 16) as unknown as number;
  globals.cancelAnimationFrame = (handle) => clearTimeout(handle);
}
