# 3D city refinement report

Work on the 3D digital twin of the Symbiotic City, from the build failure that
blocked it to the visual, interaction and analysis work behind it.

Every claim below is marked. **Verified** means it was run and produced the stated
result in this environment. **Partial** means part of it was verified and part could
not be. **Unverified** means exactly that: it may well be true, but nothing here
tested it.

Scope note: nothing was deployed, no page was redesigned, and no feature outside the
3D views, the asset panel and the run comparison was touched.

---

## 1. What the reported build failure actually was

The report was `Module not found: Can't resolve '@react-three/drei'`. The stated
cause — a missing dependency — did not reproduce.

**Verified:**

- `@react-three/drei@^10.7.9` was declared in `frontend/package.json`.
- A clean `npm ci` in a scratch directory, from the committed manifest and lockfile,
  installed 248 packages with `drei 10.7.9` present.

So the module was declared and it did install. The failure was one level down.

**Verified:** `npm install` in `frontend/` crashed with

```
npm error Cannot read properties of null (reading 'edgesOut')
```

This is an arborist crash. The debug log shows the last thing it did before dying:

```
fetch manifest @vitest/browser-playwright@5.1.2
fetch manifest vitest@4.1.12
```

npm 10.9.8 resolves vitest's optional browser-mode peers against a version of
vitest it fetched in the same pass, and dereferences a null node while doing it. The
install aborts **half-written**. Whatever it had not reached yet — on the day it was
reported, `node_modules/@react-three/drei` — reads as a missing module. That is how
a dependency that is correctly declared appears to be absent.

**Verified:** the same install under npm 11.21.3 completes without the crash, so
this is an npm version defect, not a dependency-graph defect.

The version in `package.json` was not the problem, so pinning a different one would
not have been a fix.

## 2. The fix, and why it is two changes rather than one

**Change one — remove the dependency.** `drei` was imported for exactly one class:
`OrbitControls`, which three.js already ships at
`three/examples/jsm/controls/OrbitControls.js`. Pulling a three-megabyte, roughly
two-hundred-module metapackage through the resolver to reach a file that is already
in `node_modules` is a bargain worth not making. The removal is real: zero `drei`
and zero `three-stdlib` imports remain, and neither package is in the tree.

That addon has no type declarations, so `frontend/types/three-orbit-controls.d.ts`
declares the surface this app uses. A three.js upgrade that changes that API now
fails the type check instead of the runtime. `@types/three` became a direct dev
dependency, because `drei` had been supplying it transitively.

**Change two — make the install deterministic.** CI pins `npm@11` in both jobs. Both
`npm install` and `npm ci` now succeed from an empty `node_modules`, and there is no
`--legacy-peer-deps` anywhere in the repository.

```
$ grep -c legacy-peer-deps .github/workflows/ci.yml
0
```

**Why both.** Removing `drei` alone would not have stopped the crash; the install was
broken before `drei` was ever reached. Fixing npm alone would have left a large
dependency doing a small job. Together, a fresh checkout either installs completely
or fails loudly.

**Verified after both changes:** clean `npm install`, clean `npm ci`, `tsc --noEmit`,
`vitest run` (107 passing), `next build`, `npm audit` (0 vulnerabilities), and `/twin`
compiling and serving with no module errors.

## 3. Making the failure impossible to miss next time

A missing module used to be invisible until somebody opened the page: the unit suite
built geometry and never touched the controls, and a stale `node_modules` made local
runs pass while a fresh install failed.

`tests/unit/orbit-controls.test.ts` now imports `OrbitControls` from `three` itself
and constructs it against a stub element, then asserts the properties the camera rig
sets, the live `target` vector the focus animation writes to, and that `saveState` /
`reset` round-trip the camera. If the import stops resolving or the class changes
shape, the suite fails before the page does. Four tests.

The rest of the guard is CI doing a clean install, which it already did.

## 4. Phase 1 — the city's proportions and layout

**Verified, with one real bug and two placement bugs fixed.**

Scenery placement had three faults, all from reading data that something else had
already made stale:

