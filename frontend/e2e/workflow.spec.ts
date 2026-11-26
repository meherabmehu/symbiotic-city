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

    // The API allows only one active incident per asset and category and answers
    // 409 otherwise, and this suite is not always running against a fresh
    // database: a previous run's report on the form's default asset may still be
    // open. Pick an asset that is free rather than assuming the first one is, so
    // the create path is exercised on every run -- the assertion below is
    // unchanged, only the precondition is made honest.
    await page.locator("#inc-asset option").first().waitFor({ state: "attached" });
    const busy = await page.evaluate(async () => {
      const response = await fetch("/api/incidents?page_size=100", { credentials: "include" });
      const body = await response.json();
      return ((body.data ?? []) as { resolved_at: string | null; primary_asset_id: number }[])
        .filter((incident) => incident.resolved_at === null)
        .map((incident) => incident.primary_asset_id);
    });
    const free = await page
      .locator("#inc-asset option")
      .evaluateAll(
        (options, busyIds) =>
          options
            .map((option) => Number((option as HTMLOptionElement).value))
            .filter((id) => !busyIds.includes(id)),
        busy,
      );
    expect(free.length, "every asset already has an open incident").toBeGreaterThan(0);
    await page.locator("#inc-asset").selectOption(String(free[0]));

    await page.getByLabel(/^title/i).fill(title);
    await page.getByLabel(/description/i).fill("Reported by the end-to-end suite.");
    // The page also has a "Filter by severity" select, so target the form field.
    await page.locator("#inc-severity").selectOption("high");
    await page.getByRole("button", { name: /^(submit|report|create)/i }).last().click();

    await expect(page.getByText(title)).toBeVisible({ timeout: 15_000 });
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

    // Nothing is selected by default, and run() correctly refuses to simulate an
    // empty failure set, so pick the first asset as the initial failure.
    const failureList = page.getByRole("group", { name: /initial failure assets/i });
    await failureList.getByRole("checkbox").first().check();
    await expect(failureList.getByRole("checkbox").first()).toBeChecked();

    await page.getByRole("button", { name: /run simulation|simulate/i }).first().click();
    await expect(page.getByText(/assets failed/i).first()).toBeVisible({ timeout: 25_000 });
  });

  test("analyst can generate an optimisation plan", async ({ page }) => {
    await login(page, "analyst");
    await page.goto("/optimization");
    await expectShell(page);

    // The solver refuses an empty demand set, so add one asset that needs power.
    await expect(page.getByText(/0 assets ·/)).toBeVisible();
    await page.getByRole("button", { name: /add demand/i }).click();

    const demandDialog = page.getByRole("dialog", { name: /add a demand/i });
    await expect(demandDialog).toBeVisible();
    // Target an asset by its code: the dialog's first button is "Close dialog".
    await demandDialog.getByRole("button", { name: /[A-Z]{2,3}-\d+/ }).first().click();

    // The demand must actually land in the list before solving, otherwise the
    // planner is asked to solve nothing and correctly refuses.
    await expect(page.getByText(/1 assets ·/)).toBeVisible({ timeout: 10_000 });
    // "Preview solve" also matches /solve/ and comes first in the DOM, so name the
    // persist button exactly; otherwise the click lands on Preview.
    const solveButton = page.getByRole("button", { name: /solve & persist/i });
    await expect(solveButton).toBeEnabled();

    // Watch the actual request rather than only the screen: if the solve is
    // rejected, the test should report the API's status and body, not an
    // anonymous navigation timeout.
    const solveResponse = page.waitForResponse(
      (response) =>
        response.url().includes("/optimization/requests") &&
        response.request().method() === "POST",
      { timeout: 25_000 },
    );
    await solveButton.click();

    const response = await solveResponse;
    if (!response.ok()) {
      const detail = (await response.text()).slice(0, 600);
      throw new Error(`The planner rejected the plan (${response.status()}): ${detail}`);
    }

    // A successful solve navigates to the persisted plan, whose header carries its code.
    await page.waitForURL(/\/optimization\/plans\//, { timeout: 25_000 });
    await expect(page.getByText(/PLAN-\d+/).first()).toBeVisible({ timeout: 15_000 });
  });

  test("engineer sees an assigned task queue", async ({ page }) => {
    await login(page, "engineer");
    await page.goto("/my-tasks");
    await expectShell(page);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  });
});

test.describe("role separation", () => {
  test("an engineer is refused the user management screen", async ({ page }) => {
    await login(page, "engineer");
    await page.goto("/admin/users");
    await expect(page.locator("main#main")).toContainText(
      /administrator access required|permission|not authorised|denied|restricted/i
    );
  });

  test("an operator is refused the user management screen", async ({ page }) => {
    await login(page, "operator");
    await page.goto("/admin/users");
    await expect(page.locator("main#main")).toContainText(
      /administrator access required|permission|not authorised|denied|restricted/i
    );
  });

  test("an engineer has no admin entries in the navigation", async ({ page }) => {
    await login(page, "engineer");
    await expectShell(page);
    const nav = page.getByRole("navigation").first();
    await expect(nav).not.toContainText(/user & role management|system audit logs/i);
  });
});
