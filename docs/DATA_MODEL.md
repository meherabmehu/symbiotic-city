# Data model

30 tables, six model modules in `backend/app/models/`, plus Alembic revision
`20261122_5260d3802c9d_initial_schema`.

Conventions across the schema:

* Integer surrogate `id` primary keys; human-facing `code` columns
  (`INC-0001`, `PLAN-0003`, `TASK-0042`, `WF-0001`) with unique constraints.
* All timestamps are timezone-aware UTC via a custom `UTCDateTime` type (SQLite
  stores naive UTC, Postgres `timestamptz`; the type normalises on read).
* `*_json` columns hold `Text` with JSON encoding, read through Pydantic
  schemas — no ORM-side magic, so the payload shape is explicit in the API.
* Foreign keys use `ondelete="SET NULL"` for attribution links (who approved,
  which run) and `CASCADE` for owned children (events, history, results).
* Soft deletion only where history must survive: `infrastructure_assets.is_archived`,
  `resources.is_archived`, `users.is_active`.

## identity

| Table | Columns of note | Purpose |
| --- | --- | --- |
| `users` | email, full_name, password_hash (bcrypt), is_active, last_login_at | Accounts. Passwords are never logged. |
| `roles` | key, name, is_system | 4 seeded roles. |
| `permissions` | key, description | 26 `resource:action` permissions. |
| `role_permissions` | role_id, permission_id | M:N, seeded from `core/permissions.py`. |
| `user_roles` | user_id, role_id, granted_at | M:N; a user may hold several roles. |
| `sessions` | session_id (uuid in JWT `sid`), expires_at, revoked_at, ip, user_agent | Server-side revocation. |
| `password_reset_tokens` | token_hash, expires_at, used_at | Hashed, single-use, 30 min TTL. |
| `system_settings` | key, value, value_type, section | Editable from admin, audited. |

## infrastructure

| Table | Columns of note |
| --- | --- |
| `city_zones` | code, population, center_x/y (normalised 0–100 twin coords) |
| `infrastructure_assets` | code, category, zone_id, status, criticality 1–5, capacity + unit, load_percent, map_x/y, built_year, last_inspection_at |
| `infrastructure_dependencies` | source_asset_id, target_asset_id, dependency_type, impact_weight, redundancy |
| `infrastructure_status_history` | previous_status → new_status, reason, changed_by_id |

`infrastructure_dependencies` is the edge table the simulation traverses: an edge
`source → target` means *target requires source*. `impact_weight` and `redundancy`
are the two numbers in the cascade formula.

## operations

| Table | Columns of note |
| --- | --- |
| `incidents` | code, category, severity, status, primary_asset_id, affected_population, links to simulation_run / optimization_plan / workflow, resolved_at, resolution_notes |
| `incident_assets` | incident_id, asset_id, impact_level, impact_score |
| `incident_events` | event_type, from_status → to_status, message, actor_id |
| `repair_tasks` | code, status, priority, incident_id, asset_id, assignee_id, estimated/actual hours, due_at, accepted_at, started_at, completed_at, verified_at |
| `task_status_history` | from_status → to_status, note, actor_id |
| `resources` | code, category, capacity + unit, status, home_zone_id, hourly_cost, mobilisation_minutes |

## simulation

| Table | Columns of note |
| --- | --- |
| `simulation_scenarios` | Reusable parameter sets (mode, initial failures, threshold, depth, seed). |
| `simulation_runs` | code, status, parameters, `snapshot_json` (graph at run time), `summary_json`, duration_ms, triggered_by_id |
| `simulation_results` | one row per affected asset: impact_level, depth, impact_score, capacity_loss_percent, cause_asset_id, human-readable explanation |

The snapshot is what makes a run defensible: an incident months old can be
re-explained because the graph as it was is preserved, not re-derived.

## optimization

| Table | Columns of note |
| --- | --- |
| `optimization_requests` | code, objective, incident_id, simulation_run_id, status, `demand_json`, `constraint_json`, requested_by_id |
| `optimization_plans` | code, request_id, status (proposed/approved/rejected/infeasible), solution_status, objective_value, covered/total demand, coverage_percent, solver_wall_ms, `explanation_json`, infeasibility_reason, approved_by_id/at, rejection_reason |
| `optimization_assignments` | plan_id, asset_id, resource_id, quantity, priority_weight, contribution, served, rationale, repair_task_id |
| `resource_reservations` | resource_id, repair_task_id, plan_id, workflow_id, quantity, status (active/consumed/released), released_at, release_reason |

A reservation carries both `plan_id` and `workflow_id`: compensation can release
"everything this workflow reserved" without guessing, which is precisely what the
failure path does.

## workflow

| Table | Columns of note |
| --- | --- |
| `workflow_instances` | code, workflow_type, status (running/awaiting_approval/awaiting_field/completed/failed), current_step, `completed_steps_json`, incident/simulation/plan links, failure_step, failure_reason, retry_count |
| `workflow_events` | step, attempt, outcome, message, `data_json`, actor_id — **unique on (workflow_id, step, attempt)** |

The uniqueness constraint is the idempotency guard for step execution: a retried
step appends attempt 2 instead of duplicating attempt 1, and two concurrent
executions cannot both write attempt 1.

## system

| Table | Purpose |
| --- | --- |
| `notifications` | Per-user, typed (incident/task/plan/system), severity, deep link, read state. |
| `audit_logs` | actor id/email/role, action, resource type/id, outcome, message, metadata, ip, user agent. Append-only in practice. |
| `idempotency_keys` | key + scope + cached response, per user, so a retried mutation returns the original result. |

## Entity relationships (condensed)

```
users ─┬─< user_roles >─ roles ─< role_permissions >─ permissions
       ├─< sessions
       └─< notifications

city_zones ─< infrastructure_assets ─┬─< infrastructure_status_history
                                     ├─< infrastructure_dependencies (source/target)
                                     └─< incident_assets >─ incidents
                                                            │
resources ─< resource_reservations >────────────────────────┤
                                                            ▼
simulation_scenarios ─< simulation_runs ─< simulation_results
                              │
                              ▼
                    optimization_requests ─< optimization_plans ─< optimization_assignments
                                                     │
                                                     ▼
                            workflow_instances ─< workflow_events
                                     │
                                     ▼
                              repair_tasks ─< task_status_history
```
