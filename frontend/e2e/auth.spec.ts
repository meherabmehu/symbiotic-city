import { expect, test } from "@playwright/test";

import { DEMO, expectShell, login, trackConsoleErrors } from "./helpers";

test.describe("landing page", () => {
  test("reproduces the reference design copy", async ({ page }) => {
    await page.goto("/");

    await expect(page.getByRole("heading", { level: 1 })).toContainText(/SYMBIOTIC CITY/i);
    await expect(page.getByText(/LIVE DIGITAL TWIN/i).first()).toBeVisible();
    await expect(
      page.getByText("A unified command layer for the resilient, responsive city.")
    ).toBeVisible();
    await expect(page.getByRole("link", { name: /^login$/i }).first()).toBeVisible();
    await expect(page.getByRole("link", { name: /^register$/i }).first()).toBeVisible();
    await expect(page.getByRole("contentinfo")).toContainText(/SYMBIOTIC CITY/);
  });

  test("renders without console errors", async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    expect(errors).toEqual([]);
  });
});

test.describe("authentication", () => {
  test("protected routes send anonymous visitors to login", async ({ page }) => {
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/login/);
  });

  test("bad credentials show an inline error and stay on the form", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("Email address").fill("nobody@symbiotic.city");
    await page.getByLabel("Password").fill("WrongPass#2026");
    await page.getByRole("button", { name: /sign in/i }).click();

    await expect(page.getByRole("alert")).toBeVisible();
    await expect(page).toHaveURL(/\/login/);
  });

  test("the operator signs in and reaches the dashboard", async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await login(page, "operator");
    await expectShell(page);
    await expect(page.locator("main#main")).toContainText(/incident/i);
    expect(errors).toEqual([]);
  });

  test("the analyst signs in and reaches the dashboard", async ({ page }) => {
    await login(page, "analyst");
    await expectShell(page);
  });

  test("the engineer signs in and reaches the dashboard", async ({ page }) => {
    await login(page, "engineer");
    await expectShell(page);
  });

  test("the super admin signs in and reaches the dashboard", async ({ page }) => {
    await login(page, "admin");
    await expectShell(page);
  });

  test("signing out ends the session", async ({ page }) => {
    await login(page, "operator");
    // Sign out lives in the account menu in the header.
    const menu = page.locator('button[aria-haspopup="menu"]').last();
    await menu.click();
    await page.getByRole("menuitem", { name: /sign out/i }).click();
    await expect(page).toHaveURL(/\/login/);

    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/login/);
  });
});