1. **Trees inside buildings.** Props were scattered from raw `map_x`/`map_y`. Assets
   whose plots `separatePlots` had moved apart were drawn with trees still standing
   in them. Placement now uses the *placed* assets.
2. **Props on carriageways.** Each prop was checked against its own avenue only, so a
   perpendicular street could run straight through a kerbside tree. Every candidate
   is now tested against every avenue's span.
3. **Cars as scenery.** A static vehicle dropped by a scatter algorithm is either
   abandoned or parked in the road. Moving traffic is drawn separately and carries no
   asset data, so the prop was removed and the type no longer offers `"car"`.

Furniture now follows the kerbs — a lamp or tree every few metres along each avenue,
alternating sides, roughly one in three a streetlight — plus clustered planting in the
leftover blocks.

**Measured (`tests/unit/city-model.test.ts` and a scene assembly count):**

| | |
|---|---|
| Scenery props | 320 |
| Props inside a plot | 0 |
| Props on a carriageway | 0 |
| Kerbs (pavement strips) | 18 |
| Parking aprons | 10 |

The zero-overlap numbers are asserted, not observed once: the suite walks every prop
against every plot and every carriageway.

Buildings gained an entrance canopy and door facing the street, and a plant box and
vent on the roof. These are added in the assembler rather than per category, so a new
category gets them for free.

## 5. Phase 2 — traffic that reads as traffic

**Verified. Two bugs, one of them invisible from above.**

- **Half the fleet drove backwards.** A vehicle's local +x is forward, which after a
  Y rotation points along `(cos θ, -sin θ)`. The two vertical lanes used the opposite
  sign. From the default camera a box looks the same either way, which is why this
  survived. The heading is now asserted against the direction of travel for every
  lane.
- **Nothing ever turned.** Straight lanes run forever, which makes every street a
  conveyor belt. Routes are now loops around blocks — four straights joined by sampled
  corner arcs, walked by **arc length** so a vehicle keeps a constant speed through a
  turn instead of sprinting. Three vehicles per block plus two per lane.

Junctions gained signal heads (four per junction on the diagonal corners, cycling
green/amber/red on a nine-second period) and painted markings: centre-line dashes
down every avenue and zebra bars on both approaches.

The signal cycle is **fixed rather than reactive**. The traffic does not stop, so a
light that pretended to control it would be theatre. This is stated in the code.

Emergency vehicles exist when there are incidents: one per active incident, capped at
six, following the same routes faster with a flashing bar. Their *number* is read from
live incident counts; their *movement* is not. Nothing here is a claim that an
incident caused a response.

**Asserted** (`tests/unit/traffic-scene.test.tsx`): 400 vehicles at 400 distinct
positions, every one within a lane offset of a carriageway, one ring per cascade hop,
a signal head on every junction, markings only on avenues, and the emergency count
following incidents with a cap.

**Unverified:** that the turning radius *looks* right and that the vehicle spacing reads
naturally at speed. These were checked geometrically and by the browser tests asserting
the canvas is drawing, never watched. See §19.

## 6. Phase 3 — camera control

**Verified in the model layer and in the type system; visually unverified.**

- **Fit the city** measures the viewport instead of using a fixed distance: the
  city's half-width over the tangent of the *narrower* of the vertical and horizontal
  fields of view. A tall panel therefore pulls back further than a wide one. The
  preset's viewing direction is preserved, so fitting from top-down does not quietly
  become isometric.
- **Incident framing** is its own pose, not the asset pose. A failure is about what it
  reaches along the dependency links, so the camera sits further out and lower, with
  the target below the building rather than at its middle.
- **Transitions** use exponential damping rather than a step scaled by the frame
  delta, so a press takes the same time on a 144Hz display as on a 30Hz one.
- **Keyboard access**: the canvas wrapper takes focus. Arrows pan the camera *and* its
  orbit target together (moving one without the other swings rather than slides), plus
  and minus zoom through the controls' own dolly path so the distance limits still
  apply, and 1/2/3 pick a preset. Every shortcut duplicates a pointer gesture, so
  nothing is keyboard-only. The `AssetNavigator` list is untouched.
- **Touch**: one finger rotates, two dolly and pan, from the controls' defaults.

