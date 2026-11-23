import { expect, type Page } from "@playwright/test";

export const DEMO = {
  operator: { email: "operator@symbiotic.city", password: "Operator#2026" },
  analyst: { email: "analyst@symbiotic.city", password: "Analyst#2026" },
  engineer: { email: "engineer@symbiotic.city", password: "Engineer#2026" },
  admin: { email: "admin@symbiotic.city", password: "Admin#2026" },
} as const;

export type DemoRole = keyof typeof DEMO;

/** Sign in through the real form, exactly as a user would. */
export async function login(page: Page, role: DemoRole = "operator", next?: string) {
  await page.goto(next ? `/login?next=${encodeURIComponent(next)}` : "/login");

  await page.getByLabel(/^email address$/i).fill(DEMO[role].email);
  await page.getByLabel(/^password$/i).fill(DEMO[role].password);
  await page.getByRole("button", { name: /sign in/i }).click();

  await expect(page).toHaveURL(/\/dashboard/, { timeout: 20_000 });
  return page;
}

/** Collect console errors and unhandled rejections so a test can assert none occurred. */
export function trackConsoleErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

/** The authenticated shell renders a nav landmark and a main region. */
export async function expectShell(page: Page) {
  await expect(page.locator("main#main")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("navigation").first()).toBeVisible();
}
