# Competition matrix — SYMBIOTIC CITY

**Track:** World Problem Solver · **Hack the Vibe 2026**
**Advanced challenges claimed:** A02 (resource-constrained optimisation) and
A07 (multi-step fault-tolerant workflow)

This document maps each judged item to the artifact that proves it, gives the
command or click path that reproduces the evidence, and states honestly what has
*not* been verified. A claim is marked **Verified** only when it was executed and
observed. Where something could not be executed in the audit environment, the
reason is named and the claim is downgraded rather than inflated.

**Status vocabulary:** `Verified` · `Partially verified` · `Not verified` ·
`Blocked` · `Failed`

---

## Scorecard at a glance

| Item | Claim | Status | Reproduce with |
| --- | --- | --- | --- |
| M01 | Working application | Verified | `scripts/smoke.py` → 26/26 |
| M02 | Data model | Verified | 30 tables / 60 FKs, both databases |
| M03 | Simulation | Verified | `/simulation`, seed 42 |
| M04 | Optimisation | Verified | `/optimization`, feasible + infeasible |
| M05 | Multi-step workflow | Verified | fault injection → compensate → retry |
| M06 | Security | Verified (app layer) | see §M06 |
| M07 | UI/UX fidelity | Partially verified | Canva page 1 compared; pages 2+ unreachable |
| M08 | Deployment | Blocked | no Docker daemon, no credentials |
| A02 | Optimisation depth | Verified | §A02 |
| A07 | Fault tolerance depth | Verified | §A07 |

---

## M01 — The application works

**Verified.**

| Evidence | Result |
| --- | --- |
| Backend suite, PostgreSQL 16 | **122 passed, 0 skipped** |
| Backend suite, SQLite | 112 passed, 10 skipped |
| End-to-end smoke against a live API | **26/26**, repeated on fresh databases |
| Smoke through the Next.js proxy | **26/26** |
| Route sweep | 27 pages, every real route answers 200 |
| Frontend production build | compiled successfully; 27 routes emitted |

The 10 SQLite skips are PostgreSQL-only tests. Pointed at a real PostgreSQL 16
server the same suite reports 122 passed with **zero skips**, which is the run
that matters for the production database.

```bash
POSTGRES_TEST_URL=postgresql+psycopg2://postgres@/suite .venv/bin/python -m pytest backend/tests -q
.venv/bin/python scripts/smoke.py http://127.0.0.1:8000/api
```

---

## M02 — The data model

**Verified on both databases.**

| Evidence | Value |
| --- | --- |
| Tables | 30 |
| Foreign keys | 60 |
| FK referential actions | 36 `SET NULL` · 21 `CASCADE` · 3 `RESTRICT` |
| Alembic | single head, round-trips to base and back |
| Schema drift | zero |
| FK enforcement | **proven, not assumed** |

FK enforcement was tested by attempting to insert a `repair_tasks` row pointing at
a non-existent asset. PostgreSQL refused it with `fk_repair_tasks_asset_id`, which
is the only way to know enforcement is on rather than merely declared.

```bash
cd backend
alembic upgrade head && alembic downgrade base && alembic upgrade head
```

---

## M03 — Cascade simulation

**Verified.**

- Deterministic for a given `(seed, snapshot)`, which is what makes a plan
  defensible later.
- Propagation is `deficit = 1 − ∏(1 − impact_weight × (1 − redundancy))`, so two
  partially failing feeds do not add linearly.
- Reference run (seed 42, threshold 0.35, depth 6): **12 assets failed**,
  **18,400 people affected**, maximum depth **2**.
- Every run is persisted with its inputs, so the plan that followed can be
  replayed and audited.

---

## M04 — Recovery optimisation

**Verified.**

- A facility-location model with an **all-or-nothing coverage gate**:
  `served[d]` is boolean and gates `Σ_r x[d][r] ≥ need_d`. A hospital is never
  reported as "mostly served".
