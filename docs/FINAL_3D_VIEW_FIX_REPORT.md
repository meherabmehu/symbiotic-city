# Final 3D View Fix Report

Scope: the broken 3D viewport on `/twin`, the reference dashboard composition,
camera framing, viewport controls, the metric-card row, and the verification
sweep that went with it. Every claim below is tagged **verified** (reproduced
here with a named check), **partial** (done, with a stated limit), or
**unverified** (not attempted — no claim is made).

Environment note: all browser checks ran headless on Chromium with software
WebGL (SwiftShader), driven through `PLAYWRIGHT_CHROMIUM_PATH` because
Playwright's browser CDN is unreachable from this network. No GPU machine, no
deployment target, and no other browser was involved.

---

## 1. The viewport bug — root cause and fix — **verified**

**Symptom (as reported):** the city rendered only in a short strip at the top
of the panel, with a large black void beneath it.

**Root cause:** `City3D` wrapped the R3F `<Canvas>` in a keyboard-handling
`<div>` that had no height. R3F's `Canvas` sizes itself to `height: 100%` of its
parent, so the chain `panel (height 600) → wrapper (auto → 0 content height →
measured 150px) → canvas` collapsed: the canvas was 856 × **150** instead of
856 × **560**. Everything below the canvas was the panel's remaining empty box.

**Fix:** the wrapper carries `className="h-full w-full"` so the panel's height
reaches the canvas. Measured before/after on the live page:

| Element | Before | After |
| --- | --- | --- |
| panel | 560 px | 560 px |
| keyboard wrapper | 150 px | 560 px |
| canvas | 150 px | 560 px |

Committed as `48d5b38` together with a regression test
(`e2e/city3d.spec.ts` → *"fills the panel instead of collapsing to a strip"*),
which asserts the canvas is at least 60% of the panel's height, and a second
test (*"keeps the whole city in frame when the panel changes size"*) that
resizes the panel and re-measures. Both pass — **verified** by the suite run
below.

## 2. Reference dashboard composition — **verified (layout), partial (pixel match)**

The attached reference image (`symbiotic_city_digital_twin_dashboard.png`) was
used as the target. The twin screen now composes as:

| Reference element | Implementation | Check |
| --- | --- | --- |
| Header with title + description | `PageHeader` — "Interactive 3D City" + reference subtitle | screenshot |
| Control row | one in-panel rail: status filter, Perspective/Isometric/Top-down (aria-pressed), Reset view, Fit city, Traffic, Scenery, quality select, Expand | `city3d.spec.ts` camera/legend/fit tests |
| Always-visible stats strip | `Scene cost: N meshes · Draw calls: N · FPS: N` (left) + `Live sync` + `Last update: …` (right), inside `<details data-testid="city3d-stats">` collapsed by default | `city3d.spec.ts` stats test asserts exact "Draw calls"/"Materials" only when expanded |
| Dominant viewport | full-width canvas at 600 px (720 px when expanded), legend inside bottom-left, tool rail inside left, compass + zoom stack inside right, scale bar inside bottom-right, floating landmark labels | screenshots + sizing tests |
| Bottom metric cards | `TwinMetricsRow`: Status (assets), City criticality, Active incidents, Population impact, Selected asset | screenshots; values sourced live (§3) |
| Selected-asset panel | `SelectedAssetCard` — type/zone/load/capacity/dependencies/redundancy/criticality/incidents from `GET /infrastructure/{id}` + `GET /incidents?asset_id=`, actions gated by permission | `city3d.spec.ts` selection test (PS-01 → Dependencies + Capacity) |

**Partial:** the match is judged by eye against the reference screenshot, not
by pixel diff. Known, deliberate differences: the global search box and
"LIVE DIGITAL TWIN" pill belong to the app shell (present, above the page);
exact spacing and type sizes were not measured against the reference.

