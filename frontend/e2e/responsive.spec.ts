import { expect, test } from "@playwright/test";

import { expectShell, login } from "./helpers";

/**
 * Layout checks that only a real browser can make: no horizontal overflow and
 * navigation reachable at mobile width. Runs under the "mobile" project
 * (Pixel 7, 412x915) as well as chromium at desktop size.
 */
const ROUTES = ["/dashboard", "/incidents", "/twin", "/simulation", "/optimization", "/my-tasks"];

test.describe("responsive layout", () => {
  for (const route of ROUTES) {
    test(`${route} has no horizontal overflow at this viewport`, async ({ page }) => {
      await login(page);
      await page.goto(route);
      await expectShell(page);

      const overflow = await page.evaluate(() => {
        const { scrollWidth, clientWidth } = document.documentElement;
        return { scrollWidth, clientWidth };
      });
      // Allow a 1px rounding difference; anything more is a real overflow.
      expect(overflow.scrollWidth - overflow.clientWidth).toBeLessThanOrEqual(1);
    });
  }

  test("navigation is reachable on a small screen", async ({ page }) => {
    await login(page);
    const toggle = page.getByRole("button", { name: /menu|navigation/i }).first();
    if (await toggle.isVisible()) {
      await toggle.click();
    }
    await expect(page.getByRole("navigation").first()).toBeVisible();
  });

  test("the skip link becomes visible on focus", async ({ page }) => {
    await login(page);
    await page.keyboard.press("Tab");
    const skip = page.getByRole("link", { name: /skip to main content/i });
    await expect(skip).toBeVisible();
  });
});
