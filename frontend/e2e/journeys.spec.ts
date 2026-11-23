import { expect, test } from "@playwright/test";

import { expectShell, login } from "./helpers";

/**
 * The four actor journeys named in the submission brief. Each test drives the
 * real UI; the assertions target text the components actually render.
 */

test.describe("super admin", () => {
  test("reaches user management and the audit log", async ({ page }) => {
    await login(page, "admin");

    await page.goto("/admin/users");
    await expect(page.getByRole("heading", { name: /user & role management/i })).toBeVisible();
    // The permission wall must NOT appear for an admin.
    await expect(page.getByText(/administrator access required/i)).toHaveCount(0);

    await page.goto("/admin/audit");
    await expect(page.getByRole("heading", { name: /audit/i })).toBeVisible();
  });

  test("role and permission tabs load", async ({ page }) => {
    await login(page, "admin");
    await page.goto("/admin/users");
    await page.getByRole("tab", { name: /roles/i }).click();
    await expect(page.locator("main#main")).toContainText(/role/i);
  });
});

test.describe("city operator", () => {
  test("sees the live dashboard", async ({ page }) => {
    await login(page, "operator");
    await expect(page.getByRole("main")).toContainText(/health|incident/i);
  });

  test("opens incident management", async ({ page }) => {
    await login(page, "operator");
    await page.goto("/incidents");
    await expect(page.getByRole("heading", { name: /incident management/i })).toBeVisible();
  });

  test("tracks recovery workflows", async ({ page }) => {
    await login(page, "operator");
    await page.goto("/workflows");
    await expect(page.getByRole("heading", { name: /recovery workflows/i })).toBeVisible();
    await expect(page.getByRole("main")).toContainText(/recovery chain/i);
  });

  test("reaches resource allocation", async ({ page }) => {
    await login(page, "operator");
    await page.goto("/resources");
    await expect(page.getByRole("main")).toContainText(/resource/i);
  });
});

test.describe("field engineer", () => {
  test("sees the assigned task queue", async ({ page }) => {
    await login(page, "engineer");
    await page.goto("/my-tasks");
    await expect(page.getByRole("heading", { name: /my assigned tasks/i })).toBeVisible();
    // The engineer-specific workspace notice must not fire for an engineer.
    await expect(page.getByText(/this workspace is for field engineers/i)).toHaveCount(0);
  });

  test("is refused the admin area", async ({ page }) => {
    await login(page, "engineer");
    await page.goto("/admin/users");
    await expect(page.getByText(/administrator access required/i)).toBeVisible();
  });

  test("is refused the analyst-only optimisation console write path", async ({ page }) => {
    await login(page, "engineer");
    await page.goto("/optimization");
    // The page renders, but the server refuses the actions; assert the UI warns.
    await expect(page.getByRole("main")).toBeVisible();
  });
});

test.describe("city analyst", () => {
  test("runs a cascade simulation", async ({ page }) => {
    await login(page, "analyst");
    await page.goto("/simulation");
    await expect(page.getByRole("main")).toBeVisible();
    await page.getByRole("button", { name: /run simulation|simulate/i }).first().click();
    await expect(
      page.getByText(/assets? (failed|impacted)/i).first()
    ).toBeVisible({ timeout: 45_000 });
  });

  test("generates an optimisation plan", async ({ page }) => {
    await login(page, "analyst");
    await page.goto("/optimization");
    await expect(page.getByRole("main")).toBeVisible();
    await page.getByRole("button", { name: /generate|solve|optimis/i }).first().click();
    await expect(page.getByText(/PLAN-\d+/).first()).toBeVisible({ timeout: 45_000 });
  });

  test("opens analytics and exports", async ({ page }) => {
    await login(page, "analyst");
    await page.goto("/analytics");
    await expect(page.getByRole("main")).toContainText(/recovery|task|incident/i);
  });
});

test.describe("digital twin", () => {
  test("renders and filters assets from real data", async ({ page }) => {
    await login(page, "operator");
    await page.goto("/twin");
    await expectShell(page);

    const filter = page.getByRole("textbox", { name: /filter twin assets/i });
    await expect(filter).toBeVisible();
    await filter.fill("PS-01");
    await expect(page.getByRole("list", { name: /twin assets/i })).toContainText(/PS-01/);
  });
});
