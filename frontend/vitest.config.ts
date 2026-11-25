import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
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
  plugins: [react()],
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
