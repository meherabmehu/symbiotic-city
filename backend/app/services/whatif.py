"""What-if scenarios: run several futures, keep them, and explain the differences.

The simulation lab already runs one failure and reports it. This keeps a set of
them as named hypotheses so they can be compared later, and -- the part that makes
comparison useful rather than decorative -- it states *why* two futures differ.

Difference explanation is deliberately mechanical. Given two runs it reports:

* what only the first took down, and what only the second took down;
* what both took down (the agreed core, which is the part no intervention helps);
* which single change to the inputs explains the divergence, quoting the actual
  thresholds and the actual depth at which the shared failures occurred.

It does not attribute cause it cannot see. If the two runs differ in several
inputs at once, it says so and lists them rather than picking a favourite.

Every observation stores the metrics it recorded, so a comparison made today is
comparable with one made in six months even if the engine changes. The stored
reading is what the difference is computed from.
"""

from __future__ import annotations

import json

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.responses import ApiError
from app.core.types import utcnow
from app.models.infrastructure import InfrastructureAsset
from app.models.simulation import (
    SimulationResult,
    SimulationRun,
    WhatIfObservation,
    WhatIfScenario,
)
from app.schemas.simulation import SimulationRunRequest
from app.services import simulation as simulation_service

MAX_SCENARIOS = 40

METRIC_KEYS = (
    "assets_failed",
    "assets_impacted",
    "affected_population",
    "max_depth_reached",
    "severity_index",
)


def next_scenario_code(db: Session) -> str:
    count = db.scalar(select(func.count()).select_from(WhatIfScenario)) or 0
    return f"WI-{count + 1:04d}"


def scenario_dict(db: Session, scenario: WhatIfScenario, *, include_observations: bool = True) -> dict:
    payload = {
        "id": scenario.id,
        "code": scenario.code,
        "name": scenario.name,
        "description": scenario.description,
        "initial_failure_ids": json.loads(scenario.initial_failure_ids_json or "[]"),
        "failure_mode": scenario.failure_mode,
        "cascade_threshold": scenario.cascade_threshold,
        "max_depth": scenario.max_depth,
        "random_seed": scenario.random_seed,
        "is_baseline": scenario.is_baseline,
        "created_at": scenario.created_at,
        "updated_at": scenario.updated_at,
    }
    if include_observations:
        observations = db.scalars(
            select(WhatIfObservation)
            .where(WhatIfObservation.scenario_id == scenario.id)
            .order_by(WhatIfObservation.created_at.desc())
        ).all()
        payload["observations"] = [
            {
                "id": o.id,
                "run_id": o.run_id,
                "headline": o.headline,
                "note": o.note,
                "metrics": json.loads(o.metrics_json or "{}"),
                "created_at": o.created_at,
            }
            for o in observations
        ]
    return payload


def list_scenarios(db: Session) -> list[WhatIfScenario]:
    return list(
        db.scalars(
            select(WhatIfScenario).order_by(
                WhatIfScenario.is_baseline.desc(), WhatIfScenario.created_at.asc()
            )
        ).all()
    )


def create_scenario(
    db: Session,
    *,
    name: str,
    description: str,
    initial_failure_ids: list[int],
    failure_mode: str,
    cascade_threshold: float,
    max_depth: int,
    random_seed: int,
    is_baseline: bool,
    actor_id: int | None,
) -> WhatIfScenario:
    total = db.scalar(select(func.count()).select_from(WhatIfScenario)) or 0
    if total >= MAX_SCENARIOS:
        raise ApiError(
            f"At most {MAX_SCENARIOS} what-if scenarios can be kept. Delete one first.",
            status_code=409,
            code="too_many_scenarios",
        )
    if not initial_failure_ids:
        raise ApiError(
            "Choose at least one asset to fail in this scenario.",
            status_code=422,
            code="no_failure_selected",
        )
    active = {a.id for a in db.scalars(select(InfrastructureAsset)).all() if not a.is_archived}
    missing = [i for i in initial_failure_ids if i not in active]
    if missing:
        raise ApiError(
            "Some selected assets are not available.",
            status_code=422,
            code="invalid_asset",
            details={"asset_ids": missing},
        )
    if is_baseline:
        # Exactly one baseline: it is the reference the others are read against.
        for other in db.scalars(
            select(WhatIfScenario).where(WhatIfScenario.is_baseline.is_(True))
        ).all():
            other.is_baseline = False

    scenario = WhatIfScenario(
        code=next_scenario_code(db),
        name=name[:200],
        description=description,
        initial_failure_ids_json=json.dumps(list(dict.fromkeys(initial_failure_ids))),
        failure_mode=failure_mode,
        cascade_threshold=cascade_threshold,
        max_depth=max_depth,
        random_seed=random_seed,
        is_baseline=is_baseline,
        created_by_id=actor_id,
    )
    db.add(scenario)
    db.flush()
    return scenario


