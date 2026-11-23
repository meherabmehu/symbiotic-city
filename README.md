<div align="center">

# SYMBIOTIC CITY

**Self-healing urban intelligence for a city that can rehearse its own failures.**

A synthetic smart-city digital twin: a cascading-failure simulator, a constrained
recovery optimiser, and an audited multi-step recovery workflow — behind one
command console.

_Institution: independent portfolio project · City: Aurora Vale (fictional, 148,000 people) · Data: 100 % synthetic_

</div>

---

## The problem this solves

When a city's power feeder trips at 03:00, the response is usually improvised: a
duty engineer phones around, capacities are counted on a whiteboard, and nobody can
answer "which hospital loses water if this substation stays down for six hours?"

SYMBIOTIC CITY answers three questions before the incident, and one after it:

1. **What breaks next?** — model the dependency graph, inject a failure, watch the
   cascade propagate with per-asset deficit maths and population impact.
2. **What is the best recovery we can actually afford?** — CP-SAT chooses which
   assets to serve with which generators, tankers and crews, under capacity,
   eligibility, mobilisation-time and priority-floor constraints. All-or-nothing
   per asset: no hospital at 40 % power.
3. **Who does what, and did it happen?** — approval reserves capacity, dispatch
   creates tasks, engineers accept and complete, a verifier signs off, the workflow
   closes the incident. Every transition is in the audit trail.
4. **What if the automation itself fails?** — the workflow engine supports fault
   injection, per-step savepoints, compensating actions and retry, because a demo
   that only shows the happy path is not a demonstration of resilience.

## What it looks like

| Screen | What it does |
| --- | --- |
| **Command deck** | Live KPIs, active incidents, pending approvals, task board, resource spotlights — one bundle request. |
| **City twin** | Canvas graph of the 23-asset network with zoom, seed-a-failure, and keyboard asset navigation. |
| **Failure lab** | Configure mode / threshold / depth / seed, run, then open the replay with affected population and depth bands. |
| **Recovery planner** | Build demands from a run, preview feasibility, submit to CP-SAT, and read the explanation when it says *infeasible*. |
| **Plan console** | Approve or reject; if the reservation step fails, the approval survives and the compensation is reported honestly. |
| **Dispatch board** | Tasks with priorities, engineer assignment, transition history. |
| **Field workspace** | An engineer's own queue: accept → start → complete, with a repair log. |
| **Workflow console** | The 10-step recovery pipeline, per-step events, fault injection, retry, and the compensation ledger. |
| **Analytics** | Trends, category and severity breakdowns, resource utilisation, recovery performance, CSV export. |
| **Admin** | Users and roles, permissions matrix, system settings, audit log. |

## Architecture at a glance

```
┌─────────────────────────────┐        ┌──────────────────────────────┐
│  Next.js 15 console (3000)  │  /api  │  FastAPI service (8000)      │
│  App Router · RSC · canvas  │ ─────► │  routers → services → models │
│  cookie session + CSRF      │        │                              │
└─────────────────────────────┘        │  ┌────────────────────────┐  │
                                       │  │ simulation: graph BFS  │  │
                                       │  │ optimisation: CP-SAT   │  │
                                       │  │ workflows: 10 steps    │  │
                                       │  └────────────────────────┘  │
                                       └───────────────┬──────────────┘
                                                       │ SQLAlchemy 2
                                             ┌─────────▼──────────┐
                                             │ SQLite (dev)       │
                                             │ PostgreSQL (prod)  │
                                             └────────────────────┘
```

* **Transport** — REST/JSON, `{success, data, meta}` envelopes, `{success, error:{code,message,details}}` failures. 93 operations, OpenAPI at `/api/docs`.
* **Auth** — httpOnly session cookie + double-submit CSRF token + 4 roles × 26 permissions, all enforced server-side.
* **Determinism** — the simulator does no random sampling; the solver pins `num_search_workers=1` and `random_seed=7`, so the same scenario reproduces the same plan.

Full detail: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) · [docs/API.md](docs/API.md) · [docs/MODELS.md](docs/MODELS.md).

## For judges

| Document | What it answers |
| --- | --- |
| [docs/COMPETITION_MATRIX.md](docs/COMPETITION_MATRIX.md) | Every M01–M08 and A02/A07 claim mapped to the evidence that proves it |
| [docs/FINAL_PRODUCTION_AUDIT.md](docs/FINAL_PRODUCTION_AUDIT.md) | What was verified, what was not, and the eight defects found |
| [docs/DEMO_SCRIPT.md](docs/DEMO_SCRIPT.md) | The 8–10 minute recording script and checklist |
| [docs/SUBMISSION.md](docs/SUBMISSION.md) | S01/S02/S03 status, stated without inflation |

Each claim is marked **Verified**, **Partially verified**, **Not verified**,
**Blocked** or **Failed**. No incomplete test is reported as a pass.

## Quick start

