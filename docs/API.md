# API reference

Base URL: `http://127.0.0.1:8000/api` · Interactive docs: `/api/docs` · OpenAPI: `/api/openapi.json`
93 operations across ten routers.

## Conventions

**Success**

```json
{ "success": true, "data": { }, "meta": {} }
```

Collections use `meta = {total, page, page_size, pages, has_next, has_prev}` and
accept `?page=1&page_size=20`.

**Error**

```json
{ "success": false, "error": { "code": "infeasible_plan", "message": "…", "details": {} } }
```

Clients branch on `error.code`. Codes in use include:
`unauthenticated`, `forbidden`, `rate_limited`, `csrf_failed`, `validation_error`,
`not_found`, `invalid_transition`, `insufficient_capacity`, `conflict`,
`infeasible_plan`, `open_tasks`, `workflow_not_running`, `injected_failure`,
`reservation_failed`, `no_engineer_available`, `step_failed`, `unexpected_error`.

**Auth.** Cookie-based. `GET /auth/me` establishes the CSRF cookie; writes must
mirror it in `X-CSRF-Token`. A bearer token is also accepted for scripts.

**Pagination & filters.** List endpoints accept `page`, `page_size`, plus
resource-specific filters (`status`, `category`, `severity`, `incident_id`,
`assignee_id`, `q`, `date_from`, `date_to`).

## auth

| Method | Path | Permission | Notes |
| --- | --- | --- | --- |
| POST | `/auth/register` | – | Creates a `field_engineer` by default. |
| POST | `/auth/login` | – | Rate limited; sets session + CSRF cookies. |
| POST | `/auth/logout` | session | Revokes the session row. |
| GET | `/auth/me` | optional | User, roles, permissions, CSRF cookie bootstrap. |
| POST | `/auth/forgot-password` | – | Always 200 (no account enumeration); token printed in demo mode. |
| POST | `/auth/reset-password` | – | Single-use token, TTL 30 min. |
| PATCH | `/auth/profile` | session | Name, phone, job title. |
| POST | `/auth/change-password` | session | Revokes other sessions. |
| GET | `/auth/sessions` | session | Active devices with last-seen. |
| POST | `/auth/sessions/revoke-all` | session | Keeps the current one. |
| GET | `/auth/roles` | – | Public role catalogue for the demo-login UI. |

## infrastructure

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/infrastructure/categories` · `/infrastructure/statuses` · `/zones` | `infrastructure:read` |
| POST | `/zones` | `infrastructure:write` |
| GET | `/infrastructure` (paged, filtered) | `infrastructure:read` |
| POST | `/infrastructure` | `infrastructure:write` |
| GET / PATCH / DELETE | `/infrastructure/{asset_id}` | `read` / `write` / `delete` |
| POST | `/infrastructure/{asset_id}/status` | `infrastructure:write` |
| GET | `/dependencies` · POST `/dependencies` · DELETE `/dependencies/{id}` | `read` / `write` / `write` |
| GET | `/twin/graph` | `twin:read` |

## simulation

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/simulations/assumptions` | `simulation:read` |
| GET / POST | `/scenarios` | `simulation:read` / `simulation:run` |
| GET | `/simulations` · `/simulations/{run_id}` · `/simulations/{run_id}/demands` | `simulation:read` |
| POST | `/simulations/run` | `simulation:run` |
| GET | `/simulations/compare/selected?ids=1,2` | `simulation:read` |

`POST /simulations/run`

```json
{ "failure_mode": "total_failure", "initial_failure_ids": [1],
  "cascade_threshold": 0.35, "max_depth": 6, "random_seed": 42, "scenario_id": null }
```

→ `201` with failed/degraded assets per depth, affected population, max depth,
snapshot hash and the resulting demands.

## optimization

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/optimization/requests` · `/optimization/plans` · `/optimization/plans/{id}` | `optimization:read` |
| POST | `/optimization/preview` | `optimization:read` |
| POST | `/optimization/requests` | `optimization:run` |
| POST | `/optimization/plans/{id}/approve` | `optimization:approve` |
| GET | `/optimization/engine-info` | `optimization:read` |

`POST /optimization/requests` runs the solver and persists a plan:

```json
{ "simulation_run_id": 1, "demands": [{ "asset_id": 4, "need": 45, "priority": 1 }],
  "force_infeasible_demo": false, "title": "Night shift recovery" }
```

`201` feasible · `200` infeasible with `status:"infeasible"` and a reduced
explanation · `409 infeasible_plan` when an approval is attempted on one.

`POST /optimization/plans/{id}/approve`

```json
{ "approve": true, "note": "Approved on the night call." }
```

* `200` — plan approved; if a workflow was parked at `awaiting_approval`,
  `resources_reserved` and `repair_tasks_assigned` have run and tasks exist.
* `409` `{"code":"infeasible_plan"}` — refused before any reservation.
* `409` `{"code":"reservation_failed","details":{"workflow_id":7,"failure_step":"resources_reserved","compensated":true}}`
  — the approval **is** persisted, the step was rolled back, compensation released
  capacity. Inspect `/workflows/7` and retry.

## incidents

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/incidents` · `/incidents/summary` · `/incidents/{id}` | `incident:read` |
| POST | `/incidents` | `incident:write` |
| PATCH | `/incidents/{id}` | `incident:write` |
| POST | `/incidents/{id}/transition` | `incident:resolve` for verify/resolve, else `incident:write` |
| POST | `/incidents/{id}/reopen` | `incident:resolve` |