def observe(
    db: Session,
    scenario: WhatIfScenario,
    *,
    note: str,
    actor_id: int | None,
) -> WhatIfObservation:
    """Execute the scenario as a real run and record the reading taken from it."""
    request = SimulationRunRequest(
        name=f"{scenario.code} · {scenario.name}"[:200],
        initial_failure_ids=json.loads(scenario.initial_failure_ids_json or "[]"),
        failure_mode=scenario.failure_mode,  # type: ignore[arg-type]
        cascade_threshold=scenario.cascade_threshold,
        max_depth=scenario.max_depth,
        random_seed=scenario.random_seed,
    )
    run = simulation_service.execute_run(db, request, actor_id=actor_id)
    summary = json.loads(run.summary_json or "{}")

    metrics = {key: summary.get(key, 0) for key in METRIC_KEYS}
    failed_codes = _failed_codes(db, run.id)
    metrics["failed_codes"] = failed_codes
    metrics["critical_services_down"] = summary.get("critical_services_down", [])
    metrics["snapshot_hash"] = json.loads(run.snapshot_json or "{}").get("snapshot_hash")

    observation = WhatIfObservation(
        scenario_id=scenario.id,
        run_id=run.id,
        headline=(
            f"{metrics['assets_failed']} assets failed, "
            f"{metrics['affected_population']:,} people affected, "
            f"depth {metrics['max_depth_reached']}"
        ),
        note=note,
        metrics_json=json.dumps(metrics),
        created_by_id=actor_id,
    )
    db.add(observation)
    scenario.updated_at = utcnow()
    db.flush()
    return observation


def _failed_codes(db: Session, run_id: int) -> list[str]:
    codes = db.scalars(
        select(InfrastructureAsset.code)
        .join(SimulationResult, SimulationResult.asset_id == InfrastructureAsset.id)
        .where(SimulationResult.run_id == run_id, SimulationResult.impact_level == "failed")
        .order_by(InfrastructureAsset.code)
    ).all()
    return list(codes)


def _latest_observation(db: Session, scenario_id: int) -> WhatIfObservation | None:
    return db.scalars(
        select(WhatIfObservation)
        .where(WhatIfObservation.scenario_id == scenario_id)
        .order_by(WhatIfObservation.created_at.desc())
    ).first()


def _diff_inputs(a: WhatIfScenario, b: WhatIfScenario) -> list[dict]:
    """Which inputs differ, in terms a person would use."""
    changes: list[dict] = []
    if sorted(json.loads(a.initial_failure_ids_json or "[]")) != sorted(
        json.loads(b.initial_failure_ids_json or "[]")
    ):
        changes.append(
            {
                "field": "initial_failure_ids",
                "left": json.loads(a.initial_failure_ids_json or "[]"),
                "right": json.loads(b.initial_failure_ids_json or "[]"),
                "description": "different starting failures",
            }
        )
    if abs(a.cascade_threshold - b.cascade_threshold) > 1e-9:
        changes.append(
            {
                "field": "cascade_threshold",
                "left": a.cascade_threshold,
                "right": b.cascade_threshold,
                "description": (
                    f"cascade threshold {a.cascade_threshold:.2f} vs {b.cascade_threshold:.2f} "
                    "-- a lower threshold lets smaller deficits fail an asset"
                ),
            }
        )
    if a.max_depth != b.max_depth:
        changes.append(
            {
                "field": "max_depth",
                "left": a.max_depth,
                "right": b.max_depth,
                "description": f"propagation depth {a.max_depth} vs {b.max_depth}",
            }
        )
    if a.failure_mode != b.failure_mode:
        changes.append(
            {
                "field": "failure_mode",
                "left": a.failure_mode,
                "right": b.failure_mode,
                "description": (
                    f"failure severity mode {a.failure_mode} vs {b.failure_mode}: "
                    "capacity_loss and maintenance leave residual service, total_failure does not"
                ),
            }
        )
    return changes


