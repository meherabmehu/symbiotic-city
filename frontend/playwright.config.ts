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
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://127.0.0.1:3010",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    {
      name: "mobile",
      use: { ...devices["Pixel 7"] },
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
