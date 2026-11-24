import { expect, test } from "@playwright/test";

import { type DemoRole, expectShell, login } from "./helpers";

/**
 * Layout checks that only a real browser can make: no horizontal overflow and
 * navigation reachable at mobile width. Runs under the "mobile" project
 * (Pixel 7, 412x915) as well as chromium at desktop size.
 */
/**
 * Every authenticated route, paired with a role that can actually load it, so a
 * narrow viewport cannot overflow on a screen no test visits. Pages whose data
 * the role lacks render their "requires this permission" panel instead of the
 * table, so the permission-sensitive ones are driven as the role that owns them:
 * resource, task and workflow reads are closed to the analyst, and the operator
 * and analyst share every other domain.
 */
const ROUTES: { path: string; role: DemoRole }[] = [
  { path: "/dashboard", role: "operator" },
  { path: "/incidents", role: "operator" },
  { path: "/twin", role: "operator" },
  { path: "/simulation", role: "operator" },
  { path: "/optimization", role: "operator" },
  { path: "/my-tasks", role: "operator" },
  // Added: these were never covered at a narrow viewport.
  { path: "/tasks", role: "engineer" },
  { path: "/workflows", role: "operator" },
  { path: "/infrastructure", role: "operator" },
  { path: "/resources", role: "operator" },
  { path: "/analytics", role: "analyst" },
  { path: "/notifications", role: "operator" },
  { path: "/profile", role: "operator" },
  { path: "/docs", role: "operator" },
  // The resilience page is the widest of the new screens: a map, a ranked table
  // and a comparison table. The analyst holds resilience:plan, so the planning
  // panels render rather than their permission notice.
  { path: "/resilience", role: "analyst" },
  // Administration screens are the widest (dense tables) and the most likely to
  // overflow, so they are covered explicitly rather than assumed.
  { path: "/admin/users", role: "admin" },
  { path: "/admin/audit", role: "admin" },
  { path: "/admin/settings", role: "admin" },
];

test.describe("responsive layout", () => {
  for (const { path: route, role } of ROUTES) {
    test(`${route} has no horizontal overflow at this viewport`, async ({ page }) => {
      await login(page, role);
      await page.goto(route);
      await expectShell(page);

      const overflow = await page.evaluate(() => {
        const { scrollWidth, clientWidth } = document.documentElement;
        const limit = clientWidth + 1;
        // Name the widest element so a failure reports the cause, not just a number.
        let widest = { selector: "", right: 0 };
        for (const element of Array.from(document.querySelectorAll("body *"))) {
          const box = element.getBoundingClientRect();
          if (box.width === 0 || box.right <= limit) continue;
          if (box.right > widest.right) {
            const classes =
              typeof element.className === "string" && element.className
                ? `.${element.className.trim().split(/\s+/).slice(0, 4).join(".")}`
                : "";
            widest = {
              selector: `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ""}${classes}`,
              right: Math.round(box.right),
            };
          }
        }
        return { scrollWidth, clientWidth, widest };
      });
      // Allow a 1px rounding difference; anything more is a real overflow.
      expect(
        overflow.scrollWidth - overflow.clientWidth,
        `widest overflowing element: ${overflow.widest.selector} (right edge ${overflow.widest.right}px)`,
      ).toBeLessThanOrEqual(1);
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
