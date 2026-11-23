# Submission — SYMBIOTIC CITY

**Hack the Vibe 2026** · Track: **World Problem Solver**
Advanced challenges: **A02** (resource-constrained optimisation) and **A07**
(fault-tolerant multi-step workflow)

| | |
| --- | --- |
| Repository | https://github.com/meherabmehu/symbiotic-city |
| Default branch | `main` |
| Live application | **None.** No deployment exists — see §S03 |
| Demo video | **None.** Script written, not recorded — see §S01 |
| Licence / data | Portfolio use · 100 % synthetic data |

Every status here uses one of five words, and only these five:

`Verified` — executed and observed · `Partially verified` — some aspects executed
· `Not verified` — stated but not executed · `Blocked` — prevented by the
environment · `Failed` — executed and did not work.

---

## S01 · Demo video

**Status: Not verified.** A recording script and pre-flight checklist exist at
[`docs/DEMO_SCRIPT.md`](DEMO_SCRIPT.md). **No video has been recorded or
uploaded**, and no URL is claimed.

The script is not a storyboard written from memory: every path, label, button and
number in it was walked against a running backend and frontend during this audit.
What is missing is the recording itself, which requires a human presenter.

**To close:** record from `docs/DEMO_SCRIPT.md` (8–10 minutes), upload to YouTube
as public or unlisted-link-accessible, and add the URL here and in `README.md`.

| Scenario | Shot | Length | Evidence it contains |
| --- | --- | --- | --- |
| Premise | Landing page | 45 s | Positioning, four roles |
| Orient | Command deck | 60 s | Live KPIs from the API |
| Digital twin | `/twin` | 90 s | Hover, select, pan, zoom, keyboard |
| Cascade | `/simulation` | 120 s | Deterministic failure propagation |
| Optimise | `/optimization` | 120 s | A02: feasible + proven infeasible |
| Workflow | Plan → dispatch → repair | 150 s | A07: the happy path |
| Fault | Injected failure → retry | 150 s | A07: compensation and preserved approval |
| Boundary | RBAC refusals | 60 s | Server-side authorisation |
| Close | Analytics + audit | 45 s | CSV export, audit trail |

---

## S02 · GitHub repository

**Status: Verified** with the caveats listed below.

| Check | Result |
| --- | --- |
| Public and cloneable | Verified |
| Builds from a clean clone | Verified — CI runs it on every push |
| No live secrets committed | Verified — see the scan below |
| README explains what, why and how to run | Verified |
| Licence / usage statement present | Verified |
| History intact | Verified — no force-push, nothing rewritten |

### The secret scan

A repository aimed at a competition is exactly where a real credential gets
committed by accident, so this was checked rather than assumed:

- No `.env` is tracked. `.env.example` carries placeholders only.
- `docker-compose.yml` requires `SECRET_KEY` (`${SECRET_KEY:?…}`) and therefore
  commits **no working default**.
- The demo passwords in `README.md` and the seeder are synthetic accounts for a
  fictional city. They are public by design and grant access to nothing real.
- The login page's one-click demo buttons are now gated on
  `NEXT_PUBLIC_DEMO_LOGIN`, so a public deployment can suppress them.
- Scanning for live tokens, API keys and private keys returns nothing.

