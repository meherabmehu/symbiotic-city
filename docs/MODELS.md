# Models: the maths, the state machines, and what is deliberately simple

Everything on this page is implemented in `backend/app/simulation/`,
`backend/app/optimization/` and `backend/app/workflows/`. The docstrings there are
the source of truth; this page explains the reasoning for a reader who is not
going to open the code.

---

## 1. Cascading failure

### Graph

`G = (V, E)`, one node per infrastructure asset (23 seeded, 5 zones), one directed
edge `u → v` when *v requires u to operate* (25 seeded). Each edge carries

* `impact_weight ∈ [0,1]` — share of v's capacity lost when u is entirely down;
* `redundancy ∈ [0,1]` — share of that loss v absorbs from its own fallbacks.

### Propagation

Failures are propagated breadth-first from an initial set. For a candidate node v
with currently failed suppliers `F(v)`:

```
deficit(v) = 1 − ∏_{u ∈ F(v)} (1 − max(0, impact_weight(u→v) · (1 − redundancy(u→v))))
```

**Why a product and not a sum.** With a sum, two 30 %-bad feeds make 60 % — which
would condemn a hospital that in reality rides through either feed alone. The
complementary-product form is sub-additive, so redundancy actually behaves like
redundancy. Two independent 30 % deficits give `1 − 0.7·0.7 = 51 %`, and a node
with 50 % redundancy on a single feed gives `1 − (1 − 0.5) = 50 %`.

Classification, per hop:

| Condition | Level |
| --- | --- |
| `deficit ≥ threshold` | `failed` — out of service |
| `deficit ≥ 0.6 · threshold` | `degraded` — running at reduced capacity |
| otherwise | unaffected (not recorded) |

Default `threshold = 0.35`; propagation stops at `max_depth` (default 6) or when the
frontier is empty. Cycles are detected and broken for traversal, and reported in
the payload as a data-quality error rather than silently "fixed".

### Initial damage by mode

| Mode | Initial capacity lost on the seed asset(s) |
| --- | --- |
| `total_failure` | 100 % |
| `capacity_loss` | `min(threshold, 0.75)` |
| `maintenance` | `0.4` |

### Impact

`affected_population` sums the population of the zone each failed/degraded asset
serves, de-duplicated so one zone is not counted twice. The seeded reference run
(fail `A01` = Meridian East substation, `threshold 0.35`, `depth 6`, seed `42`)
fails 12 assets, degrades several more, affects **18,400 people**, and reaches
**depth 2**.

### Determinism

No sampling in the core. The optional `apply_load_sensitivity(noise=…)` term is
disabled by default. `random_seed` is stored on the run and mixed into the snapshot
hash so identical inputs are byte-identical outputs — which is what makes a
screenshot in a report verifiable.

### Known simplifications

Steady state only: no time-of-day load curve, no repair racing the cascade, no
probabilistic edge failure. Weights are curated for the fictional city, not
surveyed. It is a screening tool for "what is coupled to what", not a flow solver.

---

## 2. Resource-constrained recovery planning

### Inputs

* **Demands** — affected assets needing capacity. `need_d`, priority 1–5,
  protected population, service window, eligible resource categories.
* **Resources** — generators, tankers, crews. `available_r` capacity,
  `hourly_cost_r`, `mobilisation_minutes_r`, served categories.

`need_d` is derived from the simulation as
`clamp(kVA(category) · capacity_loss_percent, 8, 60)`, so a hospital gets a
meaningful quantity while a bus shelter does not monopolise a generator.

### Decision variables

`x[d][r] ∈ ℤ≥0` — quantity of resource r assigned to demand d (scaled ×100 to stay
integral), and `served[d] ∈ {0,1}`.

### Constraints

1. **Availability** — `Σ_d x[d][r] ≤ available_r`.
2. **Eligibility** — `x[d][r] = 0` when the category is not served or
   `mobilisation_minutes_r > service_window_minutes_d`.
3. **Horizon** — `Σ (mobilisation + estimated) ≤ horizon_hours` (default 12 h).
4. **All-or-nothing coverage** — `Σ_r x[d][r] ≥ need_d · served[d]`.
5. **Priority floor** (optional) — all priority-1 demands must be served
   (`must_serve_priority = 1` by default). This is what makes the infeasible
   variant honestly infeasible instead of quietly degrading a hospital.