Screenshots taken during this work: `/tmp/twin-v2.png` (desktop, default
framing), `/tmp/twin-mobile.png` (390 × 844), `/tmp/twin-expanded-selected.png`
(expanded with PS-01 selected).

## 3. Real backend integration — **verified**

No card or panel contains a hard-coded value. Each reads its own endpoint and
degrades independently:

| Card / panel | Endpoint | Field(s) |
| --- | --- | --- |
| Status census | `GET /twin/graph` | node `status` counts (TwinView filters internally; header badges use `stats.by_status`) |
| City criticality | `GET /resilience/criticality` | mean/peak/floor derived from `ranking[].criticality_index` via `lib/criticality.ts`; fleet counts from `fleet` |
| Active incidents | `GET /incidents/summary` → fallback graph flags | `active`, `total`, `counts`; 24 h delta from `GET /incidents?page_size=50&sort=reported_at&direction=desc` |
| Population impact | `GET /resilience/heatmap` (latest run) | `totals.population_at_risk` against Σ zone `population`; source labelled latest run / stored run / baseline |
| Selected asset | `GET /infrastructure/{id}` + `GET /incidents?asset_id={id}` | record fields, degrading to twin-graph values while loading |

Two real contract bugs were found and fixed during this verification:

1. **`CriticalityIndex.fleet` never matched the API.** The type claimed
   `mean_index`/`max_index`/`min_index`; the API returns
   `assets`/`total_dependencies`/`critical_assets`. The resilience page and the
   lens panel called `.toFixed()` on the phantom fields and would throw as soon
   as data loaded. Fixed by correcting the type and deriving statistics from
   the ranking (`dd6b851`). **Verified:** the twin page renders the mean
   (16.6) without console errors; `resilience` and the lens panel are covered
   by the responsive/workflow suites.
2. **The selected asset's incident list used a query parameter the API does
   not have.** `primary_asset_id` on `GET /incidents` is ignored by FastAPI, so
   the panel showed *every* incident as if it belonged to the selected asset
   (confirmed with `curl`: `primary_asset_id=1` returned incidents for other
   assets; the filter is called `asset_id`). Fixed in `f5378f9`. **Verified:**
   `asset_id=1` returns `[]`, and PS-01's card now shows a consistent
   "0 open" with no stray incident chips.

Both consumers of the corrected criticality type were checked directly after
the fix: `/twin` shows the derived mean (16.6) with no console errors, and
`/resilience` (analyst) renders its "assets scored" line with no page errors —
the `.toFixed` crash path is gone.

## 4. Camera framing (fit + opening shot) — **verified**

`fitPose` was rewritten to solve against the city's **projected bounding box**
(bisection on a hand-rolled perspective projection — still pure TypeScript, no
three.js import) instead of an analytic `halfWidth / tan(fov)` guess, which
framed the foreshortened ground plane badly and sat the city small in wide
viewports. Two intents, two functions:

- `fitPose` — the **Fit city** button: the whole model inside the frame,
  10 % margin, preset viewing direction kept (top-down stays overhead).
- `fillPose` — the **opening shot**: the reference composition — width to the
  side edges, far district inside the top, near boundary road allowed to crop
  at the bottom (`FILL_WIDTH`/`FILL_FAR`/`FILL_NEAR` allowances).

Both run through the same solver; the opening shot runs once the viewport size
has measured. **Verified:** `npm test` camera-framing cases pass (narrow
viewports pull back further, top-down direction preserved, whole city clears at
every aspect); before/after screenshots show the city filling the frame instead
of floating in the middle.

## 5. Viewport controls, labels, overlays — **verified**

- **Tool rail** (inside the canvas): orbit / pan / zones / network / fit.
- **Compass** (inside, top-right): rotates with the camera, `aria-label="North
  up — the compass rotates with the camera"`, deliberately not matching
  `/reset view/i` so it cannot steal the Reset-view lookup.