```bash
git grep -nEI "(api[_-]?key|secret|token|password)\s*[:=]\s*['\"][^'\"]{12,}" \
  -- . ':!*.lock' ':!docs/*' ':!*.md'
# → only the synthetic `…#2026` demo passwords
```

### History

The audit was delivered as separate commits, each doing one thing, on a branch
merged through a pull request. No commit was amended, squashed or reordered after
review, and no authorship was altered.

### What a reviewer should read, in order

1. `README.md` — the problem, the architecture, the honest limits
2. [`docs/ARCHITECTURE.md`](ARCHITECTURE.md) — how the layers fit
3. [`docs/MODELS.md`](MODELS.md) — the cascade and optimisation maths
4. [`docs/COMPETITION_MATRIX.md`](COMPETITION_MATRIX.md) — claim → evidence
5. [`docs/FINAL_PRODUCTION_AUDIT.md`](FINAL_PRODUCTION_AUDIT.md) — what was verified and what was not

---

## S03 · Live URL

**Status: Blocked.** There is no public URL, and none is claimed.

**The exact blocker:** this audit environment has no Docker daemon (`docker:
command not found`), no hosting account, and no credentials for any platform.
Outbound network access is limited to package registries and the GitHub API, so a
deployment cannot be created or tested from here. Deploying without testing the
public URL would violate the rule that a deployment is not done until it has been
reached.

**What is ready:**

| Artifact | State | Verified how |
| --- | --- | --- |
| `Dockerfile.backend` | multi-stage, non-root | static review; build paths corrected in this audit |
| `Dockerfile.frontend` | multi-stage, standalone output | static review; proxy target corrected |
| `docker-compose.yml` | db + api + web, healthchecks on all three | YAML parse; **never executed** |
| Start-up order | `db → api → web`, all `service_healthy` | **fixed** — it previously could not start |
| Required secrets | `SECRET_KEY` mandatory, no default | verified by config test |
| Production cookie policy | `Secure` forced, CORS wildcard withdrawn | verified by 7 tests |

**To finish, on a host with Docker:**

```bash
export SECRET_KEY="$(openssl rand -hex 32)"
export POSTGRES_PASSWORD="$(openssl rand -hex 16)"
export NEXT_PUBLIC_DEMO_LOGIN=0        # do not advertise demo accounts publicly
docker compose up --build -d
docker compose ps                     # every service should read "healthy"
curl -fsS localhost:8000/api/health
curl -fsS -o /dev/null -w '%{http_code}\n' localhost:3000/
```

Then re-walk the fifteen judging steps against the public host and replace
"Blocked" with the verified URL. Until that happens this row stays Blocked.

---

## What was actually verified in this audit

| Area | Result |
| --- | --- |
| Backend suite, PostgreSQL 16 | **122 passed, 0 skipped** |
| Backend suite, SQLite | 112 passed, 10 skipped |
| Smoke against a live API | **26/26**, and 26/26 through the Next.js proxy |
| Frontend production build | compiled successfully, 27 routes |
| TypeScript | clean |
| Database | 30 tables, 60 FKs (36 `SET NULL` / 21 `CASCADE` / 3 `RESTRICT`), FK enforcement proven |
| Migrations | round-trip to base and back on SQLite **and** PostgreSQL 16 |
| API surface | 80 paths, 93 operations, OpenAPI at `/api/docs` |
| Routes | 27 pages; every real route answers 200 |
| Browser suite | 47 tests across 4 specs × Chromium and Pixel 7 |
| Security | bcrypt, CSRF, RBAC (4 roles × 26 permissions), rate limiting, audit log |
| Production config | cookie Secure enforced, CORS wildcard withdrawn, weak secret refused |

### Defects found and fixed during this audit

These are worth listing because they are the evidence the audit was real:

1. **The digital twin widened the page.** The canvas seeded a 900 px default width
   and wrote it as an inline size before measuring its container, so `/twin` and
   `/simulation` overflowed by ~548 px on a phone and ~388 px on a desktop.
   Caught by a browser test, not by eye.
2. **`docker compose up` could never have started.** `web` waited on `api` being
   healthy, and `api` declared no healthcheck.
3. **A guessable secret flowed into production.** `SECRET_KEY` had a readable
   default while `ENVIRONMENT` defaulted to `production`.
4. **Session cookies could ship without `Secure`.** `cookie_secure` defaulted to
   false and was not tied to the environment.
5. **A wildcard CORS regex admitted any `*.e2b.app` origin** in every environment.
6. **The initial migration was not portable to PostgreSQL**, and the container
   build paths were wrong.

### Corrections made to the test suite

Six browser tests were wrong, and fixing them was not the same as weakening them.
Each asserted something the interface does not do:

- Required fields render their marker inside the label, so an anchored `/^title$/`
  selector never matched.
- `getByLabel('Password')` also matched the "Show password" toggle.
- The optimisation screen navigates to the persisted plan, so the plan code has to
  be asserted after the URL changes.
- `/admin` is not a route; the guarded screens are `/admin/users`, `/admin/audit`
  and `/admin/settings`.
- Two expected 401s (an anonymous `/auth/me` probe and a deliberately rejected
  login) were being counted as console errors.

No assertion was deleted to make a test pass, and no application behaviour was
changed to accommodate a test.

---

## Reproducing all of it

```bash
# backend
python3 -m venv .venv && .venv/bin/pip install -r backend/requirements.txt
.venv/bin/python -m pytest backend/tests -q            # 112 passed, 10 skipped (SQLite)

# the same suite against PostgreSQL 16 (zero skips)
POSTGRES_TEST_URL=postgresql+psycopg2://postgres@/suite .venv/bin/python -m pytest backend/tests -q

# against a live stack
./scripts/dev.sh &
.venv/bin/python scripts/smoke.py http://127.0.0.1:8000/api

# frontend
cd frontend && npm ci && npx tsc --noEmit && npm run build

# browser tests (installs its own throwaway database and seed)
npx playwright install --with-deps chromium && npm run e2e
```

---

## Honest limits

- The city, its assets, dependency weights and incident history are synthetic.
  Weights are curated estimates, not survey data.
- The cascade model is steady-state. No time-of-day load curves, no repair races
  inside a cascade. A screening tool, not a validated hydraulic or electrical
  solver.
- The workflow engine is transactional with per-step savepoints and recorded
  compensation. It is **not** a durable-execution engine and does not resume after
  a process crash mid-step.
- The solver runs in-process with one worker for reproducibility, not as a
  distributed optimiser.
- There is no live telemetry and nothing pretends to be a SCADA feed.
- Only Chromium is exercised by the browser suite. Firefox and WebKit are not.
- Password reset writes the token to the server console in demo mode; no SMTP.

---

## Judge quick-start

If you have five minutes and want the strongest evidence first:

1. Read `docs/COMPETITION_MATRIX.md` §A02 and §A07.
2. Run `pytest backend/tests -q` — 122 tests against PostgreSQL, no fixtures to
   prepare.
3. Open `docs/DEMO_SCRIPT.md` §6, "Break it on purpose". That segment distinguishes
   this submission: a controlled failure, a compensation ledger, a preserved human
   approval, and a working retry.
