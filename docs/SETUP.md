# Setup and operations

Two paths: the local development path (SQLite, no Docker) and the
production-shaped path (Postgres, two containers).

## 1. Local development

### Prerequisites

* Python 3.11+ (3.12 works; 3.13 does too, OR-Tools wheels permitting)
* Node.js 20.9+ and npm (Next.js 16 requires it)
* No database server: SQLite is the default

### Install

```bash
python3 -m venv .venv
.venv/bin/pip install -r backend/requirements.txt

cd frontend
npm install
```

### Configure

```bash
cp .env.example .env
```

Everything has a working default. The values worth knowing:

| Variable | Default | Meaning |
| --- | --- | --- |
| `DATABASE_URL` | `sqlite:///<repo>/backend/data/symbiotic_city.db` | SQLAlchemy URL. Relative SQLite paths resolve against the **repository root**, not the process cwd. |
| `SECRET_KEY` | dev placeholder | Signs session tokens. Must be replaced in production. |
| `ACCESS_TOKEN_EXPIRE_MINUTES` | `480` | Session lifetime. |
| `COOKIE_SECURE` | `false` | Set `true` behind HTTPS. |
| `CORS_ORIGINS` | `http://localhost:3000,http://127.0.0.1:3000` | Browser origins allowed to call the API directly. |
| `SEED_DEMO_DATA` | `1` | Seed Aurora Vale on boot (idempotent). |
| `AUTH_RATE_LIMIT_PER_MINUTE` | `30` | Per-IP limit on auth endpoints. |
| `BACKEND_URL` (frontend) | `http://127.0.0.1:8000` | Where Next.js rewrites `/api/*`. |

### Run

```bash
./scripts/dev.sh          # API :8000 + console :3000
./scripts/dev.sh api      # API only
./scripts/dev.sh web      # console only
```

Then: <http://127.0.0.1:3000> · API docs <http://127.0.0.1:8000/api/docs>.

**Why the console must proxy `/api`:** the session cookie is `httpOnly` and
`SameSite=Lax`; the browser only ever talks to port 3000, and Next.js rewrites
`/api/*` to the API. That keeps cookies first-party and removes CORS from the
happy path entirely. Calling `http://127.0.0.1:8000` from browser code breaks
both cookies and CSRF, and is not supported.

### Reset the data

```bash
FORCE=1 ./scripts/seed.sh     # bash
```

```powershell
.\scripts\seed.ps1 -Force     # Windows / PowerShell
```

Both ask the app where the database is (so a custom `DATABASE_URL` is honoured)
rather than assuming a path, and both use the same deterministic seeder.

`seed.ps1` clears the tables instead of deleting the file. On Windows a file
held open by the running API cannot be deleted, so a delete-based reset fails
exactly when someone has the app running -- the normal time to want one. Add
`-KeepRuns` to keep simulation, optimisation and workflow history.

The seeder is deterministic (`random.Random(20260101)`): the same catalogue, the
same historical incidents, the same ids on every reset.

## 2. Migrations

Alembic owns the schema for anything beyond local scratch work; the app's
lifespan still calls `create_all` so a fresh clone boots with zero steps.

```bash
cd backend
../.venv/bin/alembic upgrade head
../.venv/bin/alembic revision --autogenerate -m "describe the change"
../.venv/bin/alembic downgrade -1
```

`migrations/env.py` reads `DATABASE_URL` from the app settings and renders the
custom `UTCDateTime` column type as `sa.DateTime(timezone=True)`, so generated
revisions import cleanly without the application package.

**After regenerating any revision that creates tables, run:**

```bash
python3 scripts/sort_migration.py backend/migrations/versions/<revision>.py
```

`alembic revision --autogenerate` emits `create_table` calls alphabetically with
the foreign keys inlined. SQLite accepts that; PostgreSQL does not, because it
resolves the referenced table when the constraint is created. This schema also
has real cycles (`incidents` ⇄ `optimization_plans` ⇄ `optimization_requests`,
`incidents` ⇄ `simulation_runs`), so ordering alone cannot fix it. The script
keeps every column and constraint definition, moves the foreign keys into
`create_foreign_key` calls after all tables exist, and mirrors the order in
`downgrade()`. `--check` reports whether a revision still needs it.

To target a scratch database:

```bash
DATABASE_URL="sqlite:////tmp/scratch.db" ../.venv/bin/alembic upgrade head
```

## 3. Docker Compose (production-shaped)

```bash
cp .env.example .env
# edit SECRET_KEY, POSTGRES_PASSWORD, COOKIE_SECURE=true, CORS_ORIGINS=https://your.host
docker compose up --build
```

Services:

| Service | Port | Notes |
| --- | --- | --- |
| `web` | 3000 | Next.js standalone-ish image, proxies `/api` to `api:8000`. |
| `api` | 8000 | uvicorn, non-root user, healthcheck on `/api/health`. |
| `db` | internal | Postgres 16, named volume `pgdata`, `pg_isready` gate. |

Compose ordering: `api` waits for `db` to be healthy; `web` waits for `api` to be
healthy. The API seeds on boot when `SEED_DEMO_DATA=1`; set it to `0` for a real
deployment and create the first admin through `POST /api/auth/register`.

Behind a TLS terminator, set `COOKIE_SECURE=true` and keep `CORS_ORIGINS` to the
public https origin. The API trusts `X-Forwarded-*` (`--proxy-headers`).

## 4. Verification

```bash
./scripts/verify.sh            # alembic round-trip, 105 tests, tsc, next build
./scripts/verify.sh backend
./scripts/verify.sh frontend
python3 scripts/smoke.py       # live flow against a running stack
```

`verify.sh` uses `/tmp/symbiotic_verify.db`, so it never touches your dev data.

### PostgreSQL

The default suite runs on SQLite, which does not validate foreign keys while
parsing DDL. Anything schema-related must therefore also be checked against
PostgreSQL, or a revision that only works on SQLite will look green:

```bash
createdb symbiotic_test
POSTGRES_TEST_URL=postgresql+psycopg2://postgres@/symbiotic_test ./scripts/verify.sh postgres
```

That runs `alembic upgrade head`, `downgrade base`, `upgrade head` and then the
migration and parity suites (16 tests) against the real server. The same steps
run in CI on every push.

### Browser tests

```bash
cd frontend
npx playwright install chromium   # once
npm run e2e                       # starts the API and the app itself
```

Requires a seeded database (`SEED_DEMO_DATA=1`) and the demo accounts.

## 5. Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `403 csrf_failed` on a write | The client must send `X-CSRF-Token` mirroring the `symbiotic_csrf` cookie. Call `GET /api/auth/me` first to obtain it. |
| Screens render empty, no error | Nothing is seeded: check the API log for `demo data ready`, or run `./scripts/seed.sh`. |
| `409 infeasible_plan` on approve | The plan is genuinely infeasible (that is a feature). Open the plan console for the reduced explanation, or lower the demand set. |
| `409` with `details.compensated` | The reservation step faulted; the approval is preserved and capacity was released. Retry from the workflow console. |
| Login fails with correct credentials | Rate limiting: 30 auth requests/minute/IP. Wait a minute. |
| `ModuleNotFoundError: app` | Run alembic/pytest from `backend/`, not the repo root. |
| Next build tries to fetch a font | The design uses system font stacks only; a stray `next/font` import will fail in offline builds. |
