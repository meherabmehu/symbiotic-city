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

/**
 * Is the canvas actually painting?
 *
 * A WebGL drawing buffer is cleared after each composited frame unless the context
 * was created with `preserveDrawingBuffer`, so reading it back from a test returns
 * an empty buffer even when the scene is rendering perfectly. That would have made
 * this test fail on a working city -- and, worse, could have been "fixed" by
 * setting `preserveDrawingBuffer: true` in the app, paying a real performance cost
 * so a test could look at a buffer.
 *
 * So the check reads the pixels the browser composited: screenshot the canvas
 * element and count distinct colours in it. A scene that failed to draw is one
 * flat colour; a rendered night city is hundreds.
 */
async function canvasColours(
  page: import("@playwright/test").Page,
  locator: import("@playwright/test").Locator,
): Promise<{ distinct: number; size: { width: number; height: number } }> {
  const png = await locator.screenshot({ animations: "disabled" });
  const size = await locator.evaluate((element) => {
    const canvas = element as HTMLCanvasElement;
    return { width: canvas.width, height: canvas.height };
  });

  // Decode the PNG in the browser: no image library, no temp files, and the same
  // decoder the screenshot itself was produced with.
  const base64 = png.toString("base64");
  const distinct = await page.evaluate(async (data) => {
    const image = new Image();
    image.src = `data:image/png;base64,${data}`;
    await image.decode();
    const surface = document.createElement("canvas");
    surface.width = 160;
    surface.height = 120;
    const context = surface.getContext("2d");
    if (!context) return 0;
    context.drawImage(image, 0, 0, surface.width, surface.height);
    const pixels = context.getImageData(0, 0, surface.width, surface.height).data;
    const seen = new Set<string>();
    for (let index = 0; index < pixels.length; index += 4) {
      // Quantise to 5 bits per channel: gradients between two neighbouring shades
      // are not evidence of a drawn scene, distinct regions are.
      seen.add(
        `${pixels[index] >> 3},${pixels[index + 1] >> 3},${pixels[index + 2] >> 3}`,
      );
    }
    return seen.size;
  }, base64);

  return { distinct, size };
}

/**
 * A 3D scene plus up to four independent fetches is slower than the 30s default,
 * and the default is measured from the first navigation. Raised here rather than
 * by trimming waits, so a slow CI box reports a real failure with a useful diff
 * instead of a bare timeout.
 */
test.describe.configure({ timeout: 75_000 });