- **Zoom stack** `+` / `−`, scale bar recomputed from the live camera distance.
- **Floating landmark labels** (Power Station, Hospital, Water Facility,
  Substation, City Core) with collision *stacking*: labels that would overlap
  slide one row up rather than hiding, and clamp to the viewport top.
- **District discs toned down** — default fill 0.09 → 0.045, ring 0.45 → 0.28;
  a selected or heat-carrying zone still comes forward. They read as district
  orientation now, not five bright circles over the model.
- Status filter, traffic/scenery toggles, quality select, Expand — all live and
  covered by `city3d.spec.ts`.

**Verified** by screenshots and by the e2e interaction tests (camera presets +
aria-pressed, keyboard "3", fit counter, WebGL-denied and API-failure
fallbacks).

## 6. Tests — **verified**

| Check | Command | Result |
| --- | --- | --- |
| Types | `npx tsc --noEmit` | **0 errors** |
| Unit (vitest) | `npm test` | **107 passed / 9 files** |
| Browser (Playwright, chromium) | `npx playwright test` | **66 passed** — auth 9, city3d 15, journeys 13, responsive 20, workflow 9 |
| Production build | `npm run build` | **success** (27 dynamic routes) |
| Backend (pytest, SQLite) | `python -m pytest` | **277 passed, 10 skipped** |
| Dependencies | `npm audit` | **0 vulnerabilities** |

New/changed e2e coverage in this work: viewport-sizing regression, panel
resize keeps the city in frame, scene-stats strip, run compare, selected-asset
dossier, plus a fix to the incident-report journey so it is **repeatable** —
the API allows one active incident per asset+category (409), so the test now
picks an asset that does not already carry an open incident instead of
assuming a fresh database; its original assertion (the new title appears in
the list) is unchanged. It was run twice back-to-back green (**verified**).

No assertion was weakened to reach green.

## 7. Local-run docs — **verified**

`docs/SETUP.md` already covers install/run/e2e; this session added the missing
note for restricted networks: `PLAYWRIGHT_CHROMIUM_PATH=/path/to/chromium npm
run e2e` runs the suite against any local Chromium when the Playwright CDN is
unreachable (the config forwards the variable to `launchOptions.executablePath`).

## 8. Explicitly unverified

- **Deployment / production hosting** — not attempted; no claim is made.
- **Real-GPU performance** — FPS figures in this session (3–40) are SwiftShader
  software rendering in headless Chromium. They prove the counter reads the
  real renderer, not that the scene holds 60 fps on hardware.
- **PostgreSQL parity suite** — only the SQLite backend suite ran here
  (277 passed); the README's Postgres job runs in CI and was not re-run.
- **Firefox / WebKit** — Chromium only (environment constraint above).
- **Pixel-perfect agreement with the reference image** — layout and elements
  match by inspection; no diff tool was run.
- **Tablet widths** — the responsive suite sweeps phone + desktop; a mid-width
  tablet sweep was not added.

## 9. Commits (this work, owner identity, no trailers)

| Commit | Subject |
| --- | --- |
| `48d5b38` | fixing the 3d canvas layout |
| `dd6b851` | fix(resilience): derive criticality stats from the ranking the API returns |
| `b84b33a` | fix(city3d): frame fit and opening shot on the city's projected bounds |
| `69d7d9e` | feat(city3d): viewport controls, floating labels and district overlays |
| `cc14489` | feat(city3d): reference dashboard composition for the twin screen |
| `f5378f9` | fix(twin): query selected-asset incidents with the filter the API supports |
| `e3c3a35` | test(e2e): make the incident-report journey repeatable against a used database |

## 10. Reproduce

```bash
# backend + frontend (see docs/SETUP.md for the full path)
./scripts/dev.sh

cd frontend
npx tsc --noEmit
npm test
npm run build
npm audit

# browser suite — CDN-blocked environments:
PLAYWRIGHT_CHROMIUM_PATH=/path/to/chromium npm run e2e
```
