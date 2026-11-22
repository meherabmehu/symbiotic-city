"""Simulation persistence + orchestration around the pure engine."""
from __future__ import annotations

import json
from datetime import timedelta

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.responses import ApiError
from app.core.types import utcnow
from app.models.infrastructure import InfrastructureAsset
from app.models.operations import Incident, IncidentStatus
from app.models.simulation import SimulationResult, SimulationRun
from app.schemas.simulation import SimulationRunRequest
from app.services import infrastructure as infra_service
from app.simulation.engine import (
    CascadeResult,
    apply_load_sensitivity,
    haversine_km,
    severity_label,
    simulate_cascade,
)


def next_run_code(db: Session) -> str:
    count = db.scalar(select(func.count()).select_from(SimulationRun)) or 0
    return f"SIM-{count + 1:04d}"


def execute_run(db: Session, payload: SimulationRunRequest, *, actor_id: int | None) -> SimulationRun:
    nodes, edges = infra_service.simulation_inputs(db)
    if not nodes:
        raise ApiError(
            "There is no infrastructure to simulate yet.",
            status_code=409,
            code="empty_city",
        )
    if payload.load_noise > 0:
        nodes = apply_load_sensitivity(nodes, payload.load_noise, payload.random_seed)

    scenario_label = payload.name or "Controlled failure"
    if payload.scenario_id:
        from app.models.simulation import SimulationScenario

        scenario = db.get(SimulationScenario, payload.scenario_id)
        if scenario is None:
            raise ApiError("Scenario not found.", status_code=404, code="not_found")
        payload = payload.model_copy(
            update={
                "initial_failure_ids": json.loads(scenario.initial_failure_ids_json),
                "failure_mode": scenario.failure_mode,
                "cascade_threshold": scenario.cascade_threshold,
                "max_depth": scenario.max_depth,
                "random_seed": scenario.random_seed,
                "name": payload.name or scenario.name,
            }
        )
        scenario_label = payload.name or scenario.name

    if not payload.initial_failure_ids:
        raise ApiError(
            "Select at least one infrastructure asset to fail.",
            status_code=422,
            code="no_failure_selected",
        )
    known = {n.id for n in nodes}
    missing = [i for i in payload.initial_failure_ids if i not in known]
    if missing:
        raise ApiError(
            "Some selected assets are not available for simulation.",
            status_code=422,
            code="invalid_asset",
            details={"asset_ids": missing},
        )

    code = next_run_code(db)
    run = SimulationRun(
        code=code,
        name=scenario_label[:200],
        scenario_id=payload.scenario_id,
        status="running",
        failure_mode=payload.failure_mode,
        initial_failure_ids_json=json.dumps(payload.initial_failure_ids),
        cascade_threshold=payload.cascade_threshold,
        max_depth=payload.max_depth,
        random_seed=payload.random_seed,
        triggered_by_id=actor_id,
        incident_id=payload.incident_id,
        started_at=utcnow(),
    )
    db.add(run)
    db.flush()

    try:
        result: CascadeResult = simulate_cascade(
            nodes,
            edges,
            initial_failures=payload.initial_failure_ids,
            cascade_threshold=payload.cascade_threshold,
            max_depth=payload.max_depth,
            failure_mode=payload.failure_mode,
            random_seed=payload.random_seed,
            run_code=code,
            scenario_label=scenario_label,
        )
    except Exception as exc:  # pragma: no cover - defensive
        run.status = "failed"
        run.error_message = str(exc)[:500]
        run.completed_at = utcnow()
        db.flush()
        raise ApiError(
            "The simulation failed to complete. No results were stored.",
            status_code=500,
            code="simulation_failed",
        ) from exc

    run.status = result.status
    run.summary_json = json.dumps(result.summary)
    run.snapshot_json = json.dumps(
        {
            "snapshot_hash": result.snapshot_hash,
            "assumptions": result.assumptions,
            "graph_warnings": result.graph_warnings,
            "timeline": result.timeline,
            "scenario_label": result.scenario_label,
        }
    )
    run.completed_at = utcnow()
    run.duration_ms = result.duration_ms
    for impact in result.impacts:
        db.add(
            SimulationResult(
                run_id=run.id,
                asset_id=impact.asset_id,
                impact_level=impact.impact_level,
                depth=impact.depth,
                impact_score=impact.impact_score,
                capacity_loss_percent=impact.capacity_loss_percent,
                affected_population=impact.affected_population,
                cause_asset_id=impact.cause_asset_id,
                explanation=impact.explanation[:400],
            )
        )

    if payload.create_incident and payload.incident_id is None:
        incident = _create_incident_from_run(db, run, result, payload, actor_id)
        run.incident_id = incident.id
        incident.simulation_run_id = run.id

    db.flush()
    return run