- Priority weights are exponential, so one hospital outranks five shops.
- The solver is deterministic: same demand set and inventory, same objective.
- Both outcomes are exercised: a **feasible** plan with per-resource assignments,
  unserved-demand reporting and a binding-constraint panel; and a **provably
  infeasible** request refused with an explanation
  (*"total demand (400) exceeds total resource capacity (335)"*).

This is the evidence for **A02**, expanded below.

---

## M05 — The recovery workflow

**Verified.** Ten steps from `incident_created` to `incident_resolved`, with a
fault-injection hook and a compensation ledger. See **A07**.

---

## M06 — Security

**Verified for application-layer controls; host hardening Not verified.**

| Control | Evidence |
| --- | --- |
| Password storage | bcrypt; 72-byte truncation handled by pre-hashing |
| Sessions | server-side records, revocable, expiry enforced |
| Session cookie | `HttpOnly`, `SameSite=Lax`, `Secure` **forced in production** |
| CSRF | double-submit token on every state-changing request |
| CORS | explicit allow-list; wildcard preview regex **withdrawn in production** |
| Rate limiting | 30/min on auth, higher on writes |
| Authorisation | 26 permissions × 4 roles, enforced in the dependency layer |
| Public errors | generic codes to clients, detail only in logs |
| Audit logging | actor, target, timestamp, result on every mutation |
| Secret hygiene | no `.env` tracked; `.env.example` holds placeholders only |
| Weak-secret guard | production **refuses to boot** on the development default |

**Caveat:** the audit ran against local and CI deployments, not a hardened public
host. TLS termination, HSTS and a real secrets manager are properties of the
hosting platform and are **Not verified** here.

Confirmed refusals observed live: analyst → `POST /api/incidents` = **403**;
operator → `POST /api/optimization/requests` = **403**; engineer → `GET
/api/audit-logs` = **403**; anonymous write = **401**.

---

## M07 — UI/UX fidelity to the Canva design

**Partially verified.** Stated plainly: the landing page was compared against the
reference design and matches in palette, typography, layout and copy. **The
remaining design pages could not be retrieved** from this environment, so they are
**Not verified** rather than assumed.

| Aspect | Status |
| --- | --- |
| Landing page: palette, type scale, layout, copy | Verified |
| Design tokens: navy `#040b18`, accent `#45d8f5`, mint `#3ee6a5`, amber `#ffb545`, coral `#ff6b6b` | Verified in `tailwind.config.ts` and rendered |
| Pages 2+ of the design | **Not verified** — source pages unreachable |
| Responsive behaviour | Verified by the browser suite at Pixel 7 and desktop |
| Accessibility | Landmarks, skip link, focus order, keyboard-operable twin |

A real responsive defect was found here: the digital twin canvas seeded itself
with a 900 px width before measuring its container, widening `/twin` and
`/simulation` by ~548 px on a phone and ~388 px on a desktop.

---

## M08 — Deployment

**Blocked.** No Docker daemon is available in the audit environment
(`docker: command not found`) and no hosting credentials exist, so no image was
built and no public URL was tested. Nothing about deployment is claimed.

What *is* prepared:

| Artifact | State |
| --- | --- |
| `Dockerfile.backend` | build paths corrected during the audit |
| `Dockerfile.frontend` | multi-stage; proxy target fixed |
| `docker-compose.yml` | db + api + web, healthchecks on all three |
| Compose start-up order | `db → api → web`, all `service_healthy` — **fixed**, previously could not start |
| `SECRET_KEY` | required, no default |
| Public URL | does not exist |

**Blocker:** Docker socket access and a hosting account, both outside this
environment's control. The exact commands to finish are in
[`SUBMISSION.md`](SUBMISSION.md) §S03.

---

## A02 — Resource-constrained optimisation (advanced)

**Verified.** A02 asks for optimisation meaningfully stronger than "call a solver".
The distinguishing behaviours:

### Conflicting constraints

