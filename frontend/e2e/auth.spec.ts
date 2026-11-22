import { expect, test } from "@playwright/test";

import { DEMO, expectShell, login, trackConsoleErrors } from "./helpers";

test.describe("landing page", () => {
  test("reproduces the reference design copy", async ({ page }) => {
    await page.goto("/");

    await expect(page.getByRole("heading", { level: 1 })).toContainText(/SYMBIOTIC CITY/i);
    await expect(page.getByText(/LIVE DIGITAL TWIN/i)).toBeVisible();
    await expect(
      page.getByText("A unified command layer for the resilient, responsive city.")
    ).toBeVisible();
    await expect(page.getByRole("link", { name: /^login$/i }).first()).toBeVisible();
    await expect(page.getByRole("link", { name: /^register$/i }).first()).toBeVisible();
    await expect(page.getByRole("contentinfo")).toContainText(/SYMBIOTIC CITY/);
  });

  test("is reachable without a session and renders without console errors", async ({ page }) => {
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

  test("every demo role can sign in and land on the dashboard", async ({ page }) => {
    for (const role of Object.keys(DEMO) as (keyof typeof DEMO)[]) {
      await login(page, role);
      await expectShell(page);
      await page.context().clearCookies();
    }
  });

  test("signing out ends the session", async ({ page }) => {
    await login(page);
    // Sign out lives in the account menu in the header.
    await page.getByRole("button", { name: /@symbiotic\.city/i }).last().click();
    await page.getByRole("menuitem", { name: /sign out/i }).click();
    await expect(page).toHaveURL(/\/login/);

    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/login/);
  });
});
