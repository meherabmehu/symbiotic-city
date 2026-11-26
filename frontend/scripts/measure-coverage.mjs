import { chromium } from "@playwright/test";

const spc = (await import("/tmp/pwchromium/node_modules/@sparticuz/chromium/build/index.js")).default;
const browser = await chromium.launch({ executablePath: await spc.executablePath(), args: spc.args, headless: true });

const RESOS = [[1920, 1080], [1440, 900], [1366, 768], [1024, 768], [390, 844]];

async function login(page) {
  await page.goto("http://127.0.0.1:3010/login");
  await page.getByLabel(/^email address/i).fill("operator@symbiotic.city");
  await page.getByLabel(/^password/i).fill("Operator#2026");
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL(/\/dashboard/, { timeout: 20000 });
}

async function settled(page, timeoutMs = 25000) {
  await page.waitForFunction(() => window.__city3d?.ready === true, null, { timeout: 30000 });
  await page.waitForTimeout(1500); // let the reframe start moving first
  const deadline = Date.now() + timeoutMs;
  let prev = null, stable = 0, reading = null;
  while (Date.now() < deadline) {
    reading = await page.evaluate(() => window.__city3d?.coverage() ?? null);
    if (reading && !reading.clipped) {
      const current = { width: reading.widthPct, position: reading.camera?.position ?? [] };
      const moved =
        prev &&
        (Math.abs(current.width - prev.width) > 0.5 ||
          current.position.some((v, i) => Math.abs(v - (prev.position[i] ?? v)) > 1));
      if (moved || !prev) stable = 0;
      else stable += 1;
      prev = current;
      if (stable >= 2) return reading;
    }
    await page.waitForTimeout(250);
  }
  return reading;
}

const results = [];
for (const [w, h] of RESOS) {
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  await login(page);
  await page.goto("http://127.0.0.1:3010/twin");
  await page.waitForSelector('[data-testid="city3d-canvas"] canvas', { timeout: 30000 });

  const def = await settled(page);
  results.push({ reso: `${w}x${h}`, state: "default", cov: def });
  await page.screenshot({ path: `/tmp/p0-${w}x${h}-default.png` });

  if (w >= 1024) {
    await page.getByRole("button", { name: /fit city/i }).click();
    const fit = await settled(page);
    results.push({ reso: `${w}x${h}`, state: "fit", cov: fit });
    await page.screenshot({ path: `/tmp/p0-${w}x${h}-fit.png` });

    await page.getByRole("button", { name: /reset view/i }).click();
    const reset = await settled(page);
    results.push({ reso: `${w}x${h}`, state: "reset", cov: reset });

    await page.getByRole("button", { name: /^isometric$/i }).click();
    const iso = await settled(page);
    results.push({ reso: `${w}x${h}`, state: "isometric", cov: iso });

    await page.getByRole("button", { name: /top-down/i }).click();
    const top = await settled(page);
    results.push({ reso: `${w}x${h}`, state: "top", cov: top });

    await page.getByRole("button", { name: /^perspective$/i }).click();
    await settled(page);
    await page.getByRole("button", { name: /^expand$/i }).click();
    const exp = await settled(page);
    results.push({ reso: `${w}x${h}`, state: "expanded", cov: exp });
    await page.screenshot({ path: `/tmp/p0-${w}x${h}-expanded.png` });
    await page.getByRole("button", { name: /fit panel/i }).click();
  }

  await page.reload();
  await page.waitForSelector('[data-testid="city3d-canvas"] canvas', { timeout: 30000 });
  const after = await settled(page);
  results.push({ reso: `${w}x${h}`, state: "after-refresh", cov: after });
  await page.close();
}

for (const r of results) {
  const c = r.cov;
  if (!c) { console.log(`${r.reso} ${r.state}: NO READING`); continue; }
  if (c.clipped) { console.log(`${r.reso} ${r.state}: CLIPPED`); continue; }
  console.log(
    `${r.reso.padEnd(9)} ${r.state.padEnd(14)} w=${c.widthPct.toFixed(1)}% h=${c.heightPct.toFixed(1)}% ` +
    `ndc=[${c.ndc.minX.toFixed(2)},${c.ndc.maxX.toFixed(2)}]x[${c.ndc.minY.toFixed(2)},${c.ndc.maxY.toFixed(2)}] ` +
    `cam=${Math.hypot(...c.camera.position).toFixed(0)} viewport=${c.viewport.width}x${c.viewport.height}`,
  );
}
await browser.close();
