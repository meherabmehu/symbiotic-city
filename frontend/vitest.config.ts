import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/**
 * Unit tests for the parts of the city that decide what is true: layout maths,
 * status resolution, and the scene graph the 3D renderer produces.
 *
 * The scene tests run through `@react-three/test-renderer`, which builds the real
 * React Three Fiber tree without a GL context. That covers "the city renders",
 * "every asset produced geometry", "simulation states reach the buildings" and
 * "traffic animates" in CI, where no GPU or display exists. What it cannot cover
 * is how it *looks*; that is left to the browser tests and to the human check.
 */
export default defineConfig({
  // JSX compiles through vite's default esbuild transform with React's automatic
  // runtime, so the tests need no Babel or React plugin. That is deliberate: the
  // React plugin drags in its own copy of picomatch, which npm's hoisting cannot
  // reconcile with the one the Next toolchain already has.
  resolve: {
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["tests/unit/**/*.test.{ts,tsx}"],
    setupFiles: ["tests/unit/setup.ts"],
  },
});
