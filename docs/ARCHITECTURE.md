# Architecture

## Shape

Two deployables, one schema, no hidden services.

```
browser ──► Next.js 15 (:3000) ──/api rewrite──► FastAPI (:8000) ──► SQLAlchemy 2 ──► SQLite | Postgres
                                                      │
                                      ┌───────────────┼────────────────┐
                                      ▼               ▼                ▼
                               simulation/       optimization/    workflows/
                               graph cascade     CP-SAT planner    step engine
```

The frontend is a real BFF-free client: the browser talks only to port 3000, and
Next.js rewrites `/api/*` to the API. That single decision removes CORS from the
happy path, keeps the session cookie first-party, and means the production image
needs exactly one environment variable (`BACKEND_URL`).

## Backend layering

| Layer | Location | Rule |
| --- | --- | --- |
| Routers | `app/api/routes/*.py` | Parse input, call a service, shape the response. No business logic, no direct engine calls beyond services. |
| Services | `app/services/*.py` | Domain rules and transactions: incidents, tasks, resources, optimization, simulation, analytics, users, audit, notifications. |
| Engines | `app/simulation/`, `app/optimization/`, `app/workflows/` | Pure-ish computation plus explicit persistence calls. Deterministic; no HTTP knowledge. |
| Models | `app/models/*.py` | SQLAlchemy 2 typed mappings, 30 tables, 6 modules. |
| Core | `app/core/` | config, database session, security primitives, permission catalogue, response envelopes, custom types, caching helpers. |

Cross-cutting conventions:

* **Envelopes.** Every success is `{success, data, meta?}`; every error is
  `{success:false, error:{code, message, details?}}` produced by `ApiError` +
  global handlers, so the client can branch on `error.code` instead of guessing
  from prose.
* **Sessions.** httpOnly cookie holding a signed JWT whose `sid` maps to a
  `sessions` row; revocation is a row update, so logout/revoke-all are real.
* **CSRF.** Double-submit: `symbiotic_csrf` cookie (readable) must equal the
  `X-CSRF-Token` header on any non-safe request that carries a session cookie.
  Only the four credential endpoints are exempt.
* **Authorisation.** `require_permissions("x:y")` dependencies on the routers;
  4 roles map to 26 permissions in `app/core/permissions.py` (single source,
  persisted so admins can inspect them).
* **Idempotency.** `idempotency_keys` table + a dependency for the mutation-heavy
  endpoints, so a retried POST cannot double-reserve capacity.
* **Audit.** `services.audit.record()` writes actor, action, target, before/after
  and request id inside the same transaction as the change it describes.

## The three engines

### 1. Cascading failure (`app/simulation/`)

A directed graph of 23 assets / 25 dependency edges. Failure propagates breadth
first; each node accumulates a supply deficit

```
deficit(v) = 1 − ∏_{e: u→v, u failed} (1 − impact_weight(e) · (1 − redundancy(e)))
```

`deficit ≥ threshold` ⇒ the node fails; `≥ 0.6·threshold` ⇒ degraded. Modes scale
the initial loss (`total_failure` 1.0, `capacity_loss` 0.75, `maintenance` 0.4).
No sampling anywhere, so a run is reproducible byte for byte; the seed is recorded
and used only by the optional, off-by-default load-noise term.

Outputs: failed/degraded sets per depth, affected population, per-asset status
history rows, and a snapshot hash.

### 2. Recovery optimisation (`app/optimization/`)

CP-SAT over `x[d][r]` integer quantities with an all-or-nothing `served[d]`
boolean. Constraints: resource availability, category eligibility, mobilisation
window, total horizon, optional priority floors. Objective maximises
`Σ served·value − Σ cost`, with exponential priority weights (60/30/12/5/2) so a
hospital always beats five shops.

Determinism: `num_search_workers=1`, `random_seed=7`. Infeasible models are not a
crash: the planner returns a reduced explanation (which constraint blocked which
demand) that the UI renders verbatim.

### 3. Recovery workflow (`app/workflows/`)

Ten steps, in order:

```
incident_created → incident_validated → simulation_performed →
recovery_plan_generated → plan_approved → resources_reserved →
repair_tasks_assigned → engineer_accepted → repair_verified → incident_resolved
```

