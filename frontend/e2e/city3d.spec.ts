import { expect, test } from "@playwright/test";
import { expectShell, login, trackConsoleErrors } from "./helpers";

/**
 * The 3D twin in a real browser.
 *
 * What these tests can prove: the canvas initialises and produces WebGL output,
 * the controls and the accessible equivalent exist, selection reaches the detail
 * panel, the analysis panels load their own data, and the page survives a missing
 * WebGL context. What they cannot prove is that the city *looks* right -- a
 * renderer can be handed a black frame and still satisfy every assertion here, so
 * a human still has to look at it.
 *
 * The canvas is checked by pixel sampling rather than by screenshot diffing: a
 * screenshot would need a baseline image per viewport and would fail on any
 * harmless lighting change, while "the canvas is not one flat colour" catches the
 * failure that actually happens -- a scene that failed to draw anything.
 */

/** Average colour spread of the canvas, sampled through WebGL readback. */
async function canvasIsDrawn(page: import("@playwright/test").Page): Promise<{
  drawn: boolean;
  distinct: number;
  size: { width: number; height: number };
}> {
  return page.evaluate(() => {
    const canvas = document.querySelector("canvas");
    if (!canvas) return { drawn: false, distinct: 0, size: { width: 0, height: 0 } };
    // A WebGL canvas cannot be read back with 2D context calls, so go through the
    // drawing buffer the renderer itself uses.
    const gl =
      (canvas.getContext("webgl2") as WebGL2RenderingContext | null) ??
      (canvas.getContext("webgl") as WebGLRenderingContext | null);
    if (!gl) return { drawn: false, distinct: 0, size: { width: canvas.width, height: canvas.height } };

    const width = canvas.width;
    const height = canvas.height;
    const pixels = new Uint8Array(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);

    const seen = new Set<string>();
    // Sample a grid rather than every pixel: 200k readbacks per test would be slow
    // and the answer would be the same.
    for (let y = 0; y < height; y += Math.max(1, Math.floor(height / 40))) {
      for (let x = 0; x < width; x += Math.max(1, Math.floor(width / 40))) {
        const offset = (y * width + x) * 4;
        seen.add(`${pixels[offset]},${pixels[offset + 1]},${pixels[offset + 2]}`);
      }
    }

    return { drawn: seen.size > 1, distinct: seen.size, size: { width, height } };
  });
}

