# Ten-minute demo script

Everything below uses seeded data and demo logins. Nothing is mocked: the numbers
come back from the API. Open two browser profiles (or one normal + one private
window) so you can hold two roles at once.

Passwords: `Admin#2026` / `Operator#2026` / `Engineer#2026` / `Analyst#2026`.

## 0 · Sign in and orient (1 min)

1. Open <http://127.0.0.1:3000>. The landing page states the premise in one
   sentence and lists the four roles. Try **"Sign in as operator"**.
2. The command deck loads from a single bundle request: active incidents,
   pending plan approvals, today's task board, resource spotlight, unread
   notifications.
3. Point at the header's environment pill: the twin is *synthetic*, and the app
   says so rather than implying a live city.

## 1 · Rehearse a cascade (2 min) — analyst

1. As `analyst@symbiotic.city`, go to **Failure lab**.
2. Choose asset `A01` (the Meridian East substation), mode **Total failure**,
   cascade threshold **0.35**, depth **6**, seed **42**. Run it.
3. The result: ~12 assets fail, ~18,400 people affected, maximum depth 2.
   Open the run and walk the depth bands — the cascade is deterministic, so the
   same inputs always give this result.
4. Open the **City twin** and show the same network interactively: hover an asset
   for dependency counts, click to focus, arrow keys to walk the graph.

**Talking point:** the propagation rule is
`deficit = 1 − ∏(1 − impact_weight·(1 − redundancy))`. Two partially failing feeds
do not add linearly, which is why a redundant hospital survives one bad feed.

## 2 · Optimise the recovery (2 min) — analyst

1. From the run, **Build demands**. Nine assets need capacity (8 of 9 fit inside
   the 335 kVA inventory).
2. **Preview** — feasible, with a per-resource summary.
3. **Submit** as analyst. A plan appears with assignments, unserved demands and
   the binding constraints.
4. Run the *infeasible* variant (`force_infeasible_demo`): the planner refuses
   and explains — *"Total demand (400) exceeds total resource capacity (335)."*

**Talking point:** coverage is all-or-nothing (`served[d]` boolean gates
`sum_r x[d][r] ≥ need_d`), so the solver never reports a hospital as "mostly
served". Priority weights are exponential — one hospital outranks five shops.

## 3 · Approve, dispatch, repair (3 min) — operator + engineers

1. As **operator**, open **Recovery planner → the plan**, then **Approve**.
2. The approval reserves capacity and the recovery workflow dispatches tasks.
   If no workflow exists for the incident, the plan waits — start the workflow
   first (see step 4) or use **Start recovery** on the incident.
3. Switch to `engineer@symbiotic.city` → **My field work**: accept, start,
   complete the assigned tasks with a repair note.
4. Back as operator → **Dispatch board**: verify the completed tasks.
   Verifying the last open task records `repair_verified`, resolves the incident,
   and the workflow reaches `incident_resolved`.

## 4 · Break the automation on purpose (2 min) — the honest part

1. As **operator**, create an incident with a critical asset.
2. **Start recovery** — the workflow runs `incident_created → validated →
   simulation → plan generated` and stops at `awaiting_approval`.
3. Inject a fault: `POST /api/workflows/{id}/simulate-failure?step=resources_reserved`
   (or the **Inject fault** control on the workflow console).
4. Approve the plan. Expected: an alert saying the approval was recorded but the
   reservation step failed and was compensated; the response is `409` with
   `details = {workflow_id, failure_step, compensated: true}`.
5. Open the workflow: the failed step is recorded, the compensation event lists
   what was released, and the plan remains **approved** — the operator's decision
   is never silently erased.
6. **Retry**. The workflow resumes from its current position, reserves capacity,
   dispatches tasks, and the field cycle from step 3 finishes it.

**Talking point:** each step runs inside a savepoint, so a mid-step failure
discards only its own partial writes. Failure records and compensation are written
outside that savepoint, which is why they survive. This is the difference between
"we handle errors" and "here is the ledger of what we rolled back".

## 5 · Prove the boundary (1 min) — RBAC

With the analyst session open:

* `/admin/users` → the API answers `403`; the nav item is hidden.
* `POST /api/incidents` → `403`: analysts do not create incidents.
* `POST /api/optimization/requests` as **operator** → `403`: operators approve,
  analysts submit. Both are intentional, both are covered by tests.

## 6 · Close the loop (1 min)

**Analytics** → recovery performance and resource utilisation, then **Export CSV**.
**Admin → Audit log** (admin) → every action above, with actor, target and timestamp.

## If something looks wrong

| Symptom | Check |
| --- | --- |
| Console renders zeros | Is the API up on :8000, and did the seed log once? |
| No tasks after approval | Was the workflow started for that incident? The workflow is what dispatches. |
| Approve returns `409` without compensation | The plan was genuinely infeasible — read the explanation panel. |
| Fault does not fire | Faults are scheduled via `simulate-failure` before approval; `fail_at_step` on `/workflows/start` covers only the automatic steps. |