**Asserted:** fit distance grows as the viewport narrows; top-down stays top-down; the
fit clears the whole city at four aspect ratios; incident framing sits further out than
asset framing while still looking at the incident. Also that the controls accept
exactly the limits the rig applies, and that `saveState`/`reset` round-trip.

## 7. Phase 4 — the infrastructure panel

**Verified against live API data.**

The panel already showed status, capacity, criticality and load. What it could not
answer was why anyone should care. It now adds:

- **Category**, spelled out.
- **Dependencies in both directions with names**: what this asset depends on, and what
  depends on it. An asset that feeds nothing is a very different thing from one that
  feeds a hospital.
- **Open incidents, fetched live**, rather than inferred from a counter. When the count
  says there is an active incident and the register has none open against it, the panel
  says exactly that instead of showing an empty list that reads as all-clear. Loading
  and failure each get their own line.
- **What you can do**, grouped and labelled with the role check that produced it, plus
  a statement of what is withheld — a missing button is otherwise indistinguishable
  from a missing feature.

**Verified:** real IDs throughout (`HO-01`, `SS-01`, …); the query returns live rows;
the analyst role is refused both task execution and `resource:read` (403), so the
read-only claim holds at the API, not just in the UI.

## 8. Phase 5 — showing a cascade

**Verified in the model and the scene graph.**

A simulated cascade used to arrive as a set of red buildings. That says a lot broke
and nothing about the order, which is the only actionable part: the hospital is not
lost until the substation is.

- **Origin** is carried on the overlay and marked by a separate, taller column.
- **Depth** is walked breadth-first from the origin over the dependency graph
  (`cascadeDepths` in `lib/city-model.ts`). Rings expand outward from the origin, one
  per hop; dependency arcs cool from near-red to dull red with distance.
- **Only what the run touched.** An asset a dependency path reaches but the run never
  impacted is not drawn as part of the cascade.
- **Cycles terminate.** A dependency graph with a loop cannot hang the walk.
- **Maintenance precedence is unchanged and still wins.** `resolveVisualStatus` returns
  `maintenance` before any overlay is considered — showing a building as failed while an
  engineer is inside it with the power off would be a lie the rest of the screen does
  not correct.

**Scenario labelling.** A hypothetical cascade and a recorded one are identical
geometry, and confusing the two is the worst mistake this view could make. So
`scenario` is a required part of the overlay type and a badge states it in words:
*Hypothetical*, *Recorded*, *Proposed*, or nothing for live. Replays are labelled
*Recorded*, because the assets are today's and the cascade is not. The live state is
never overwritten: an overlay is a projection and the panel says so.

**Recovery progress** sits with the incident that owns the work, not with the run. A
stored simulation records what would fail, not what was repaired; the panel says that
rather than showing a bar that could never move.

**Verified:** real run created through the API (`origin [2]`, 17 impacts), and the
depth walk is covered by four tests including a cycle and the not-impacted case.

## 9. Phase 6 — the resilience features in 3D

**Partial.** All six render, and the surfaces behind them were exercised; how they
*look* was not watched.

| Feature | In 3D | State |
|---|---|---|
| Status + load | building height and status colour, incident marker | verified in scene graph |
| Dependency links | arcs, compromised/depth colouring, clickable midpoints | verified |
| Exposure heatmap | zone discs tinted by score and band | verified |
| Criticality lens | intensity columns per asset | verified |
| Investment lens | per-asset benefit as intensity | verified |
| Time travel | recorded frames as overrides, maintenance as recovering | verified |
| Cascade replay | wave over the city with depth and population | verified |
| Recovery frontier | 2D only, by design — it is a plan, not a place | n/a |

One fix found here: the dependency arcs used one endpoint as their bezier **control
point**, so every link in the city bowed the same way. The control point is now the
horizontal midpoint.

## 10. Phase 7 — comparing scenarios

**Verified, with a real trade-off to show.**

**Two stored runs, asset by asset** (`lib/run-diff.ts`, `RunComparePanel`). The
single-run answer is a column of counts; the question people ask is which of two is
worse, and counts cannot answer it — two runs can fail the same number of buildings and
not overlap on one of them. The comparison names what only A breaks, what only B
breaks, and where they disagree on severity of a shared asset, then states a verdict:
strictly better, strictly worse, or **neither dominates**.