def _create_incident_from_run(
    db: Session,
    run: SimulationRun,
    result: CascadeResult,
    payload: SimulationRunRequest,
    actor_id: int | None,
) -> Incident:
    from app.models.operations import IncidentAsset, IncidentEvent
    from app.services import incidents as incident_service

    primary_id = payload.initial_failure_ids[0]
    primary = db.get(InfrastructureAsset, primary_id)
    severity = payload.incident_severity or severity_label(result.summary["severity_index"])
    incident = Incident(
        code=incident_service.next_incident_code(db),
        title=payload.incident_title or f"{primary.name} failure — {result.scenario_label}"[:180],
        description=(
            f"Opened automatically from simulation {run.code}. "
            f"{result.summary['assets_failed']} asset(s) modelled as failed across "
            f"{result.summary['max_depth_reached']} propagation hop(s). "
            "Synthetic scenario — not a live event."
        ),
        category="power_outage",
        severity=severity,
        status=IncidentStatus.REPORTED,
        primary_asset_id=primary_id,
        reported_by_id=actor_id,
        affected_population=result.summary["affected_population"],
        reported_at=utcnow(),
    )
    db.add(incident)
    db.flush()
    for impact in result.impacts:
        db.add(
            IncidentAsset(
                incident_id=incident.id,
                asset_id=impact.asset_id,
                impact_level=impact.impact_level,
                impact_score=impact.impact_score,
            )
        )
    db.add(
        IncidentEvent(
            incident_id=incident.id,
            event_type="created",
            from_status=None,
            to_status=IncidentStatus.REPORTED,
            message=f"Raised from cascade simulation {run.code}.",
            actor_id=actor_id,
        )
    )
    db.flush()
    return incident


def run_to_dict(db: Session, run: SimulationRun) -> dict:
    results = db.scalars(
        select(SimulationResult)
        .where(SimulationResult.run_id == run.id)
        .order_by(SimulationResult.depth, SimulationResult.id)
    ).all()
    snapshot = json.loads(run.snapshot_json or "{}")
    assets = {
        a.id: a
        for a in db.scalars(
            select(InfrastructureAsset).where(
                InfrastructureAsset.id.in_([r.asset_id for r in results] or [0])
            )
        ).all()
    }
    impacts = []
    for row in results:
        asset = assets.get(row.asset_id)
        impacts.append(
            {
                "asset_id": row.asset_id,
                "code": asset.code if asset else str(row.asset_id),
                "name": asset.name if asset else "Unknown asset",
                "category": asset.category if asset else "unknown",
                "impact_level": row.impact_level,
                "depth": row.depth,
                "impact_score": row.impact_score,
                "capacity_loss_percent": row.capacity_loss_percent,
                "affected_population": row.affected_population,
                "cause_asset_id": row.cause_asset_id,
                "explanation": row.explanation,
            }
        )
    return {
        "id": run.id,
        "code": run.code,
        "name": run.name,
        "status": run.status,
        "failure_mode": run.failure_mode,
        "cascade_threshold": run.cascade_threshold,
        "max_depth": run.max_depth,
        "random_seed": run.random_seed,
        "started_at": run.started_at,
        "completed_at": run.completed_at,
        "duration_ms": run.duration_ms,
        "triggered_by_id": run.triggered_by_id,
        "incident_id": run.incident_id,
        "summary_json": run.summary_json,
        "initial_failure_ids_json": run.initial_failure_ids_json,
        "summary": json.loads(run.summary_json or "{}"),
        "initial_failure_ids": json.loads(run.initial_failure_ids_json or "[]"),
        "impacts": impacts,
        "timeline": snapshot.get("timeline", []),
        "graph_warnings": snapshot.get("graph_warnings", []),
        "assumptions": snapshot.get("assumptions", []),
        "snapshot_hash": snapshot.get("snapshot_hash", ""),
    }


def list_runs(
    db: Session,
    *,
    search: str | None = None,
    status: str | None = None,
    incident_id: int | None = None,
    offset: int = 0,
    limit: int = 20,
) -> tuple[list[SimulationRun], int]:
    stmt = select(SimulationRun)
    count_stmt = select(func.count()).select_from(SimulationRun)
    if search:
        needle = f"%{search.lower()}%"
        cond = func.lower(SimulationRun.name).like(needle) | func.lower(
            SimulationRun.code
        ).like(needle)
        stmt = stmt.where(cond)
        count_stmt = count_stmt.where(cond)
    if status:
        stmt = stmt.where(SimulationRun.status == status)
        count_stmt = count_stmt.where(SimulationRun.status == status)
    if incident_id:
        stmt = stmt.where(SimulationRun.incident_id == incident_id)
        count_stmt = count_stmt.where(SimulationRun.incident_id == incident_id)
    total = db.scalar(count_stmt) or 0
    items = db.scalars(
        stmt.order_by(SimulationRun.started_at.desc()).offset(offset).limit(limit)
    ).all()
    return list(items), total


def compare_runs(db: Session, run_ids: list[int]) -> dict:
    runs = db.scalars(select(SimulationRun).where(SimulationRun.id.in_(run_ids))).all()
    if len(runs) < 2:
        raise ApiError(
            "Select at least two simulations to compare.",
            status_code=422,
            code="not_enough_runs",
        )
    metrics = []
    for run in runs:
        summary = json.loads(run.summary_json or "{}")
        metrics.append(
            {
                "id": run.id,
                "code": run.code,
                "name": run.name,
                "severity_index": summary.get("severity_index", 0),
                "assets_failed": summary.get("assets_failed", 0),
                "assets_impacted": summary.get("assets_impacted", 0),
                "affected_population": summary.get("affected_population", 0),
                "max_depth_reached": summary.get("max_depth_reached", 0),
                "critical_services_down": summary.get("critical_services_down", []),
                "cascade_threshold": run.cascade_threshold,
                "failure_mode": run.failure_mode,
            }
        )
    return {"runs": runs, "metrics": metrics}


def crew_distance(a: InfrastructureAsset, b: InfrastructureAsset) -> float:
    return haversine_km(a.latitude, a.longitude, b.latitude, b.longitude)


def recent_window(days: int) -> "object":
    return utcnow() - timedelta(days=days)
