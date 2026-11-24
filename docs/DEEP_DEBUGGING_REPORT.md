# SYMBIOTIC CITY — Deep Debugging Report

**Project:** SYMBIOTIC CITY — Self-Healing Urban Intelligence
**Competition:** Hack the Vibe 2026 · World Problem Solver · challenges A02 (Digital Twin & Cascading Failure Simulation) and A07 (Constrained Recovery Workflow)
**Scope of this pass:** full functional debugging, integration testing and UI/UX audit
**Baseline commit:** `23e4049`
**Work delivered on:** nine commits, `17b1e94` … `282cb4f`

---

## A. Executive summary

Nine defects were reproduced, root-caused, fixed and covered by regression tests. Four of
them were not cosmetic: two were authorisation defects that a role could exploit, one was a
safety statement about the city that was wrong, and one was a spreadsheet injection path that
crosses permissions by design.

| # | Severity | Area | Defect | Status |
|---|---|---|---|---|
| 1 | High | A2 authz | ~30 read endpoints required a session but no permission; an engineer could move an incident through its state machine on a read permission | Fixed |
| 2 | High | A3 infra | Dependency recovery promoted dependants to `operational` whatever the reason, cancelling scheduled maintenance and reporting live outages as fixed | Fixed |
| 3 | Medium | A4 twin | A cascade node first reached shallowly was never reconsidered when a deeper supplier failed, so failures were under-reported | Fixed |
| 4 | Medium | A5 CP-SAT | Every unserved demand was blamed on capacity without testing it, producing self-contradicting explanations | Fixed |
| 5 | High | A7 export | CSV export handed user-written text to spreadsheets as live formulas (CWE-1236) | Fixed |
| 6 | Medium | A6 workflow | Retry accepted a healthy workflow, flipping an approval-gated one to `running` and counting a retry that never happened | Fixed |
| 7 | Medium | C5 a11y | Two darkest text tokens failed WCAG AA on all surfaces, used at 10–11px where no large-text allowance applies | Fixed |
| 8 | Low | C4 e2e | Responsive overflow check covered 6 of 17 authenticated routes | Fixed |
| 9 | Low | A2 tooling | Authz probe flagged its own documented public route on every run | Fixed |

Two areas were investigated and found **sound** — recorded as verified rather than silently
passed: reservation concurrency under PostgreSQL row locking, and administrator self-lockout
protection.

---

## B. Method

1. **Baseline first.** Full suite on SQLite and PostgreSQL 16, `tsc --noEmit`, `next build`,
   `scripts/smoke.py`, and `scripts/authz_probe.py` before touching anything. Baseline was
   **112 passed / 10 skipped** (SQLite) and **122 passed** (PG16).
2. **Reproduce before fixing.** Every defect below was first demonstrated against a running
   server with real credentials, and the observation is quoted in its section.
3. **Smallest reliable fix.** No rewrite, no refactor of correct code, no weakened assertion.
4. **Regression test per fix**, asserting intent in role or domain terms rather than in the
   exact strings of the implementation.
5. **Re-verify both databases** after every fix, because several defects were dialect-sensitive.

Final state: **206 passed, 0 skipped** on PostgreSQL 16; **196 passed, 10 skipped** on SQLite;
`tsc` clean; `next build` compiles; smoke 26/26; no anonymous access to any probed route.

---

## C. Defects: reproduction, root cause, fix

### C1. Authorisation: reads were unguarded, and a mutation sat on a read permission

**Observation.** `scripts/authz_probe.py` signs in as anonymous, administrator, operator, field
engineer and analyst and prints a route×role matrix. Before the fix:

```
GET /analytics/recovery     engineer 200   analyst 403      <- wrong way round
GET /analytics/resources    engineer 200
GET /analytics/simulations  engineer 200
GET /auth/roles             anonymous 200
GET /infrastructure/categories, /statuses, /simulations/assumptions,
    /resources/categories, /workflows/steps                 anonymous 200
```

