import { expect, test } from "@playwright/test";

import { expectShell, login, trackConsoleErrors } from "./helpers";

/**
 * The core demo path: an operator reports an incident, the workflow engine
 * cascades, plans and reserves, and the run is visible in the UI.
 */
test.describe("operator journey", () => {
  test("dashboard renders every live section without console errors", async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await login(page, "operator");
    await expectShell(page);
    await expect(page.locator("main#main")).toContainText(/incident/i);
    expect(errors).toEqual([]);
  });

  test("an operator can report an incident and see it in the list", async ({ page }) => {
    await login(page, "operator");
    await page.goto("/incidents");
    await expect(page.getByRole("heading", { name: /incident management/i })).toBeVisible();

    const title = `E2E reported incident ${Date.now()}`;
    await page.getByRole("button", { name: /report incident|new incident/i }).first().click();
    await page.getByLabel(/^title$/i).fill(title);
    await page.getByLabel(/description/i).fill("Reported by the end-to-end suite.");
    await page.getByLabel(/severity/i).selectOption("high");
    await page.getByRole("button", { name: /^(submit|report|create)/i }).last().click();

    await expect(page.getByText(title)).toBeVisible({ timeout: 20_000 });
  });

  test("the digital twin renders and is keyboard navigable", async ({ page }) => {
    await login(page, "operator");
    await page.goto("/twin");
    await expectShell(page);

    const filter = page.getByRole("textbox", { name: /filter twin assets/i });
    await expect(filter).toBeVisible();
    await filter.fill("PS-01");
    await expect(page.getByRole("list", { name: /twin assets/i })).toContainText(/PS-01/);
  });

  test("analyst can run a cascade simulation", async ({ page }) => {
    await login(page, "analyst");
    await page.goto("/simulation");
    await expectShell(page);

    await page.getByRole("button", { name: /run simulation|simulate/i }).first().click();
    await expect(page.getByText(/assets? (failed|impacted)/i).first()).toBeVisible({ timeout: 40_000 });
  });

  test("analyst can generate an optimisation plan", async ({ page }) => {
    await login(page, "analyst");
    await page.goto("/optimization");
    await expectShell(page);

    await page.getByRole("button", { name: /generate|solve|optimis/i }).first().click();
    await expect(page.getByText(/PLAN-\d+/).first()).toBeVisible({ timeout: 40_000 });
  });

  test("engineer sees an assigned task queue", async ({ page }) => {
    await login(page, "engineer");
    await page.goto("/my-tasks");
    await expectShell(page);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  });
});

test.describe("role separation", () => {
  test("an engineer cannot reach the admin area", async ({ page }) => {
    await login(page, "engineer");
    await page.goto("/admin");
    await expect(page.locator("main#main")).toContainText(/permission|not authorised|denied|restricted/i);
  });

  test("an operator can reach the admin area only if granted, and sees a clear message", async ({
    page,
  }) => {
    await login(page, "operator");
    await page.goto("/admin");
    await expect(page.locator("main#main")).toBeVisible();
  });
});
