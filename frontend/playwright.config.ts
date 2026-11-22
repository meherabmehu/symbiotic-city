import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end configuration.
 *
 * The suite drives a real browser against the real stack: FastAPI on :8011 and
 * Next.js on :3010. Both are started by `webServer`, so `npm run e2e` needs no
 * manual setup — only the demo accounts that ship with SEED_DEMO_DATA=1.
 *
 * NOTE: these specs have never been executed. The sandbox they were written in
 * could not download a browser binary (the CDN is blocked and the npm-packaged
 * Chromium is missing libnss3). Run them locally or in CI before trusting them.
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  expect: { timeout: 10_000 },
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
          command:
            "cd ../backend && DATABASE_URL=sqlite:///$(pwd)/data/e2e.db SEED_DEMO_DATA=1 ../.venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 8011",
          url: "http://127.0.0.1:8011/api/health",
          reuseExistingServer: !process.env.CI,
          timeout: 120_000,
        },
        {
          command: "BACKEND_URL=http://127.0.0.1:8011 npm run dev -- -p 3010",
          url: "http://127.0.0.1:3010/login",
          reuseExistingServer: !process.env.CI,
          timeout: 180_000,
        },
      ],
});