and roughly thirty more read endpoints answered any signed-in caller regardless of role.

Worse, a **mutation** was gated on a read permission. Reproduced with real credentials:

```
ENGINEER POST /incidents/6/transition {"status":"verified"} -> 200
   result status now: verified
```

**Root cause.** Reads carried a session check but no permission dependency, so authorisation
was effectively "is logged in". `POST /incidents/{id}/transition` was declared with
`require_permissions("incident:read")`, which the field engineer holds. The service layer
re-checks only the `approved` and `resolved` targets, so every other transition in
`INCIDENT_TRANSITIONS` was open to a read-only role.

**Fix.** Strict RBAC applied to every authenticated read, mirroring its domain's mutation gate
(`incident:read`, `infrastructure:read`, `resource:read`, `task:read`, `simulation:read`,
`optimization:read`, `workflow:read`, `twin:read`, `user:read`). `transition` now requires
`incident:write`. Three endpoints were deliberately **not** given a domain gate, each for a
recorded reason:

- `/dashboard` is the landing page and its payload is already least-privilege:
  `dashboard_bundle()` receives the caller's permission keys and fills only the permitted
  sections. A domain gate would both deny a role that lacks it and hide that role's own sections.
- The notification inbox is personal — every query filters on the caller's own `user_id` and the
  handlers refuse another user's rows. The gate is ownership, not a domain permission; gating it
  on `incident:read` would deny a user their own inbox.
- `POST /tasks/{id}/transition` serves two roles by design: an engineer accepts, starts and
  completes (`task:execute`), an operator verifies (`task:verify`). One static gate cannot express
  that, so the route gate is the **union** and the service enforces the permission for the specific
  target state. Gating it on `task:execute` alone — the obvious reading — was tried and refused
  operators from verification; two workflow tests caught it.
- `GET /settings` was moved from `settings:manage` (a write permission) to `user:read`, because
  reading settings is administration and only changing them should need the write.