Transition body: `{"status": "verified", "note": "…", "resolution_notes": "…"}`.
Legal moves are enforced (`reported → verified|cancelled`, `verified →
planning|cancelled`, `planning → approved|verified|cancelled`, `approved →
in_progress|planning|cancelled`, `in_progress → resolved|approved`, `resolved →
verified`). Resolving while repair tasks are open returns `409 open_tasks` with
the blocking ids.

## tasks

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/tasks` · `/tasks/{id}` | `task:read` |
| GET | `/tasks/engineers` | `task:write` |
| GET | `/tasks/my-queue` | `task:execute` |
| POST | `/tasks` · `/tasks/{id}/assign` | `task:write` |
| POST | `/tasks/{id}/transition` | `task:execute` (own tasks) / `task:verify` (verify) |

`my-queue` returns `{tasks, summary:{counts:{pending_acceptance,in_progress,completed,verified}, total}}`.

Transition body: `{"status":"accepted","note":"…","actual_hours":2,"parts_used":"…"}`.
`pending → assigned|cancelled`, `assigned → accepted|rejected|cancelled`,
`rejected → pending|cancelled`, `accepted → in_progress|cancelled`,
`in_progress → completed|cancelled`, `completed → verified|in_progress`.
Verifying the last open task for an incident resolves it and advances the workflow.

## resources

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/resources/categories` · `/resources` · `/resources/utilisation` · `/resources/{id}` · `/resources/reservations` | `resource:read` |
| PATCH | `/resources/{id}` | `resource:write` |
| POST | `/resources/{id}/reserve` | `resource:write` |
| POST | `/resources/reservations/{id}/release` | `resource:write` |

## workflows

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/workflows/steps` · `/workflows` · `/workflows/{id}` | `workflow:read` |
| POST | `/workflows/start?incident_id=&fail_at_step=` | `workflow:manage` |
| POST | `/workflows/{id}/retry` | `workflow:manage` |
| POST | `/workflows/{id}/simulate-failure?step=` | `workflow:manage` |
| POST | `/workflows/{id}/advance` | `workflow:manage` |

`start` runs the four automatic steps and parks at `awaiting_approval`
(`status:"awaiting_approval"`, `current_step:"plan_approved"`). `simulate-failure`
arms the next execution of a step to raise `injected_failure`. `retry` resumes
from the current position and records a `retry` event.

## analytics & notifications

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/dashboard` | `analytics:read` |
| GET | `/analytics/{overview,categories,incidents,resources,simulations,recovery}` | `analytics:read` |
| GET | `/analytics/export?dataset=…&format=csv` | `analytics:export` |
| GET | `/notifications` · POST `/notifications/{id}/read` · `/notifications/read-all` | session |
| GET | `/audit-logs` · `/audit-logs/actions` | `audit:read` |

`/dashboard` returns one bundle (`overview`, `category_breakdown`, `scope`,
`generated_at`, `incident_trends`, `severity_breakdown`, `resource_utilisation`,
`simulation_comparison`, `failure_impact`, `recovery_performance`,
`active_incident_list`, `latest_simulation`, `pending_plan_approvals`,
`task_board`, `resource_spotlight`, `my_open_tasks`, `unread_notifications`) so
the command deck renders in a single round trip.

## admin

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/users` | `user:read` |
| POST | `/users` · PATCH `/users/{id}` · POST `/users/{id}/reset-password` | `user:manage` |
| GET | `/roles` · `/permissions` | `user:read` |
| GET | `/settings` · PATCH `/settings/{key}` | `settings:manage` |
| GET | `/system/health` · `/system/demo-info` | `settings:manage` |

## system

`GET /api/health` → `{"success":true,"data":{"status":"ok","service":"symbiotic-city-api"}}`
(unauthenticated; used by container healthchecks).

## Permissions matrix

| Permission | Admin | Operator | Engineer | Analyst |
| --- | :-: | :-: | :-: | :-: |
| `infrastructure:read` | ✓ | ✓ | ✓ | ✓ |
| `infrastructure:write` / `delete` | ✓ / ✓ | ✓ / – | – | – |
| `twin:read` | ✓ | ✓ | ✓ | ✓ |
| `simulation:read` / `run` | ✓ / ✓ | ✓ / ✓ | – | ✓ / ✓ |
| `optimization:read` / `run` / `approve` | ✓ / ✓ / ✓ | ✓ / – / ✓ | – | ✓ / ✓ / – |
| `incident:read` / `write` / `resolve` | ✓ / ✓ / ✓ | ✓ / ✓ / ✓ | ✓ / – / – | ✓ / – / – |
| `task:read` / `write` / `execute` / `verify` | ✓ / ✓ / ✓ / ✓ | ✓ / ✓ / – / ✓ | ✓ / – / ✓ / – | – |
| `resource:read` / `write` | ✓ / ✓ | ✓ / – | ✓ / – | – |
| `analytics:read` / `export` | ✓ / ✓ | ✓ / – | – | ✓ / ✓ |
| `workflow:read` / `manage` | ✓ / ✓ | ✓ / ✓ | – | ✓ / – |
| `user:read` / `manage` / `settings:manage` / `audit:read` | ✓ | – | – | – |

The API is the authority; the console hides what the caller cannot use but never
relies on that for enforcement.