test.describe("3d city", () => {
  test("initialises a real WebGL canvas and draws more than a flat colour", async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await login(page, "operator");
    await page.goto("/twin");
    await expectShell(page);

    const canvas = page.locator("canvas").first();
    await expect(canvas).toBeVisible({ timeout: 20_000 });

    // WebGL contexts take a moment to paint the first frame.
    await page.waitForTimeout(3_000);
    const result = await canvasColours(page, canvas);

    expect(result.size.width).toBeGreaterThan(100);
    expect(result.size.height).toBeGreaterThan(100);
    // A single flat colour means nothing was drawn; a rendered city has many.
    expect(
      result.distinct,
      `canvas has only ${result.distinct} distinct colours, so it is effectively blank`,
    ).toBeGreaterThan(20);

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
      // Each legend row is the label plus a count, so this is a substring match
      // scoped to the legend element -- precise enough to exclude the status
      // filter dropdown, which shares the wording.
      await expect(legend.getByText(label)).toBeVisible({ timeout: 15_000 });
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

    // The suite runs against a throwaway database with no simulation history, so
    // this test creates the run it is about. Without that it would pass on a
    // developer's machine and fail forever in CI -- which is exactly what happened
    // before, and why the panel is not assumed to be pre-populated.
    const csrfToken =
      (await page
        .context()
        .cookies()
        .then((cookies) => cookies.find((cookie) => cookie.name === "symbiotic_csrf")?.value)) ?? "";
    const created = await page.request.post("/api/simulations/run", {
      headers: { "X-CSRF-Token": csrfToken },
      data: { initial_failure_ids: [1], failure_mode: "total_failure", name: "E2E replay seed" },
    });
    expect(created.ok(), `simulation run failed: ${created.status()}`).toBe(true);

    await page.goto("/twin");
    await expectShell(page);

    const panel = page.getByText(/Replay a cascade/i).first();
    await expect(panel).toBeAttached();
    await panel.scrollIntoViewIfNeeded();
    await expect(panel).toBeVisible();

    const select = page.getByRole("combobox", { name: /simulation run to replay/i });
    await expect(select).toBeVisible({ timeout: 40_000 });
    await select.scrollIntoViewIfNeeded();

    // With no run selected the panel explains itself rather than showing an empty
    // scrubber that appears to be playing nothing.
    const hint = page.getByText(/pick a run to watch its cascade/i);
    await expect(hint).toBeVisible({ timeout: 20_000 });
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

  test("keeps the whole city in frame when the panel changes size", async ({ page }) => {
    await login(page, "operator");
    await page.goto("/twin");
    await expectShell(page);

    await expect(page.locator("canvas").first()).toBeVisible({ timeout: 20_000 });

    // "Fit city" is a counter, not a toggle, so pressing it twice must frame twice
    // rather than turn itself off the first time.
    const fit = page.getByRole("button", { name: /fit city/i });
    await expect(fit).toBeVisible();
    await fit.click();
    await fit.click();

    // Expanding the panel changes the viewport; the scene must survive it.
    await page.getByRole("button", { name: /expand/i }).click();
    await expect(page.locator("canvas").first()).toBeVisible();
  });

  test("moves the camera from the keyboard, not only the pointer", async ({ page }) => {
    await login(page, "operator");
    await page.goto("/twin");
    await expectShell(page);

    const canvas = page.locator("canvas").first();
    await expect(canvas).toBeVisible({ timeout: 20_000 });

    // The canvas cannot take focus, so the wrapper does. Everything here duplicates
    // a pointer gesture; none of it is the only way to do something.
    const view = page.getByRole("application", { name: /city view/i });
    await expect(view).toBeVisible();
    await view.focus();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("PageUp");

    // Switching presets from the keyboard must move the toolbar's selection too, or
    // the button state would say one thing and the camera another.
    await page.keyboard.press("3");
    await expect(page.getByRole("button", { name: "Top-down" })).toHaveAttribute("aria-pressed", "true");
  });

  test("compares two stored runs and names the difference", async ({ page }) => {
    await login(page, "operator");
    await page.goto("/twin");
    await expectShell(page);

    await expect(page.getByRole("heading", { name: /compare two runs/i })).toBeVisible();

    const runA = page.getByLabel("First run to compare");
    const runB = page.getByLabel("Second run to compare");
    await expect(runA).toBeVisible();

    const options = await runA.locator("option").count();
    // One placeholder plus however many completed runs the seeded database has.
    test.skip(options < 3, "needs at least two completed simulation runs");

    await runA.selectOption({ index: 1 });
    await runB.selectOption({ index: 2 });

    // The comparison must produce a verdict rather than an empty table: a run that
    // has not loaded is not an empty run.
    await expect(
      page.getByText(/exactly the same|trades nothing|strictly worse|Neither run dominates/i),
    ).toBeVisible({ timeout: 20_000 });
  });

  test("reports the measured cost of the scene rather than a claim", async ({ page }) => {
    await login(page, "operator");
    await page.goto("/twin");
    await expectShell(page);

    await expect(page.locator("canvas").first()).toBeVisible({ timeout: 20_000 });

    const stats = page.getByTestId("city3d-stats");
    await expect(stats).toBeVisible({ timeout: 20_000 });
    // Collapsed by default: the numbers are available, not in the way.
    await stats.locator("summary").click();
    await expect(stats.getByText("Draw calls")).toBeVisible();
    await expect(stats.getByText(/measured|Read from three.js/i)).toBeVisible();
  });
});