def compare(db: Session, scenario_ids: list[int]) -> dict:
    """Compare two to four saved what-ifs and explain what separates them."""
    unique_ids = list(dict.fromkeys(scenario_ids))
    if len(unique_ids) < 2:
        raise ApiError(
            "Select at least two scenarios to compare.",
            status_code=422,
            code="not_enough_scenarios",
        )
    if len(unique_ids) > 4:
        raise ApiError(
            "Compare at most four scenarios at a time.",
            status_code=422,
            code="too_many_scenarios",
        )

    scenarios = {
        s.id: s
        for s in db.scalars(
            select(WhatIfScenario).where(WhatIfScenario.id.in_(unique_ids))
        ).all()
    }
    missing = [i for i in unique_ids if i not in scenarios]
    if missing:
        raise ApiError(
            "Some scenarios no longer exist.",
            status_code=404,
            code="not_found",
            details={"scenario_ids": missing},
        )

    columns: list[dict] = []
    for scenario_id in unique_ids:
        scenario = scenarios[scenario_id]
        observation = _latest_observation(db, scenario_id)
        if observation is None:
            columns.append(
                {
                    "scenario": scenario_dict(db, scenario, include_observations=False),
                    "observation": None,
                    "metrics": None,
                    "has_reading": False,
                }
            )
            continue
        columns.append(
            {
                "scenario": scenario_dict(db, scenario, include_observations=False),
                "observation": {
                    "id": observation.id,
                    "run_id": observation.run_id,
                    "headline": observation.headline,
                    "note": observation.note,
                    "created_at": observation.created_at,
                },
                "metrics": json.loads(observation.metrics_json or "{}"),
                "has_reading": True,
            }
        )

    explanation = _explain(db, [scenarios[i] for i in unique_ids], columns)
    return {
        "columns": columns,
        "explanation": explanation,
        "assumptions": [
            "Each column shows the most recent recorded reading for that scenario.",
            "Readings are stored when recorded, so a comparison is not recomputed "
            "with a newer engine.",
            "Set differs means the failure set is not shared; the agreed core is what "
            "both futures take down regardless of how the inputs differ.",
        ],
    }


def _explain(db: Session, scenarios: list[WhatIfScenario], columns: list[dict]) -> dict:
    """Plain-language account of why these futures differ."""
    with_readings = [c for c in columns if c["has_reading"]]
    if len(with_readings) < 2:
        return {
            "headline": "Not enough recorded readings to explain a difference yet.",
            "input_changes": [],
            "agreed_core": [],
            "only_in": {},
            "spread": {},
            "notes": [
                "Record a reading for at least two scenarios to compare them.",
            ],
        }

    failed_sets = {c["scenario"]["code"]: set(c["metrics"].get("failed_codes", [])) for c in with_readings}
    agreed = set.intersection(*failed_sets.values()) if failed_sets else set()
    only_in = {
        code: sorted(codes - agreed) for code, codes in failed_sets.items() if codes - agreed
    }

    spread = {}
    for key in METRIC_KEYS:
        values = {c["scenario"]["code"]: c["metrics"].get(key, 0) for c in with_readings}
        numeric = [v for v in values.values() if isinstance(v, (int, float))]
        spread[key] = {
            "values": values,
            "min": min(numeric) if numeric else 0,
            "max": max(numeric) if numeric else 0,
            "delta": (max(numeric) - min(numeric)) if numeric else 0,
        }

    worst_key = max(spread, key=lambda k: spread[k]["delta"]) if spread else None
    input_changes: list[dict] = []
    for left, right in zip(with_readings, with_readings[1:]):
        changes = _diff_inputs(
            scenarios[[c["scenario"]["id"] for c in with_readings].index(left["scenario"]["id"])],
            scenarios[[c["scenario"]["id"] for c in with_readings].index(right["scenario"]["id"])],
        )
        for change in changes:
            input_changes.append(
                {
                    "between": [left["scenario"]["code"], right["scenario"]["code"]],
                    **change,
                }
            )

    notes: list[str] = []
    if agreed:
        notes.append(
            f"{len(agreed)} asset(s) fail in every scenario compared "
            f"({', '.join(sorted(agreed)[:6])}{'…' if len(agreed) > 6 else ''}); "
            "no intervention modelled here prevents those."
        )
    else:
        notes.append(
            "No asset fails in every scenario: the futures are dissimilar in kind, "
            "not just in size."
        )

    if worst_key and spread[worst_key]["delta"] > 0:
        hi = max(spread[worst_key]["values"], key=lambda k: spread[worst_key]["values"][k])
        lo = min(spread[worst_key]["values"], key=lambda k: spread[worst_key]["values"][k])
        notes.append(
            f"The largest difference is {worst_key.replace('_', ' ')}: "
            f"{spread[worst_key]['values'][hi]:,} in {hi} against "
            f"{spread[worst_key]['values'][lo]:,} in {lo}."
        )

    if len(input_changes) == 1:
        change = input_changes[0]
        notes.append(
            f"Exactly one input differs between the compared runs — "
            f"{change['description']} — so it accounts for the divergence."
        )
    elif len(input_changes) > 1:
        notes.append(
            f"{len(input_changes)} inputs differ between the compared runs "
            f"({', '.join(sorted({c['field'] for c in input_changes}))}). "
            "The difference cannot be attributed to a single change."
        )
    else:
        notes.append(
            "The inputs are identical, so any difference comes from run-time data "
            "drifting between the two readings; re-record them against one graph "
            "to compare like with like."
        )

    headline = (
        f"{len(agreed)} asset(s) fail in every scenario; "
        f"{sum(len(v) for v in only_in.values())} failure(s) are specific to one future."
        if only_in
        else f"All {len(agreed)} failures are common to every scenario compared."
    )

    return {
        "headline": headline,
        "input_changes": input_changes,
        "agreed_core": sorted(agreed),
        "only_in": only_in,
        "spread": spread,
        "notes": notes,
    }
