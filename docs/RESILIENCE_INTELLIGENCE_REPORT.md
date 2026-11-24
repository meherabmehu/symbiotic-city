# Resilience Intelligence — Implementation Report

Scope: six advanced features added to `meherabmehu/symbiotic-city`, with all
pre-existing functionality preserved. This report records what was built, what was
measured, and — in its own section — what could not be verified in this
environment.

- **Base commit:** `07cd087` (dependency-and-workflow hardening report)
- **Head:** `639baf2`
- **Commits:** 9, one per feature or repair, all directly on `main`
- **Tests:** 269 passed, 10 skipped, 3 warnings — identical on SQLite and PostgreSQL 16
- **Test count before this work:** 196 passed, 10 skipped
- **New tests:** 72 (criticality 9, heatmap 9, what-if 12, time travel 14, investment 14, frontier 14)
- **Permissions:** 28 (was 26; added `resilience:read`, `resilience:plan`)

---

## 1. Infrastructure criticality intelligence

`backend/app/services/criticality.py` — a derived 0–100 index for every asset.

**Model.** Four weighted components, each explained by the API:

| component | weight | what it measures |
| --- | --- | --- |
| reach | 0.40 | how far failure propagates, walked over successors with `REACH_DECAY=0.5` to five hops |
| blast radius | 0.30 | assets actually failed in a cascade from this asset |
| population | 0.20 | estimated population that loses service |
| single point of failure | 0.10 | whether any alternative supply path exists |

Consequence is **measured**, not estimated: each asset's cascade is executed with
`simulate_cascade(threshold=0.35, depth=6, total_failure)` and the real result is
recorded. The whole fleet costs ≈100 ms, so the shortlist optimisation that was
built first was removed as unnecessary complexity.

**Endpoints.** `GET /api/resilience/criticality` (fleet ranking + model weights +
assumptions), `GET /api/resilience/criticality/{asset_id}/consequence`.

**Measured on the seeded city (23 assets):** PS-02 84.3 · PS-01 74.0 · SS-02 61.3 ·
SS-01 58.3 · SS-03 48.3 · WT-01 29.1 · … · HO-01/02/03 0.0.

The zeroes are the finding worth reporting. A hospital is the most *important* thing
in the city and the least *consequential* asset to lose, because nothing depends on
it: PS-02 lost takes 17 assets, 23,900 people, and hospital + telecom + water pump
with it; HO-01 lost takes nothing else. Hand-assigned criticality ranks the hospital
first and the substation mid-table, which is exactly backwards for cascade risk. A
test asserts that the feeder still outranks the service it feeds.

---

## 2. Resilience heatmap

`backend/app/services/heatmap.py` — zone-level risk from stored simulation results
blended with the derived criticality index (`IMPACT 0.55 / CRITICALITY 0.45`).

Five bands with data-driven thresholds: low <20, guarded <40, elevated <60,
high <80, severe ≥80. `IMPACT_LEVEL_SCORE` maps failed 1.0, degraded 0.6,
affected 0.3.

- **The legend is data, not a hardcoded list.** It names design tokens
  (`mint/accent/amber/coral/coral-deep`) rather than hexes, so the palette lives in
  one place and the accessibility guard can check it.
- **Every zone explains itself** through `drivers[]`: "SS-03 (substation) failed in
  the selected run and scores 77" rather than a coloured square.
- **A zone with no stored impact is not drawn as safe.** It reports derived exposure
  and is flagged `has_stored_impact: false`, rendered with a dashed outline.
- **The source is stated:** `selected`, `latest`, `synthetic`, or `empty`. When the
  database has never been simulated the map derives a real run through the normal
  path and *commits it*, so the first map a visitor sees is real cascade output.

**Measured:** 5 zones — Z-EAS 61.5 high, Z-NOR 60.8 high, Z-SOU 57.8 elevated,
Z-CEN 56.7 elevated, Z-RIV 8.0 low; 17 failed assets, 71,466 people at risk.

The `ensure_run` path is the one place this call writes, so it commits explicitly,
and a test asserts the cited run is retrievable afterwards. That test caught the
original bug (`flush()` without `commit()`, run invisible to later requests).

---

## 3. What-if future simulator

`backend/app/models/simulation.py` (`WhatIfScenario`, `WhatIfObservation`),
`backend/app/services/whatif.py`, migration `c4f1a9e77b02`.

A what-if is kept apart from a simulation template **on purpose**: a template is
edited, an investigation must stay exactly as it was when someone acted on it. Each
run against a scenario stores the reading taken at the time, and comparisons are
computed from those stored readings — never recomputed with a newer engine, because
that would compare today's logic against yesterday's decision.

**The difference explainer is mechanical.** It reports:

