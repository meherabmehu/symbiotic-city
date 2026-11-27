import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end configuration.
 *
 * Drives a real browser against the real stack: FastAPI on :8011 and Next.js on
 * :3010 (ports chosen so a developer's own :8000/:3000 are left alone). Both are
 * started by `webServer`, so `npm run e2e` needs no manual setup — only a seeded
 * database, which the API creates on boot when SEED_DEMO_DATA=1.
 *
 * CI installs the browser with `npx playwright install --with-deps chromium`;
 * locally run `npx playwright install chromium` once.
 *
 * Where that download is blocked (restricted networks, offline machines), point
 * PLAYWRIGHT_CHROMIUM_PATH at any runnable Chromium binary instead -- the tests
 * need nothing from Playwright's own build beyond launching it. Left unset, this
 * changes nothing: Playwright uses its installed browser as usual.
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  workers: 1,
  // The json report is the machine-readable record; CI uploads it as an
  // artifact so a failure can be diagnosed without the raw job log.
  reporter: process.env.CI
    ? [["list"], ["html", { open: "never" }], ["json", { outputFile: "test-results/results.json" }]]
    : "list",
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://127.0.0.1:3010",
    actionTimeout: 10_000,
    navigationTimeout: 20_000,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
    // Escape hatch for environments where Playwright's browser CDN is
    // unreachable: any runnable Chromium works. Unset -> Playwright default.
    ...(process.env.PLAYWRIGHT_CHROMIUM_PATH
      ? { launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } }
      : {}),
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    {
      name: "mobile",
      use: { ...devices["Pixel 7"] },
      testMatch: /responsive\.spec\.ts/,
    },
    {
      name: "tablet",
      use: { ...devices["Desktop Chrome"], viewport: { width: 768, height: 1024 } },
      testMatch: /responsive\.spec\.ts/,
    },
  ],
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : [
        {
          // A throwaway SQLite file per run: deterministic seed, no state carried
          // between runs, and never the developer's own database.
          command:
            "cd ../backend && DATABASE_URL=sqlite:////tmp/e2e-$(date +%s).db " +
            "SEED_DEMO_DATA=1 ENVIRONMENT=test AUTH_RATE_LIMIT_PER_MINUTE=10000 " +
            "../.venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 8011",
          url: "http://127.0.0.1:8011/api/health",
          reuseExistingServer: !process.env.CI,
          timeout: 180_000,
          stdout: "pipe",
          stderr: "pipe",
        },
        {
          command: "BACKEND_URL=http://127.0.0.1:8011 npm run dev -- -p 3010",
          url: "http://127.0.0.1:3010/login",
          reuseExistingServer: !process.env.CI,
          timeout: 240_000,
          stdout: "pipe",
          stderr: "pipe",
        },
      ],
});