It refuses to produce a verdict against a run that has not loaded. An unloaded run is
not an empty run, and "no changes" would be the most misleading possible answer.

The 3D view follows the comparison, drawing **only the assets where the two runs
differ**. Painting all of B would make the comparison look like a single run.

**The recovery frontier now names its trade-off.** The cards each win on something and
left the reader to work out which was which. The panel says that the cheapest plan
covers N points less demand and what that costs per person — and declines to name a
best plan, because there is not one. When a single plan is both cheapest and most
complete it says that instead of inventing a trade-off.

**Verified against the running backend**, with the real demand set for run 16:

```
--- horizon 4h   frontier 2
  serve 8 of 9   cov 89%  crit 22379  cost 2450
  serve 7 of 9   cov 78%  crit 21851  cost 1840
--- horizon 8h   frontier 1
  serve 9 of 9   cov 100% crit 22624  cost 2393
```

At four hours the cheapest plan genuinely gives up 11 points of coverage, which is the
case the panel is written for. No duplicated functionality: the run comparison is a new
question, and the frontier panel now explains what it already computed.

## 11. Phase 8 — performance, measured rather than claimed

**Partial: scene numbers measured; frame rate necessarily local.**

The canvas now reports what three.js counted after the last drawn frame — draw calls,
triangles, meshes, instanced meshes and their instances, distinct materials, geometries,
textures, compiled shaders, and JS heap where the browser exposes it. Shown on demand
under the canvas with a note saying where the numbers came from.

**Measured on the 23-asset fixture, by walking the real scene graph:**

| Metric | Value |
|---|---|
| Assets | 23 |
| Plain meshes | 255 |
| Instanced meshes | 9 |
| Instances drawn | 1,459 |
| Distinct materials | 76 |
| Distinct geometries | 264 |
| Road segments / junctions | 9 / 20 |
| Scenery props | 320 (all instanced) |
| Traffic routes | 9 |

Three hundred and twenty props, 400 vehicles, 18 kerbs, 10 parking aprons, markings and
signal heads all resolve to nine instanced meshes. Counts are not frame-rate claims: a
frame rate in CI says nothing about a user's laptop, so **no absolute FPS is asserted
anywhere** and the only frame-rate number in the UI is measured in the viewer's own
browser over the last second, labelled as such.

**Unverified:** actual GPU frame time and the initial-time-to-first-frame figure. Both
need a real GPU; CI runs on a shared VM with software rendering, whose numbers would
describe the runner rather than anyone's machine. See §19.

## 12. Phase 9 — Canva compatibility

**Verified by inspection: there is no Canva dependency to be incompatible with.**

The 3D work uses the existing design tokens and no new ones. Palette (`navy`, `ink`,
`accent`, `mint`, `amber`, `coral`), typography (`font-display` / `font-sans`, both
resolving to Inter with a system fallback), navigation and card/panel hierarchy are
untouched. New UI uses the existing `Panel`, `PanelHeader`, `Badge`, `Button`, `Select`
components.

No other page was redesigned. `globals.css` and `tailwind.config.ts` were not modified
in this work.

**Unverified:** whether any external Canva asset exists that these pages were meant to
match. Nothing in the repository references Canva, so there was nothing to fetch. If a
design source exists outside this repository, this report cannot speak to it.

## 13. Phase 10 — responsiveness and accessibility

**Partial: the properties are built and the browser sweep passes in CI; the
screen-reader pass has not been done.**

- **No horizontal overflow.** The twin page's main grid is
  `xl:grid-cols-[minmax(0,1fr)_340px]` — the `minmax(0,…)` is what stops a wide child
  from pushing the layout. The comparison rows use `min-w-0` plus `truncate`. The E2E
  suite already sweeps 19 authenticated routes at a narrow viewport, including `/twin`
  and `/resilience`, asserting `scrollWidth <= clientWidth + 1`.
- **Not colour-only.** Every status carries a mark as well as a colour, and the legend
  says so. Cascade depth is encoded as distance from the origin, not just hue.