**Verification.** `backend/tests/test_permission_gates.py` — 53 tests that state intent in
role terms ("the analyst can read every analytics view", "a field engineer cannot verify an
incident", "the administrator can read settings, the operator cannot"). After the fix the probe
reports no anonymous access to any probed route.

### C2. Dependency recovery cancelled maintenance and reported live outages as fixed

**Observation.** An asset was placed in scheduled maintenance, then its only feeder failed, then
the feeder was restored:

```
1. dependent put into maintenance for its own reason : maintenance
2. upstream fails                                    : offline      (correct cascade)
3. upstream restored                                 : operational  (WRONG)
   expected: maintenance — the outage never cancelled the service
```

And with two independent faults:

```
A. both offline            upstream offline | dependent offline
B. restore ONLY the feeder upstream operational | dependent operational  (WRONG)
   the hospital's fault was never fixed
```

**Root cause.** `propagate_status()` treated every dependant that was `offline` or `degraded` as
a cascade artefact and promoted it to `operational`. It had no way to tell a status it wrote from
a status a person wrote, and no memory of the pre-cascade state — so it invented one.

**Fix.** Recovery now asks the status history whether the current state is one propagation wrote
(history rows carry a `[cascade]` tag, so provenance survives a restart) and restores the status
the asset held *before* the cascade, refusing to touch a state a person set.

This surfaced a second defect on the same path: `change_status()` silently dropped an operator's
re-assertion of the current status, so "offline for its own fault" was indistinguishable from
"offline because of the feeder". A re-assertion of `offline`/`degraded` is now recorded.

**Verification.** `backend/tests/test_dependency_recovery.py` — four tests: plain cascade still
works, plain recovery still works, maintenance survives, an unrelated outage is not masked.

### C3. Cascade under-reported failures (traversal order decided outcomes)

**Observation.** A hospital with two weak feeds:

```
A -> X 0.2   (reaches X at depth 1, below the 0.35 threshold)
A -> C 1.0, C -> B 1.0, B -> X 0.2   (B only fails at depth 2)

X deficit once B has failed = 1 - (0.8 * 0.8) = 0.36 > 0.35   => X must FAIL
actual: X verdict = "affected", score 0.175, never revisited
```

**Root cause.** The breadth-first loop skipped any neighbour whose previously recorded depth was
shallower than the incoming path. A node judged once was pinned, so a supplier failing later was
ignored. Verdicts depended on traversal order rather than on the graph.

**Fix.** Re-evaluation is driven by the current failed set rather than first-visit depth, so a new
upstream failure is accounted for. The deficit function already recomputes from scratch, so this
is idempotent; a fully connected 8×7 graph terminates in under 2 s.

**Scope.** The seeded graph is acyclic and shallow (25 nodes, 26 edges) and produced **zero**
disagreements against an independent fixpoint reference — but dependencies are user-creatable, so
the defect was reachable. The published showcase numbers are unchanged: **12 assets failed,
18,400 people affected, depth 2**, identical snapshot hash.

**Verification.** `backend/tests/test_simulation_engine.py` — the ordering case, the same-depth
case, termination on a dense graph, and the documented demo cascade.

### C4. Optimiser blamed capacity for constraints it never tested

**Observation.** Ten sites, 90-minute horizon, one generator with 30 units available:

```
served 2/10
reason: "Insufficient eligible capacity: 30 available against a requirement of 1,
         or the remaining capacity was committed to a higher-priority demand."
```

A sentence that contradicts itself: capacity was not the limit, the clock was. A second case was
mis-attributed too — a requirement genuinely exceeding all eligible capacity was blamed on
"committed to a higher-priority demand", a different thing an operator would escalate differently.

**Root cause.** `_explain_unserved()` named capacity unconditionally and never computed the
binding constraint.

**Fix.** The explanation measures what is true when the solve finishes — the unspent mobilisation
budget and the eligible capacity still unallocated — and reports one of four tested conditions,
quoting the numbers that bound the decision:

```
horizon  : "No mobilisation budget left: the cheapest eligible dispatch needs 45 min but only
            0 min of the horizon is unspent, so this site cannot be reached in time."
capacity : "Requirement exceeds total eligible capacity: 320 needed but only 270 exists across
            4 eligible resources."
commitment: "Eligible capacity is exhausted for this plan: 10 of the 100 eligible capacity is
            still unallocated against a requirement of 90 ..."
objective: "Not selected by the optimiser: serving this site would have displaced a
            higher-value demand ..."
```

The solver itself was **not** changed; it chose the same allocation before and after.

### C5. CSV formula injection (CWE-1236)

**Observation.** Four incidents were created with plausible titles and exported by the analyst:

```
INC-0010,"=HYPERLINK(""http://evil.example/x"",""payroll"")",...,reported
INC-0011,@SUM(1+1)*cmd|calc,...,reported
INC-0009,=1+1,...,reported
formula-leading cells found in the export: 6
```

**Root cause.** Incident titles, asset names and notes are free text and went into the CSV
verbatim. Quoting does not help — Excel and LibreOffice unquote and still evaluate.

**Why it matters here specifically.** This is a *crossed-permission* path, not self-inflicted: an
operator writes incidents and does not hold `analytics:export`; an analyst holds the export and
does not write incidents. The app's own RBAC puts the author and the victim on opposite sides.

**Fix.** Values beginning with `=`, `+`, `-`, `@`, tab or CR are prefixed with an apostrophe,
which makes the cell literal in both spreadsheets without changing the visible text. Genuine
numbers (`-3.5`, `+12`) are left alone so numeric columns do not degrade into text.

**Verification.** `backend/tests/test_api_crud_and_validation.py` — four injection payloads
exported end-to-end, plus a numeric-preservation test and an ordinary-text test.

### C6. Retry corrupted a workflow that had not failed

**Observation.** `POST /workflows/{id}/retry` on a workflow in `awaiting_approval`:

```
healthy WF-0003: status=awaiting_approval step=plan_approved
POST retry -> 200
  completed steps after : unchanged
  status awaiting_approval -> running     <- an approval-gated workflow is now "running"
  retry_count: 0 -> 1 -> 2
```

**Root cause.** `retry_workflow()` accepted any status in
`(failed, running, awaiting_field, awaiting_approval)`. Nothing depended on the permissive
behaviour — the workflow console only renders Retry when `status === "failed"`.

**Fix.** Retry requires `failed`, the state the fault-injection path produces. The failure message
says so. The genuine resume path is covered by a positive-control test that also asserts every
already-completed step survives.

### C7. Two text tokens failed WCAG AA

**Observation.** Recomputing contrast on the surfaces the browser actually paints (a glass panel
is `navy-850` at 70 % over the page, plus 5–10 % white for raised rows):

| token | navy-950 | navy-900 | glass | glass+5 % | glass+10 % | verdict |
|---|---|---|---|---|---|---|
| old `ink-400` `#6b8fb3` | 5.82 | 5.54 | 5.44 | 4.84 | **4.16** | below AA |
| old `ink-500` `#4d6d8f` | **3.66** | **3.48** | **3.42** | **3.04** | **2.62** | below AA |

163 usages of `ink-500`, 157 of them at 10–11 px, where the 3:1 large-text allowance does not
apply. AA for those sizes is 4.5:1.

**Fix.** The tail of the ink scale is re-spaced so the scale stays ordered light→dark while every
step clears 4.5:1 on every surface, worst case **4.72:1**. `ink-50`…`ink-200` lighten slightly to
keep the luminance steps even. Chart axes hardcoded the old hexes — and those ticks are 9–10 px —
so they were corrected to match.

**Verification.** `backend/tests/test_design_tokens.py` recomputes the composited surfaces from
the tokens (12 assertions: every text token, the four semantic colours, monotonicity, and no
stale hardcoded hex outside a comment). The guard was **verified to fail** against the original
values before being trusted.

### C8 / C9. Coverage and tooling gaps

- The responsive overflow check walked 6 of 17 authenticated routes; administration screens carry
  the densest tables and were uncovered. All 17 are now covered, each paired with a role that can
  actually load it (a role without the permission renders a "requires this permission" panel,
  which would have made an overflow check pass on a page showing no content). Suite: 47 → 69 tests.
- `authz_probe.py` flagged `GET /auth/roles` on every run. That route is public on purpose — the
  registration form renders the role list before the visitor has a session. Naming the exception
  set (`PUBLIC_BY_DESIGN`) makes the probe's output a signal again.

---

## D. Investigated and found sound

Recorded as verified work rather than omitted.

**D1. Reservation concurrency (PostgreSQL 16).** Two concurrent approvals must not double-book an
exclusive resource. With 2 units free on a 30-unit resource, 12 simultaneous single-unit
reservations produced:

```
codes: {200: 2, 409: 10}
after: reserved=30.0 available=0.0     OVERBOOKED: False
```

Exactly the capacity was granted; the rest were refused with a reasoned 409. The reserve path uses
`SELECT … FOR UPDATE` on PostgreSQL and an explicit re-check on SQLite.

**D2. Administrator self-lockout.** `PATCH /users/{self} {is_active:false}` returns **403** and the
session remains valid; an operator attempting `role_keys:["super_admin"]` on itself returns 403.

**D3. Login rate limiting.** 17 of 30 simultaneous logins were refused with 429 while legitimate
sequential logins succeeded.

**D4. OpenAPI contract surface.** 93 operations across 80 paths: no duplicate `operationId`, no
path/parameter mismatches, no untagged operations, a success response declared for 93/93, and a
documented body for every GET.

**D5. Audit trail.** 145 rows, actor-attributed, including every login and every fix's side
effects.

---

## E. Screen-by-screen audit

27 pages were requested as each of four roles (108 requests). Every page returned HTTP 200 with no
runtime-error markers for every role. Two caveats are stated plainly rather than hidden:

- **Server-rendered HTML only.** The app is client-rendered behind an auth shell, so SSR proves the
  route compiles and the shell ships — not that the role-specific body draws.
- **No browser available.** `npx playwright install chromium` cannot download in this sandbox
  (egress is limited to PyPI/npm/GitHub), and no system browser or DOM library is present. Playwright
  cases are asserted statically via `--list` and `tsc`, not executed.

C1 references the authoritative Canva design; only page 1 is extractable, so pages 2+ are marked
`Not verified` for pixel parity rather than assumed.

| Screen | A-audit result | Role guard | Responsive | Accessibility | Status |
|---|---|---|---|---|---|
| `/` landing | 200, all four anchors + `LIVE DIGITAL TWIN • SYNCED` pill + tagline present | public | covered | contrast AA | **Verified** for C6; `Partially verified` vs Canva page 1 |
| `/login` | 200 | public | — | labels wrap inputs, AA | **Verified** |
| `/register` | 200, role list loads pre-session | public (`/auth/roles`) | — | AA | **Verified** |
| `/forgot-password` | 200 | public | — | AA | **Verified** |
| `/dashboard` | 200 all roles; bundle is permission-scoped | by design, payload filtered | covered | AA | **Verified** (payload scoping tested) |
| `/twin` | 200 | `twin:read` | covered | AA; status dot is colour-only | **Verified** with a recorded a11y note (E1) |
| `/incidents` | 200 | `incident:read` | covered | AA | **Verified** |
| `/incidents/[id]` | 200 | `incident:read` | not covered | AA | `Partially verified` |
| `/infrastructure` | 200 | `infrastructure:read` | covered | AA | **Verified** |
| `/infrastructure/[id]` | 200 | `infrastructure:read` | not covered | AA | `Partially verified` |
| `/simulation` | 200 | `simulation:read` | covered | AA | **Verified** |
| `/simulations/[id]` | 200 | `simulation:read` | not covered | AA | `Partially verified` |
| `/optimization` | 200 | `optimization:read` | covered | AA | **Verified** |
| `/optimization/plans/[id]` | 200 | `optimization:read` | not covered | AA | `Partially verified` |
| `/resources` | 200 | `resource:read` | covered | AA | **Verified** |
| `/tasks` | 200 | `task:read` | covered | AA | **Verified** |
| `/tasks/[id]` | 200 | `task:read` | not covered | AA | `Partially verified` |
| `/my-tasks` | 200 | `task:execute` | covered | AA | **Verified** |
| `/workflows` | 200 | `workflow:read` | covered | AA | **Verified** |
| `/workflows/[id]` | 200; Retry only rendered when `failed` | `workflow:read` | not covered | AA | **Verified** (C6) |
| `/analytics` | 200; analyst receives data, engineer gets 403 from the API | `analytics:read` | covered | AA | **Verified** |
| `/notifications` | 200; own inbox only, no overlap between users | ownership-scoped | covered | AA | **Verified** |
| `/profile` | 200 | session | covered | AA | **Verified** |
| `/docs` | 200 | session | covered | AA | **Verified** |
| `/admin/users` | 200; non-admin sees a permission panel, never a blank shell | `user:read` | covered | AA | **Verified** |
| `/admin/audit` | 200 | `audit:read` | covered | AA | **Verified** |
| `/admin/settings` | 200; read on `user:read`, write on `settings:manage` | `user:read` | covered | AA | **Verified** |

Detail pages are `Partially verified` on responsive layout only — they were rendered and audited but
are not in the overflow matrix, because several need a live id per run.

---

## F. Integration testing

| Item | What was run | Result |
|---|---|---|
| B1 API contracts | OpenAPI introspection of 93 operations | **Verified** (D4) |
| B2 PostgreSQL 16 | Full suite on a real PG16 instance via UNIX socket | **206 passed, 0 skipped** |
| B3 Playwright | 69 tests parse across chromium + Pixel 7; browser cannot be installed here | `Partially verified` |
| B4 17-step end-to-end | `scripts/smoke.py` — incident → simulation → plan → approval → dispatch → accept → verify → resolve → analytics → audit | **26/26 pass** |
| B5 failure & concurrency | Concurrent reservations on PG16; injected workflow faults; rate limiting | **Verified** (D1–D3) |
| B6 regression | Full suite both dialects + smoke + authz probe | **Verified** |

The end-to-end demonstration still reports its documented figures: 12 assets failed, 18,400 people
affected, depth 2, a feasible plan persisted, 10 repair tasks dispatched, all verified, incident
resolved, no stranded reservations.

---

## G. UI/UX audit against the authoritative design

The reference is the Canva deck "SYMBIOTIC CITY UI/UX". Only page 1 is machine-extractable; deck
pages 2 and beyond are **Not verified** for pixel parity, and no claim of parity is made for them.

**C6 landing anchors — verified present**, and they are part of the design, so the earlier
suspicion that they were stray markup was wrong:

```
About   Features   Support   Contact
LIVE DIGITAL TWIN • SYNCED
Welcome to / SYMBIOTIC CITY
"A unified command layer for the resilient, responsive city."
Login   Register
© 2025 SYMBIOTIC CITY Privacy Terms
```

**C5 accessibility — done and measurable:** contrast fixed and guarded by test (C7); every input
has an accessible name (labels wrap their inputs and include units like `kVA`/`P`; shared
`Field`/`Input` primitives wire `id`/`htmlFor` and `aria-invalid`); 32 icon-only buttons carry
`aria-label`; the decorative SVG is `aria-hidden`; the skip link exists and is asserted by an e2e
case; charts use semantic colour tokens rather than raw hex.

**C4 responsive — done where it can be verified:** 17 routes now laid out at 412 px, each as a role
that can load it (C8). Grid and breakpoint classes are used consistently; the run itself is
`Partially verified` because no browser is available.

---

## H. Residual risks and recommendations

1. **Twin asset-status dot is colour-only** (E1). Status is conveyed by a 6 px coloured dot beside
   the asset code, with no text or icon alternative; that fails WCAG 1.4.1 for a colour-blind
   operator. It also sits on `glass + white/5`, where the *current* `ink-300` label measures about
   8.8:1 — safe, but with little room if the dot's hue is changed for aesthetics. Recommended:
   pair the dot with `aria-label={status}` or a tiny glyph. **Not changed** — it is a design
   decision, and the report should not silently redesign the twin.
2. **Playwright and Canva pages 2+** are unverifiable in this environment. Run `npm run e2e` where a
   browser can be installed before claiming browser-level parity.
3. **`require_permissions` means all-of**, `require_any_permission` is the union. The task-transition
   route depends on that distinction; a future edit that swaps them would silently refuse operators.
   The positive-control test exists to catch exactly that.
4. **Cascade history provenance lives in the reason string** (`[cascade]` prefix). It survives
   restarts without a schema migration, but a future feature that rewrites history reasons would
   break recovery. A dedicated column would be sturdier once the schema is next touched.
5. **CSV neutralisation is applied at export only.** Any future export path must route through
   `export_csv()`; a second hand-rolled writer would reopen CWE-1236.

---

## Appendix: commands used

```bash
# suite, both dialects
.venv/bin/python -m pytest backend/tests -q
POSTGRES_TEST_URL="postgresql+psycopg2://postgres@/deep_suite?host=/tmp/pg_a1" \
  .venv/bin/python -m pytest backend/tests -q

# evidence tools
.venv/bin/python scripts/smoke.py http://127.0.0.1:8081/api
.venv/bin/python scripts/authz_probe.py

# frontend
cd frontend && npx tsc --noEmit && npx next build && npx playwright test --list
```