- what fails in every scenario (the agreed core — "no intervention modelled here
  prevents those"),
- what fails in exactly one future,
- the largest spread in the headline metrics,
- the inputs that actually differ.

When exactly one input differs it attributes the divergence to it. When several
differ it says the difference **cannot** be attributed to a single change rather
than picking a favourite. There is a test for each branch.

**Measured:** PS-01 fails → 12 assets, 18,400 people. PS-02 fails → 17 assets,
26,300 people. Six assets fail in both; the comparison names them as the core.

One baseline at a time is enforced — marking a new reference demotes the old one,
or "the baseline" means nothing when comparing.

---

## 4. Multi-objective recovery planning

`backend/app/services/multiobjective.py`; the CP-SAT engine gained a coverage
constraint and optional objective weights.

**Weighted sums were built first and thrown away.** Mixing "value of a served
hospital" with "number of served sites" under one weight lets a plan that serves
more sites score worse than one that serves fewer; and the pure-cost direction
degenerates to *doing nothing*, which is optimal, saves the most money, and
restores no service. A test now asserts that a plan serving nothing is never
offered.

**What replaced it** is a sweep over achievable coverage: for each achievable
number of restored sites, maximise the documented objective subject to serving at
least that many. Coverage is a **feasibility constraint**, so every plan on the
frontier is guaranteed to serve the sites it claims — verified against the model's
own unserved list.

- Only non-dominated plans are shown: a plan survives only if no other is at least
  as good on every objective and strictly better on one.
- Two plans for the same width are collapsed: that is a false choice, not an
  alternative.
- When one plan wins everywhere the notes say it is "the most that fits" rather
  than manufacturing a rival so the chart looks balanced.
- The result states its own limit: weighted-sum-and-sweep cannot prove no better
  plan exists off the frontier.

**Measured on the seeded cascade** (PS-02, 17 assets failed): 13 demands, frontier
of 3 plans at 12, 10 and 8 sites, ≈5 s of solving for six coverage requirements.
One second per solve is deliberate — two seconds found the same frontier and made
the page wait twice as long. Per-solve time is reported, not hidden.

Behind `resilience:plan`: it costs several solves and exists to inform a decision,
not to decorate a read.

---

## 5. Time-travel replay

`backend/app/services/time_travel.py`; three endpoints under `/api/resilience/timetravel`.

**Nothing is snapshotted.** The city is rebuilt from records that are already
immutable: append-only status history, simulation runs, incidents, audit logs,
tasks. A snapshot table would be a second copy of the truth and wrong the moment
someone edits an asset.

**Fidelity is published, not implied.** Every snapshot carries three lists:

- *exact* — asset status (walked backwards over history, so "offline at 14:32"
  carries the change id that says so), simulation runs, audit-logged actions;
- *inferred* — which incidents were open (report time + logged resolutions), plans
  designed before the moment;
- *not reconstructed* — resource stock (current value only, no history ever),
  workflow progress, who was on shift.

**Only moments where something happened appear in a replay.** Padding it with quiet
minutes would suggest the city was watched more closely than it was.

Two defects were found by testing against the running app rather than by reading
the code:

1. The status vocabulary includes `offline`, not just `failed`, so an offline
   substation was reporting **zero** population at risk. Both words now count, and
   a test pins the risk figure to the assets actually down (measured: 9,000 people
   from three offline assets).
2. `datetime.isoformat()` emits `+00:00`, whose `+` arrives from a query string as
   a space — so every correctly formatted UTC timestamp was rejected as badly
   formatted. Both spellings are now accepted.

The diff classifies movement as **worse or better**, not merely different. A round
trip (offline then back) correctly reports no change between the endpoints; the
story of the round trip belongs in the replay.

---

## 6. Resilience investment planner

`backend/app/services/investment.py` — `GET /api/resilience/investment`.

**Every benefit is a counterfactual.** For each candidate the intervention is
applied to the real dependency graph, the same cascade is re-run, and the measured
difference in failed assets and people at risk is reported. An intervention that
changes nothing shows as changing nothing, and those options rank **below** every
measured benefit rather than being quietly dropped — "we considered it and it does
not help" belongs on the record.

Three intervention types, deliberately geometrically distinct: `harden` stops an
asset propagating its own failure; `redundancy` lets it survive losing one upstream
supplier; `isolate` cuts both ends. They were identical at first (isolation also
severed the downstream edges, so every option for one asset scored the same) and
the fix was to make the model say what the words mean.

**The portfolio figure needed the most care.** Summing individual benefits claimed
**141,500** people protected against a baseline where only **85,300** were ever at
risk, because three interventions on overlapping dependency paths protect the same
people. A budget case cannot survive overstating itself by 64 %. The package is now
measured *as a package*: every chosen intervention is applied together and the
cascade re-run. The 61,000 that disappears between the sum and the measurement is
reported explicitly as overlap — smaller, but true.

Costs are published constants with a stated basis (`COST_BASIS`, `costs_are:
"annualised planning constants, not quotes"`), because the repository has real
hourly resource costs and **no** capital-cost data at all. The output says which.

**Measured on the seeded city:** planning against PS-02 (17 assets, 85,300 people,
four critical service types lost). Isolation of PS-02 protects 80,500 people for
26,000 a year; hardening, 42,000. 11 of 21 options are measured no-ops. Inside a
100,000 budget the greedy portfolio spends 104,000 — none of it wasted: measured
together it protects 80,500, not the 161,000 the individual benefits would have
claimed.

---

## 7. Frontend

`frontend/app/(app)/resilience/page.tsx` — one page, five tabs (Exposure, What-if
futures, Recovery trade-offs, Investment plan, Time travel), plus
`frontend/components/zone-risk-map.tsx` and a nav entry under **Infrastructure**.

- **The zone map is SVG, not canvas**, so the same DOM a screen reader reads carries
  every zone's score, band and drivers. Nothing about risk is conveyed by colour
  alone.
- **Zone geometry derives from the assets inside it**, so the map cannot drift from
  where the infrastructure actually is; a zone with no assets is not drawn at all.
- **Band colours come from the API's own legend tokens**, so the palette and the
  scoring thresholds cannot diverge.
- **Every panel shows its assumptions**, collapsed by default but on the same panel
  as the number. These numbers carry real limitations and a dashboard that hides
  them gets trusted past its evidence.

### Accessibility repair on the existing twin

`components/city-twin.tsx` distinguished status by hue alone (mint / amber /
coral), which is unreadable for a red-green deficiency and was the last remaining
gap in that component. Each status now also carries a **mark** on the tower — cross
for offline, bar for maintenance, half-fill for degraded — and the legend shows the
same mark beside its swatch.

### Docs

`docs/DEEP_DEBUGGING_REPORT.md`'s companion page gains a "Resilience intelligence"
method panel and four demonstration steps (9–12) following the original eight.

---

## Verification

### Run and passed

| check | result |
| --- | --- |
| Backend suite, SQLite | **269 passed, 10 skipped** (142 s) |
| Backend suite, PostgreSQL 16 | **269 passed, 10 skipped** (141 s) |
| `alembic upgrade head` → `downgrade base` → `upgrade head`, PostgreSQL 16 | clean both directions |
| `tsc --noEmit` | clean |
| `next build` | succeeds; `/resilience` 10.5 kB, 128 kB first load |
| `scripts/smoke.py` | all checks pass |
| `scripts/authz_probe.py` | no anonymous access to any probed route, including all 7 new ones |
| Migration tests | new tables arrive by revision, cascade delete declared |
| Live API through the Next proxy | all 7 resilience endpoints answer with expected shapes |

The authz probe confirms the intended matrix on the new routes: `401` anonymous,
`200/201` operator and analyst, `403` engineer on mutations, `403` engineer on
`/resilience/investment` and `/resilience/frontier`.

### Not verified — stated plainly

- **No browser interaction.** `playwright install chromium` fails here
  (`Download failure, code=1`). The responsive spec **discovers** `/resilience`
  (`npx playwright test --list` reports 71 tests in 4 files) but cannot execute.
  Layout, focus order, the rendered map and the actual colour contrast of the new
  marks are **Not verified**.
- **No ESLint.** The repository has no `eslint.config.*`; `next lint` prompts for
  first-time setup and `next.config.mjs` sets `eslint.ignoreDuringBuilds: true`.
  Linting is **Not available**, not passing.
- **No visual comparison against the Canva reference** beyond page 1, which was the
  only machine-extractable page. Styling follows the existing token system.
- **Playwright E2E, mobile project:** not run for the same reason as above.

### Known limitations, by design

- The cascade is a dependency-chain screening model, not a power-flow solver.
- Population is estimated from asset category and criticality, not counted.
- Investment capital costs are planning constants, labelled as such.
- The frontier cannot prove optimality off the returned set.
- Resource stock has never had a history and is deliberately excluded from replay.

---

## Reproducing

```bash
# backend
cd backend && ../.venv/bin/python -m pytest tests -q
# PostgreSQL
DATABASE_URL="postgresql+psycopg2://postgres:@/res_suite?host=/tmp/pg_a1" \
  ../.venv/bin/python -m pytest tests -q
# frontend
cd frontend && npx tsc --noEmit && npx next build
# live probes against a running API
python scripts/smoke.py http://127.0.0.1:8081/api
python scripts/authz_probe.py http://127.0.0.1:8081/api
```

Demo credentials (seeded): `admin@`, `operator@`, `engineer@`, `analyst@`
`@symbiotic.city` with `Admin#2026`, `Operator#2026`, `Engineer#2026`,
`Analyst#2026`.