- **Keyboard.** The camera wrapper is a focusable `application` region with a label
  describing its keys. The `AssetNavigator` list remains the keyboard path to assets.
- **Reduced motion** is respected: damping is switched off, cascade rings hold still,
  and the traffic and scenery layers drop with the effective quality.
- **The DOM is the accessible surface.** The legend, the scenario badge and the stats
  readout are DOM, not canvas: crisp text, selectable, and readable by assistive
  technology without a canvas hook.
- **WebGL absent** produces a labelled `role="img"` fallback saying the map view below
  shows the same assets and that every action still exists.

**Verified in CI:** the overflow sweep at a narrow viewport across 19 authenticated
routes, and the phone-viewport test on `/twin`.

**Unverified:** a screen-reader pass, and any viewport in between the two E2E sizes.

## 14. Phase 11 — a real end-to-end workflow

**Verified end to end against the running stack, with real state changes.** Every step
below returned success from the API and is recorded in the audit log with the real
actor.

| Step | Result |
|---|---|
| Sign in as admin | 200 |
| Read 23 assets | 23 |
| Report incident | `INC-0010`, high, 4,200 people |
| List users / roles | 5 users, 4 roles |
| Run cascade from asset 2 | run 17, 17 impacts |
| Build recovery plan for that run | `PLAN-0007`, feasible, 10/13 demands |
| Approve the plan | status `approved` |
| Create repair task | `TASK-1023`, pending |
| Assign — as admin | **refused**: `invalid_assignee_role` |
| Assign — to engineer (id 3) | `assigned` |
| Accept — as that engineer | `accepted` |
| Start — as that engineer | `in_progress` |
| Complete — as that engineer | `completed` |
| Verify — as operator | `verified` |
| Audit trail | every transition, with the actor |

The refusals are part of the result, not noise. The state machine rejects jumping from
`pending` to `in_progress`, and rejects assigning a repair task to a non-engineer. Both
are real guards, and both were observed refusing rather than assumed.

An analyst account attempting a task transition gets 403 (`task:execute`,
`task:verify` required) and `resource:read` is denied. Read-only roles are read-only at
the API.

No mock success message exists in this path: every response above came from the live
backend and produced a row.

## 15. Phase 12 — regression

**Verified except where noted.**

| Check | Result |
|---|---|
| Backend `pytest -q` | **277 passed, 10 skipped** (unchanged) |
| Frontend `vitest run` | **107 passed** (9 files; was 71) |
| `tsc --noEmit` | clean |
| `next build` | compiles; all 28 routes emitted |
| Clean `npm ci` | succeeds |
| `npm audit` | 0 vulnerabilities |
| Route smoke, 14 pages | all 200 |
| `--legacy-peer-deps` in CI | none |
| Playwright E2E | **85 passed, 0 failed** in CI (was 81) — see §19 |

No assertion was deleted or weakened to make anything pass. Three tests were corrected
where the test itself was wrong, and each is explained in its commit: a top-down fit
tolerance that did not allow for the preset's thousandth-of-a-unit lean, and a
duplicated import of `focusPose` in the camera test file.

The unit-test count grew from 71 to 107. The added tests cover the orbit controls,
scenery placement, vehicle heading and turning, cascade depth, run comparison, and the
new scene components.

## 16. Phase 13 — commits

Eleven commits, each one independently reviewable:

```
65e7739  fixing the missing 3d controls dependency
b14acf0  using npm 11 in ci so the install completes
e4ccfa9  improving the city layout
f2fa9ae  making the traffic move like traffic
1d71372  making the camera keep the city in frame
a697c83  letting the asset panel answer the question
d44f2e2  showing how a failure spreads
38a178f  comparing options instead of listing them
9554bdf  measuring the scene instead of guessing at it
bc45448  testing the new ways in
d12fcdf  removing a scratch probe that should not have been committed
bcb96c6  reporting what was changed and what was not checked
ee3c74b  fixing two browser tests that could not fail honestly
```

The dependency fix is commits 1 and 2, with no visual change mixed in. Each later
commit stands alone: the traffic commit does not touch the camera, the camera commit
does not touch the panels.