Four constraint families that genuinely fight each other: coverage (a demand must
be fully served), capacity (inventory is finite), travel time (a crew cannot be in
two places), and priority (a hospital outranks shops). The binding-constraint panel
names *which* family bound the solution, so an operator can argue with the model
instead of guessing.

### Infeasibility, proven rather than silent

When demand exceeds capacity the request is refused with an explanation. The
planner does not quietly drop the hardest demand to return a "successful" plan, and
it never returns a fractional hospital. Demonstrated live with
`force_infeasible_demo`: **total demand 400 > total capacity 335**.

### Explainability

Every persisted plan carries its objective value, coverage percentage, solver wall
time, the demands it could not serve (`asset_code` per unserved demand), and the
per-resource assignments. `GET /api/optimization/plans/{id}` returns the full
explanation, which is what makes a plan reviewable after the incident.

### Determinism

Same input, same objective value, same assignment set. A plan can be re-derived
and compared rather than trusted.

---

## A07 — Fault-tolerant multi-step workflow (advanced)

**Verified.** A07 asks for controlled failure → compensation → recovery → retry.
Every stage was executed and observed:

1. **Controlled injection.** `POST /api/workflows/{id}/simulate-failure?step=resources_reserved`
   schedules a failure at a named step, before approval.
2. **Failure containment.** Each step runs inside its own savepoint. A mid-step
   failure discards **only that step's** partial writes.
3. **Compensation.** The failure and compensation records are written *outside* the
   savepoint, which is why they survive the rollback. The API answers `409` with
   `details = {workflow_id, failure_step, compensated: true}`.
4. **The operator's decision is preserved.** The plan stays **approved**. A failure
   in the reservation layer must not erase a human approval.
5. **Recovery and retry.** Retry resumes from the workflow's current position,
   reserves capacity, dispatches field tasks, and the cycle completes.

The claim is not "we handle errors". It is: *here is the ledger of what we rolled
back, and the human decision survived it.*

---

## The 15-step judging sequence

| # | Step | What the judge sees | Status |
| --- | --- | --- | --- |
| 1 | Open the submission | README, judge index, video link | Partially verified — no video, no live URL |
| 2 | Land on the product | Hero, premise, four roles | Verified |
| 3 | Sign in as each role | Four dashboards, different navigation | Verified |
| 4 | Inspect the data | 23 assets, 25 dependency edges, 5 zones | Verified |
| 5 | Explore the twin | Hover, select, pan, zoom, keyboard | Verified |
| 6 | Run a simulation | Deterministic cascade with impact overlay | Verified |
| 7 | Read the impact | Assets failed, population affected, depth | Verified |
| 8 | Generate a plan | Feasible plan with assignments | Verified |
| 9 | Read the explanation | Binding constraints, unserved demands | Verified |
| 10 | Force infeasibility | Refused with a stated reason | Verified |
| 11 | Approve and dispatch | Tasks created and assigned | Verified |
| 12 | Complete field work | Engineer accepts and completes; operator verifies | Verified |
| 13 | Inject a fault | Compensation ledger, plan still approved | Verified |
| 14 | Retry | Workflow resumes and completes | Verified |
| 15 | Check the boundary | RBAC refusals; audit log lists everything | Verified |

Step 1 is the only gap, and it traces to a single blocker: no hosting credentials
and no Docker daemon.

---

## What is not verified, and what would close it

| Gap | Why | To close it |
| --- | --- | --- |
| Live public URL | No hosting account, no Docker daemon | Build the images, deploy behind TLS, re-walk the 15 steps against the public host |
| Design pages 2+ | Reference pages unreachable from this environment | Compare each remaining page and record differences |
| Video upload | Recording requires a human presenter | Record from `DEMO_SCRIPT.md`, upload, link in README |
| Cross-browser | Only Chromium is exercised | Add Firefox and WebKit projects to `playwright.config.ts` |

None of these is a defect in the application. Each is an environment or
asset-availability limit, named rather than hidden.