```bash
# 1. Backend
python3 -m venv .venv
.venv/bin/pip install -r backend/requirements.txt

# 2. Frontend
cd frontend && npm install && cd ..

# 3. Run both (API :8000, console :3000)
./scripts/dev.sh
```

Open <http://127.0.0.1:3000>, sign in with a demo role, and follow
[docs/DEMO_SCRIPT.md](docs/DEMO_SCRIPT.md) for the recording script
(a shorter walkthrough is in [docs/DEMO.md](docs/DEMO.md)).

Demo accounts (synthetic, seeded on first boot):

| Role | Email | Password | Can |
| --- | --- | --- | --- |
| Super Admin | `admin@symbiotic.city` | `Admin#2026` | everything, users, settings, audit |
| City Operator | `operator@symbiotic.city` | `Operator#2026` | incidents, approvals, dispatch, verify |
| Field Engineer | `engineer@symbiotic.city` | `Engineer#2026` | own task queue |
| Field Engineer | `engineer2@symbiotic.city` | `Engineer#2026` | own task queue |
| City Analyst | `analyst@symbiotic.city` | `Analyst#2026` | simulate, plan, export |

## Verify it

```bash
./scripts/verify.sh          # alembic up/down, 112 backend tests (SQLite), tsc, build
./scripts/verify.sh backend  # just the API surface
python3 scripts/smoke.py     # live end-to-end flow against a running stack

# Schema work must also be checked on PostgreSQL: SQLite does not validate
# foreign keys while parsing DDL, so a broken revision looks green there.
# Pointed at a real PostgreSQL 16 server the same suite reports 122 passed, 0 skipped.
POSTGRES_TEST_URL=postgresql+psycopg2://postgres@/symbiotic_test ./scripts/verify.sh postgres

cd frontend && npm run e2e   # browser tests (starts the API and the app itself)
```

CI runs all of the above on every push: SQLite suite, a PostgreSQL 16 service job
that runs `alembic upgrade head` first, the frontend build, and Playwright.

## Repository layout

```
backend/
  app/
    api/routes/      nine routers: auth, infrastructure, simulation, optimization,
                     incidents, tasks, resources, workflows, analytics, admin
    core/            config, database, security, permissions, responses, types
    simulation/      graph cascade engine          optimization/  CP-SAT planner
    workflows/       step registry + engine (savepoints, compensation, retry)
    services/        domain logic shared by routers
    seed/            deterministic Aurora Vale catalogue + demo history
    models/          30 tables across identity, infrastructure, operations,
                     simulation, optimization, workflow, system
  migrations/        Alembic revisions (env.py renders custom UTCDateTime)
  tests/             122 tests: engines, API contract, RBAC, workflow e2e,
                     migrations, PostgreSQL parity
frontend/
  app/               27 routes: landing, auth, shell, and every operational screen
  components/        ui primitives, city twin canvas, charts, layout
  lib/               typed API client, session context, formatters
docs/                architecture, API reference, model maths, setup, demo script,
                     and AUDIT.md (independently verified findings)
scripts/             dev.sh, seed.sh, verify.sh, smoke.py
```

## Deliberate scope and honest limits

* **Synthetic city.** All five zones, 23 assets, 12 resources and the incident
  history are invented. Dependency weights are curated estimates, not engineering
  survey data.
* **Steady-state simulation.** No time-of-day load curves, no repair races inside
  a cascade. It is a resilience *screening* tool, not a validated hydraulic or
  electrical solver.
* **Single-node solver.** CP-SAT runs in-process with one worker for reproducibility,
  not as a distributed optimiser.
* **No live telemetry.** The twin reads seeded state plus operations performed in
  the app; there is no SCADA/Modbus feed, and nothing pretends to be one.
* **Workflow durability is transactional, not a queue.** Steps run inside per-step
  savepoints with recorded compensation; it is not a Temporal-style durable
  execution engine, and it does not resume after a process crash mid-step.
* **Notifications and password reset are in-app only.** Reset links/tokens are
  written to the server console in demo mode; no SMTP is configured.

See [docs/MODELS.md](docs/MODELS.md) for the maths, and the "limitations" sections in
each module docstring.

## Deployment

`docker compose up --build` brings up Postgres, the API (migrated + seeded) and the
console; see [docs/SETUP.md](docs/SETUP.md). The console proxies `/api` to the API
service, so no client-side CORS configuration is needed.

`SECRET_KEY` is required — the stack refuses to start without it rather than
running production on a guessable default:

```bash
export SECRET_KEY="$(openssl rand -hex 32)"
docker compose up --build
```

For a public deployment, set `NEXT_PUBLIC_DEMO_LOGIN=0` so the one-click demo
accounts are not advertised on the sign-in page.

**No public deployment exists for this entry.** The compose stack, both Dockerfiles
and the proxy are prepared and were reviewed statically, but no image was built and
no URL was tested in the audit environment. See
[docs/SUBMISSION.md](docs/SUBMISSION.md) §S03 for the exact blocker and the
commands that finish it.

## Licence

Code released for portfolio and educational use. Synthetic data only — no real
city, operator, or person is represented.