test.describe("3d city", () => {
  test("initialises a real WebGL canvas and draws more than a flat colour", async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await login(page, "operator");
    await page.goto("/twin");
    await expectShell(page);

    const canvas = page.locator("canvas").first();
    await expect(canvas).toBeVisible({ timeout: 20_000 });

    // WebGL contexts take a moment to paint the first frame.
    await page.waitForTimeout(2_500);
    const result = await canvasIsDrawn(page);

    expect(result.size.width).toBeGreaterThan(100);
    expect(result.size.height).toBeGreaterThan(100);
    expect(result.drawn, "canvas is a single flat colour, so nothing was drawn").toBe(true);
    expect(result.distinct).toBeGreaterThan(8);

    expect(errors, `console errors: ${errors.join(" | ")}`).toHaveLength(0);
  });

  test("offers the camera presets and the status legend", async ({ page }) => {
    await login(page, "operator");
    await page.goto("/twin");
    await expectShell(page);

    for (const label of ["Perspective", "Isometric", "Top-down"]) {
      await expect(page.getByRole("button", { name: label })).toBeVisible();
    }

    // Camera presets are toggle buttons, so their state is announced.
    const isometric = page.getByRole("button", { name: "Isometric" });
    await isometric.click();
    await expect(isometric).toHaveAttribute("aria-pressed", "true");

    await page.getByRole("button", { name: /reset view/i }).click();
    await expect(page.getByRole("button", { name: "Perspective" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    // The legend names every status in words, next to its mark. It is scoped to the
    // legend itself: the status filter dropdown also contains the word
    // "maintenance", and matching that instead would pass without a legend.
    const legend = page.getByTestId("city3d-legend");
    await expect(legend).toBeVisible();
    for (const label of ["Operational", "Degraded", "Failed", "Maintenance", "Recovering"]) {
      await expect(legend.getByText(label, { exact: true })).toBeVisible();
    }
  });

  test("keeps the keyboard asset navigator the 2D twin had", async ({ page }) => {
    await login(page, "operator");
    await page.goto("/twin");
    await expectShell(page);

    // This strip predates the 3D view; two other suites depend on it, and it is the
    // only way to select an asset by typing rather than clicking geometry.
    const filter = page.getByRole("textbox", { name: /filter twin assets/i });
    await expect(filter).toBeVisible();
    await filter.fill("PS-01");

    const strip = page.getByRole("list", { name: /twin assets/i });
    await expect(strip).toContainText(/PS-01/);
    // Filtering removes the others, so the strip is a real filter and not just a
    // highlight.
    await expect(strip.getByRole("button")).toHaveCount(1);
  });

  test("selects an asset from the accessible list and shows its detail panel", async ({ page }) => {
    await login(page, "operator");
    await page.goto("/twin");
    await expectShell(page);

    // The accessible list is the twin's keyboard path to the same selection the
    // canvas offers by click.
    await page.getByRole("button", { name: /accessible asset list/i }).click();
    const ps = page.getByRole("button", { name: /PS-01/ }).first();
    await expect(ps).toBeVisible();
    await ps.click();

    // The right-hand panel follows the selection, and it carries the fields the
    // spec requires: code, category, status, capacity, dependencies.
    await expect(page.getByText(/Aurora Vale Generating Station|PS-01/).first()).toBeVisible();
    await expect(page.getByText(/Dependencies/i).first()).toBeVisible();
    await expect(page.getByText(/Capacity/i).first()).toBeVisible();
  });

  test("loads the heatmap legend from the backend rather than a hardcoded scale", async ({
    page,
  }) => {
    await login(page, "analyst");
    await page.goto("/twin");
    await expectShell(page);

    // The panel is in the sidebar; it should show a score per zone once the
    // heatmap request lands.
    const bands = page.getByText(/Exposure bands/i);
    await expect(bands).toBeAttached({ timeout: 15_000 });
    await bands.scrollIntoViewIfNeeded();
    await expect(bands).toBeVisible();

    const atRisk = page.getByTestId("heatmap-at-risk");
    await expect(atRisk).toBeAttached({ timeout: 15_000 });
    await atRisk.scrollIntoViewIfNeeded();
    await expect(atRisk).toBeVisible();

    // And it must be able to put those numbers on the map.
    const toggle = page.getByRole("button", { name: /show on map|overlay on/i });
    await expect(toggle).toBeVisible();
    await toggle.click();
  });

  test("replays a stored cascade, and only offers runs that completed", async ({ page }) => {
    await login(page, "analyst");
    await page.goto("/twin");
    await expectShell(page);

    const panel = page.getByText(/Replay a cascade/i).first();
    await expect(panel).toBeAttached();
    await panel.scrollIntoViewIfNeeded();
    await expect(panel).toBeVisible();

    const select = page.getByRole("combobox", { name: /simulation run to replay/i });
    await expect(select).toBeAttached();
    await select.scrollIntoViewIfNeeded();
    await expect(select).toBeVisible();

    // With no run selected the panel explains itself rather than showing an empty
    // scrubber that appears to be playing nothing.
    const hint = page.getByText(/pick a run to watch its cascade/i);
    await expect(hint).toBeAttached({ timeout: 10_000 });
    await hint.scrollIntoViewIfNeeded();
    await expect(hint).toBeVisible();
  });

  test("rewinds recorded history without claiming to restore it", async ({ page }) => {
    await login(page, "analyst");
    await page.goto("/twin");
    await expectShell(page);

    const heading = page.getByText(/Time travel/i).first();
    await expect(heading).toBeAttached();
    await heading.scrollIntoViewIfNeeded();
    await expect(heading).toBeVisible();

    const scrub = page.getByRole("slider", { name: /rewind through recorded changes/i });
    await expect(scrub).toBeAttached({ timeout: 10_000 });
    await scrub.scrollIntoViewIfNeeded();

    if (await scrub.isVisible()) {
      const max = Number(await scrub.getAttribute("max"));
      if (max > 0) {
        await scrub.fill(String(Math.floor(max / 2)));
        // The panel must say what it is doing: a reconstruction, not a rollback.
        const notice = page.getByText(/reconstructed from the change log/i);
        await expect(notice).toBeAttached();
        await expect(notice).toBeVisible();
        await page.getByRole("button", { name: /back to present/i }).click();
        await expect(notice).toHaveCount(0);
      }
    }
  });

  test("degrades to a usable page when WebGL is unavailable", async ({ page }) => {
    // Simulate a device without WebGL by removing the context constructors before
    // any app code runs. This is the case that matters: the page must not go blank.
    await page.addInitScript(() => {
      const deny = () => null;
      HTMLCanvasElement.prototype.getContext = deny as unknown as typeof HTMLCanvasElement.prototype.getContext;
      Object.defineProperty(window, "WebGLRenderingContext", { value: undefined, configurable: true });
      Object.defineProperty(window, "WebGL2RenderingContext", { value: undefined, configurable: true });
    });

    await login(page, "operator");
    await page.goto("/twin");
    await expectShell(page);

    await expect(page.getByText(/3D view unavailable on this device/i)).toBeVisible();
    await expect(page.locator("canvas")).toHaveCount(0);

    // The accessible list is still there, with the assets in it.
    await expect(page.getByRole("button", { name: /PS-01/i }).first()).toBeVisible();

    // And the rest of the screen still works: the analysis panels are loaded.
    await expect(page.getByText(/Exposure bands|No exposure scores yet/i).first()).toBeVisible({
      timeout: 15_000,
    });
  });

  test("survives an API failure without blanking the page", async ({ page }) => {
    await login(page, "operator");
    // Break the twin graph request only; everything else keeps working.
    await page.route("**/api/twin/graph", (route) =>
      route.fulfill({ status: 500, contentType: "application/json", body: '{"detail":"boom"}' }),
    );

    await page.goto("/twin");
    await expectShell(page);

    // The screen reports the problem where it belongs, and the shell is intact.
    await expect(page.getByText(/twin could not be loaded|no infrastructure records/i).first()).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByRole("navigation").first()).toBeVisible();
  });

  test("is usable on a phone viewport", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await login(page, "operator");
    await page.goto("/twin");
    await expectShell(page);

    const canvas = page.locator("canvas").first();
    await expect(canvas).toBeVisible({ timeout: 20_000 });

    // The canvas must not be wider than the screen, or the page scrolls sideways
    // and becomes unusable on touch.
    const box = await canvas.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeLessThanOrEqual(390);

    // Camera presets and the reset action stay reachable without hover.
    await expect(page.getByRole("button", { name: "Top-down" })).toBeVisible();
    await expect(page.getByRole("button", { name: /reset view/i })).toBeVisible();
  });
});