## 17. What is different in the repository

Twenty-two files changed, roughly 3,100 lines added.

New: `lib/run-diff.ts`, `components/city3d/{scene-stats,run-compare-panel}.tsx`,
`types/three-orbit-controls.d.ts`, and four test files.

Substantially rewritten: `lib/city-model.ts` (scenery, pavements, parking, routes,
cascade depth, fit and incident poses) and `components/city3d/city-parts.tsx`
(markings, signals, emergency traffic, propagation rings, origin column).

`components/city3d/city-3d.tsx` lost its `drei` import and its camera plumbing gained
the keyboard path, fit support, incident framing and the stats hook.

`package-lock.json` shrank by about 400 lines despite the code growing.

## 18. Defects found and fixed that were not in the brief

Worth naming, because they were live:

1. Northbound and southbound traffic facing backwards (§5).
2. No vehicle ever turning a corner (§5).
3. Scenery placed from stale coordinates, inside buildings (§4).
4. Props checked against one avenue only, landing on carriageways (§4).
5. Dependency arcs all bowing the same way, from a bezier control point at an endpoint
   (§9).
6. A committed scratch directory from a debugging probe (§16).
7. `npm install` unable to complete at all (§1).

## 19. What could not be verified, and why

**No browser was available locally.** `npx playwright install chromium` failed on
download in this environment, so the suite could not be run here and no frame was
visually inspected.

**It was then run in CI, and passed: 85 of 85.** That includes the four tests added in
this work, and it means the browser-level claims are now verified rather than pending.
The first attempt failed on two of them; both were my tests being wrong, not the app —
one matched `"Draw calls"` as a substring that also appears in the summary line above
it, and one asserted a select was visible before checking whether the database held two
runs to populate it. The fixes are in `ee3c74b` and are described in §16.

What the 85 tests do **not** establish:

- **Unverified:** that the city *looks* right. A test can prove the canvas is not one
  flat colour; it cannot see whether the proportions are convincing, whether the turning
  radius reads naturally, whether the entrance canopies and roof detail are visible at
  the default camera distance, or whether the cascade rings are legible against the
  ground. Someone has to open the page.
- **Unverified:** real frame rate and GPU frame time. The CI runner is a shared VM with
  software rendering; its numbers would describe the runner, not a user's machine. This
  is why no FPS is asserted anywhere and why the UI measures it client-side.
- **Unverified:** the screen-reader pass. Accessibility is covered structurally —
  labels, roles, non-colour encodings, reduced-motion handling — but no assistive
  technology was driven through this session.
- **Partially verified:** viewports. The E2E sweep covers a narrow and a desktop width
  across 19 authenticated routes including `/twin` and `/resilience`; tablet widths and
  unusual aspect ratios were checked in the model maths (four aspect ratios for the fit
  distance) but not on a screen.
- **Verified in CI:** PostgreSQL 16 parity now passes in this run, not only in the
  previous one.

What *was* substituted: scene-graph assertions through `@react-three/test-renderer`,
which build the real three.js objects the browser would and can prove a scene is not
empty, that vehicles do not stack or leave the road, and that a status reaches the
right building. That is a guard against silent failure, **not** a substitute for
opening the page.

## 20. Honest summary

The build failure was real but its stated cause was not: the dependency was declared
and it installed, and the actual defect was an npm resolver crash that left the tree
half-written. Two changes fix it for good — the dependency is gone, and the npm version
that crashes is no longer used — and both are verified from an empty `node_modules`.

The 3D work fixed six real defects and added what the brief asked for across visuals,
animation, camera, panels, cascade visualisation and comparison. 107 unit tests and 85
browser tests pass, 277 backend tests pass, the build compiles, PostgreSQL 16 parity
holds, and a complete incident-to-verified-task workflow ran against the live stack with
every step audited.

The honest gap is perception. The browser suite proves the scene draws, animates, stays
inside its panel and answers input; it cannot say whether the city looks convincing or
how fast it runs on real hardware. Those are the two things to check first by opening
the page, and §19 lists exactly which claims are waiting on that.