6. **Fan-out** — at most 3 resources per demand, so a plan is dispatchable by
   humans.

### Objective

```
maximise  Σ_d value_d · served[d]  −  Σ_{d,r} cost_{d,r} · x[d][r]
value_d = priority_weight(priority) · 100 + population_d / 100
cost_{d,r} = hourly_cost_r · estimated_hours_d / 100
priority_weight = {1: 60, 2: 30, 3: 12, 4: 5, 5: 2}
```

Exponential weights mean one hospital outranks any number of low-priority
demands the solver could otherwise bundle; cost only breaks ties among equals —
matching real dispatch practice ("most critical, cheapest way").

### Infeasibility is a result, not an exception

When the model is infeasible the planner relaxes the priority floor and reports
*which* demands cannot be covered and *which* constraint blocks them, e.g.
`Total demand (400) exceeds total resource capacity (335).` The UI renders that
sentence verbatim. A planner that only ever says "optimal" is not a planner.

### Determinism and speed

`solver.parameters.num_search_workers = 1`, `random_seed = 7`, 5 s limit. For the
seeded 9 × 12 instance the solve is a few tens of milliseconds; single-worker is
chosen for reproducibility, not necessity, and is the first knob to turn for a
larger instance.

---

## 3. Recovery workflow

### Steps

| # | Step | Actor | Effect |
| --- | --- | --- | --- |
| 1 | `incident_created` | system | Validates the incident exists and is open. |
| 2 | `incident_validated` | system | Severity and asset scope check. |
| 3 | `simulation_performed` | system | Runs (or reuses) a cascade simulation. |
| 4 | `recovery_plan_generated` | system | Builds demands + calls the planner. |
| 5 | `plan_approved` | human | Parks the workflow at `awaiting_approval`. |
| 6 | `resources_reserved` | system | Reserves capacity; faults here are compensable. |
| 7 | `repair_tasks_assigned` | system | Creates and assigns repair tasks. |
| 8 | `engineer_accepted` | field | First task accepted by an engineer. |
| 9 | `repair_verified` | operator | Last open task verified/completed. |
| 10 | `incident_resolved` | system | Incident → `resolved`, workflow → `completed`. |

Steps 1–4 run inside `POST /workflows/start`; the workflow then waits for a human.
That pause is deliberate: automation prepares, a person decides.

### Failure and compensation

```
        ┌──────── step starts ────────┐
        │  SAVEPOINT                  │
        │  handler writes reservations│
        │  handler raises / fault     │
        │  ROLLBACK TO SAVEPOINT      │  ← only this step's writes vanish
        └─────────────┬───────────────┘
                      ▼
      record failed step + reason        (outside the savepoint, so it persists)
                      ▼
      compensate: release reservations,  cancel undispatched tasks
                      ▼
      record `compensation` event        (what was released, or "savepoint did")
                      ▼
      workflow.status = failed, awaiting a retry
```

Because the approval transaction and the workflow step are separate units of work,
a failed reservation step can no longer erase the operator's approval. The API
returns `409` with `{workflow_id, failure_step, compensated:true}` and the console
says exactly that in plain language.

`retry_workflow` increments `retry_count`, resumes from
`resume_from_current_position()` and appends a `retry` event. `workflow_events` is
unique on `(workflow_id, step, attempt)`, so history across attempts is readable
and duplicate execution cannot produce duplicate rows.

**Limit stated plainly:** this is transactional durability, not durable execution.
If the process dies mid-step the step's uncommitted writes are gone and the
workflow stays at its last commit; retry is the recovery path. There is no broker
and no distributed lock — appropriate for a single-node demo, and named here so
nobody mistakes it for Temporal.

### Incident state machine

```
reported ──► verified ──► planning ──► approved ──► in_progress ──► resolved
   │            │            │  ▲          │            │              │
   └──► cancelled ◄──────────┘  └── approved ┘          └──► approved  └──► verified
```

Enforced by `app/services/incidents.py`; illegal moves are `409 invalid_transition`
with the legal set in `details`. Resolving with open tasks is `409 open_tasks` and
lists the blocking task codes.

### Task state machine

```
pending ──► assigned ──► accepted ──► in_progress ──► completed ──► verified
   ▲           │            │              │              │
   │           ▼            ▼              ▼              ▼
   └── rejected          cancelled      cancelled   in_progress (reopen)
```