The first four run automatically on `POST /workflows/start`. The workflow then
parks at `awaiting_approval` until a human approves the plan; the approval
endpoint resumes it (`resources_reserved` → `repair_tasks_assigned`). The last two
steps are driven by field reality: the first accepted task records
`engineer_accepted`, and verifying the last open task records `repair_verified` and
resolves the incident.

Failure handling, which is the part worth reading:

* **Per-step savepoints.** `_execute_step` opens a SQLAlchemy `begin_nested()`
  around each handler. A failure rolls back only that step's partial writes — not
  the approval, not the incident, not the run.
* **Failure records outside the savepoint.** `_record_failed_step` writes the
  failed step + reason after the savepoint has unwound, so the ledger survives.
* **Compensation.** `_compensate` releases reserved capacity and cancels
  undispatched tasks, then records a `compensation` event listing exactly what it
  released. When the savepoint already discarded everything, the event says so
  (`savepoint_rollback: true`) instead of staying silent.
* **Retry.** `retry_workflow` increments `retry_count`, re-runs from
  `resume_from_current_position()`, and appends a `retry` event. Events are unique
  per `(workflow, step, attempt)`, so history stays readable across attempts.
* **Fault injection.** `POST /workflows/{id}/simulate-failure?step=` arms the next
  run of that step to raise. This exists so the compensation path can be
  demonstrated instead of asserted.

API level: when the reservation step faults during approval, the endpoint
re-applies the approval and failure state, audits
`optimization.plan_approval_failed`, and answers `409` with
`details = {workflow_id, failure_step, compensated: true}`. The console turns that
into a plain-language banner rather than a generic toast — the approval is kept,
the step is rolled back, and the user is pointed at the workflow.

## Frontend

* **App Router**, React 19 server components for data-shaping pages, client
  components where interaction lives (twin canvas, forms, tables).
* **Session** is resolved once in a context provider from `GET /auth/me`; the
  shell renders role-filtered navigation from the same permission list the API
  enforces, so a hidden link and a `403` never disagree.
* **API client** (`lib/api.ts`): typed wrappers, CSRF header injection from the
  readable cookie, error normalisation to `{code, message, details}`, and
  `credentials: "include"`.
* **Charts** are Recharts; the twin is hand-drawn on `<canvas>` (no WebGL, no
  external map tiles, no CDN) so it works offline and in restricted sandboxes.
* **Styling** is Tailwind with a small token set (navy `#040b18`/`#061225`,
  accent `#45d8f5`, mint `#3ee6a5`, amber `#ffb545`, coral `#ff6b6b`,
  hairline `rgba(143,179,212,0.16)`). System font stack only: no font CDN.
* **No fabricated numbers.** Every figure on every screen comes from an API
  response; empty states say "no data" rather than showing a plausible zero.

## Data model

30 tables in six modules (`app/models/`): identity (users, roles, permissions,
sessions, reset tokens, settings), infrastructure (zones, assets, dependencies,
status history), operations (incidents, incident assets/events, repair tasks,
task history, resources), simulation (scenarios, runs, results), optimization
(requests, plans, assignments, reservations), workflow (instances, events) plus
notifications, audit logs, idempotency keys.

See [MODELS.md](MODELS.md) for the maths and the state machines, and
[DATA_MODEL.md](DATA_MODEL.md) for the tables.

## Deployment and operations

Docker Compose (Postgres + API + console), non-root containers, healthchecks,
Alembic migrations, `SEED_DEMO_DATA` to control seeding. `scripts/verify.sh`
round-trips migrations up and down, runs the 105 backend tests, typechecks and
builds the frontend.

Scheduler: **none**. Cascade propagation, optimisation and workflow steps are
synchronous request-scoped work. A background queue would be the next step for
longer plans; today's solve times are tens of milliseconds on 9 demands × 12
resources.

## Scaling notes and known limits

* SQLite + in-process solving is right for a demo, wrong for a city of 10⁵ assets.
  The graph engine is `networkx`-based and would need a partitioned adjacency
  store; CP-SAT would need horizontal partitioning by zone.
* Session revocation is checked per request against the database — correct, one
  read per call, and a candidate for a short-TTL cache.
* Workflow state is transactional, not durable: a process crash mid-step leaves
  the workflow in its last committed state and a retry is the recovery path. No
  message broker, by design and by budget.
* The audit log is append-only in practice (no update path) but has no retention
  policy or tamper-evident chaining.
