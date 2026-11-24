"""Time travel: reconstruct the city as it was at a moment, and at any moment since.

What is stored, and why that decides the design
===============================================
Nothing here snapshots the city. A snapshot table would be a second copy of the
truth, and it would be wrong the moment someone edits an asset. Instead the city
is rebuilt from records that are already immutable:

* ``infrastructure_status_history`` -- one row per status change, with the time it
  happened. This is the only thing that can be replayed exactly, because a status
  change is appended, never edited.
* ``audit_logs`` -- every decision, with the resource it touched and when.
* ``simulation_runs`` and their results -- failures and their propagation depth.
* ``incidents``, ``optimization_plans``, ``repair_tasks`` -- the response.
* ``infrastructure_assets`` current rows -- the *shape* of the network, which
  includes assets that did not exist yet at the chosen moment, so they are
  filtered by creation time where the schema records one.

What can and cannot be reconstructed
====================================
Status is exact. Everything else is stated as of the query time, and the result
says which is which -- an "asset was operational at 14:32" claim from history is
not the same kind of claim as "an incident was open at 14:32", which is inferred
from ``reported_at`` plus whatever the audit log shows. Mixing the two without
saying so would let a demo look authoritative where it is only plausible.

Replay is also not just a list of snapshots. Between two recorded moments the
city is assumed unchanged, so a replay that steps through history shows the
moments where something actually happened rather than 300 identical frames.
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.responses import ApiError
from app.core.types import utcnow
from app.models.infrastructure import (
    InfrastructureAsset,
    InfrastructureStatusHistory,
)
from app.models.operations import Incident, RepairTask
from app.models.simulation import SimulationResult, SimulationRun
from app.models.system import AuditLog

# Impact ordering for "how bad was it" comparisons. Must cover every status the
# asset model accepts, or an unranked status silently compares as "best".
SEVERITY_ORDER = {
    "operational": 0,
    "maintenance": 1,
    "degraded": 2,
    "offline": 3,
    "failed": 4,
}

MAX_FRAMES = 120


def _as_utc(value: datetime) -> datetime:
    return value if value.tzinfo else value.replace(tzinfo=utcnow().tzinfo)


def status_at(db: Session, asset_id: int, moment: datetime) -> tuple[str, dict | None]:
    """The asset's status at ``moment``, from its append-only history.

    Walks history backwards: the newest change at or before the moment wins. If
    history has nothing before the moment, the earliest recorded ``previous_status``
    is used -- that is the best evidence of what was true before the first change.
    """
    moment = _as_utc(moment)
    rows = list(
        db.scalars(
            select(InfrastructureStatusHistory)
            .where(InfrastructureStatusHistory.asset_id == asset_id)
            .order_by(InfrastructureStatusHistory.changed_at.asc())
        ).all()
    )
    if not rows:
        asset = db.get(InfrastructureAsset, asset_id)
        return (asset.status if asset else "unknown"), None

    chosen = None
    for row in rows:
        if _as_utc(row.changed_at) <= moment:
            chosen = row
        else:
            break
    if chosen is None:
        first = rows[0]
        return (first.previous_status or "unknown"), {
            "change_id": first.id,
            "at": first.changed_at,
            "reason": "before the first recorded change; using its previous status",
            "inferred": True,
        }
    return chosen.new_status, {
        "change_id": chosen.id,
        "at": chosen.changed_at,
        "reason": chosen.reason or "",
        "inferred": False,
    }


def _population_weight(asset: InfrastructureAsset) -> int:
    """The category-derived population each asset stands for.

    Reused from the optimisation service rather than reimplemented: if the two
    ever disagreed, the replay would report a different risk figure than the
    planner, and both numbers would look authoritative.
    """
    from app.services.optimization import _population_weight as weight

    return weight(asset)


def _asset_dict(asset: InfrastructureAsset) -> dict:
    return {
        "id": asset.id,
        "code": asset.code,
        "name": asset.name,
        "category": asset.category,
        "zone_id": asset.zone_id,
        "criticality": asset.criticality,
        "population_weight": _population_weight(asset),
    }


def _simulation_evidence(db: Session, moment: datetime) -> list[dict]:
    """Runs started at or before the moment, newest first.

    A run recorded before the moment is evidence of what the city believed then.
    Runs are never edited, so this is exact.
    """
    runs = db.scalars(
        select(SimulationRun)
        .where(SimulationRun.started_at <= moment)
        .order_by(SimulationRun.started_at.desc())
        .limit(5)
    ).all()
    return [
        {
            "run_id": run.id,
            "code": run.code,
            "name": run.name,
            "started_at": run.started_at,
            "summary": json.loads(run.summary_json or "{}"),
            "initial_failure_ids": json.loads(run.initial_failure_ids_json or "[]"),
        }
        for run in runs
    ]


def snapshot(db: Session, moment: datetime) -> dict:
    """The city as it was at ``moment``."""
    moment = _as_utc(moment)
    assets = db.scalars(
        select(InfrastructureAsset).where(InfrastructureAsset.is_archived.is_(False))
    ).all()

    states = []
    counts = {
        "operational": 0,
        "degraded": 0,
        "maintenance": 0,
        "offline": 0,
        "failed": 0,
        "unknown": 0,
    }
    for asset in assets:
        status, evidence = status_at(db, asset.id, moment)
        counts[status] = counts.get(status, 0) + 1
        states.append(
            {
                **_asset_dict(asset),
                "status": status,
                "as_of": evidence["at"] if evidence else None,
                "evidence": evidence,
            }
        )

    incidents_open = db.scalars(
        select(Incident).where(Incident.reported_at <= moment)
    ).all()
    # An incident is open at the moment unless the audit trail shows it resolved
    # before then; resolution times are not stored on the incident row itself.
    resolved_ids = set(
        db.scalars(
            select(AuditLog.resource_id).where(
                AuditLog.resource_type == "incident",
                AuditLog.action == "incident.transition",
                AuditLog.created_at <= moment,
                AuditLog.metadata_json.like('%"resolved"%'),
                AuditLog.resource_id.isnot(None),
            )
        ).all()
    )
    open_incidents = [i for i in incidents_open if i.id not in resolved_ids]

    designs = db.scalars(
        select(AuditLog).where(
            AuditLog.action == "optimization.solve", AuditLog.created_at <= moment
        )
    ).all()

    # Both words for "this asset is not delivering service": ``offline`` is what
    # the asset record uses, ``failed`` is what simulation results use. Counting
    # only one would report zero risk on a city that had lost half its power.
    population_at_risk = sum(
        state["population_weight"]
        for state in states
        if state["status"] in ("failed", "offline")
    )

    return {
        "moment": moment,
        "status_counts": counts,
        "assets": states,
        "failed_asset_ids": [s["id"] for s in states if s["status"] == "failed"],
        "incidents": [
            {
                "id": i.id,
                "code": i.code,
                "title": i.title,
                "severity": i.severity,
                "status": i.status,
                "primary_asset_id": i.primary_asset_id,
                "reported_at": i.reported_at,
            }
            for i in open_incidents
        ],
        "population_at_risk": population_at_risk,
        "simulations": _simulation_evidence(db, moment),
        "plans_designed": len(designs),
        "fidelity": {
            "exact": [
                "asset status (from append-only status history)",
                "simulation runs and their recorded results",
                "audit-logged actions",
            ],
            "inferred": [
                "which incidents were open (from report time plus logged resolutions)",
                "plans designed before the moment (from the audit log)",
            ],
            "not_reconstructed": [
                "resource inventory levels: stock is a current value, not a history",
                "workflow step progress before the moment",
                "who was on shift",
            ],
        },
    }


def change_log(db: Session, *, since: datetime | None, until: datetime | None) -> list[dict]:
    """Every recorded change in the window, oldest first, ready to step through.

    Only real events. There is no synthetic frame per minute, because a replay
    padded with moments where nothing happened suggests a level of observation
    the data does not contain.
    """
    until = _as_utc(until or utcnow())
    since = _as_utc(since or (until - timedelta(days=30)))

    history = db.scalars(
        select(InfrastructureStatusHistory)
        .where(
            InfrastructureStatusHistory.changed_at >= since,
            InfrastructureStatusHistory.changed_at <= until,
        )
        .order_by(InfrastructureStatusHistory.changed_at.asc())
    ).all()
    run_ids = [
        r
        for r in db.scalars(
            select(SimulationRun)
            .where(SimulationRun.started_at >= since, SimulationRun.started_at <= until)
            .order_by(SimulationRun.started_at.asc())
        ).all()
    ]
    incidents = db.scalars(
        select(Incident)
        .where(Incident.reported_at >= since, Incident.reported_at <= until)
        .order_by(Incident.reported_at.asc())
    ).all()
    designs = db.scalars(
        select(AuditLog)
        .where(
            AuditLog.action.in_(["optimization.solve", "optimization.plan_approved"]),
            AuditLog.created_at >= since,
            AuditLog.created_at <= until,
        )
        .order_by(AuditLog.created_at.asc())
    ).all()
    responses = db.scalars(
        select(RepairTask)
        .where(RepairTask.created_at >= since, RepairTask.created_at <= until)
        .order_by(RepairTask.created_at.asc())
    ).all()

    asset_codes = {a.id: a.code for a in db.scalars(select(InfrastructureAsset)).all()}

    frames: list[dict] = []
    for row in history:
        frames.append(
            {
                "at": _as_utc(row.changed_at),
                "kind": "status",
                "asset_id": row.asset_id,
                "asset_code": asset_codes.get(row.asset_id, str(row.asset_id)),
                "summary": f"{asset_codes.get(row.asset_id, row.asset_id)} "
                f"{row.previous_status or 'unknown'} → {row.new_status}",
                "detail": row.reason or "",
                "from": row.previous_status,
                "to": row.new_status,
            }
        )
    for run in run_ids:
        summary = json.loads(run.summary_json or "{}")
        frames.append(
            {
                "at": _as_utc(run.started_at),
                "kind": "simulation",
                "run_id": run.id,
                "summary": f"{run.code} simulated: {summary.get('assets_failed', 0)} assets failed",
                "detail": (
                    f"{summary.get('affected_population', 0):,} people affected, "
                    f"depth {summary.get('max_depth_reached', 0)}"
                ),
                "from": None,
                "to": None,
            }
        )
    for incident in incidents:
        frames.append(
            {
                "at": _as_utc(incident.reported_at),
                "kind": "incident",
                "incident_id": incident.id,
                "summary": f"{incident.code} reported: {incident.title}",
                "detail": f"severity {incident.severity}",
                "from": None,
                "to": incident.status,
            }
        )
    for design in designs:
        frames.append(
            {
                "at": _as_utc(design.created_at),
                "kind": "dispatch" if design.action.endswith("approved") else "design",
                "summary": design.message or design.action,
                "detail": f"by {design.actor_email or 'unknown'}",
                "from": None,
                "to": None,
            }
        )
    for task in responses:
        frames.append(
            {
                "at": _as_utc(task.created_at),
                "kind": "response",
                "task_id": task.id,
                "summary": f"{task.code} created: {task.title}",
                "detail": f"{task.priority} priority",
                "from": None,
                "to": task.status,
            }
        )

    frames.sort(key=lambda f: f["at"])
    return frames


def replay(
    db: Session,
    *,
    since: datetime | None = None,
    until: datetime | None = None,
    limit: int = MAX_FRAMES,
) -> dict:
    """A step-through timeline of the window, with a snapshot per frame."""
    now = utcnow()
    frames = change_log(db, since=since, until=until)
    total = len(frames)
    if total > limit:
        # Keep the most recent: an operator replaying the last day wants the end
        # of the story, and the first hundred status changes of a month tell it
        # least.
        frames = frames[-limit:]
        truncated = True
    else:
        truncated = False

    steps = []
    previous: dict[int, str] = {}
    for index, frame in enumerate(frames, start=1):
        step = {
            "index": index,
            "at": frame["at"],
            "kind": frame["kind"],
            "summary": frame["summary"],
            "detail": frame["detail"],
            "from": frame["from"],
            "to": frame["to"],
        }
        if frame["kind"] == "status":
            asset_id = frame["asset_id"]
            step["asset_id"] = asset_id
            step["asset_code"] = frame["asset_code"]
            step["was"] = previous.get(asset_id, frame["from"])
            previous[asset_id] = frame["to"]
            step["now"] = frame["to"]
        steps.append(step)

    start = _as_utc(since) if since else (
        _as_utc(frames[0]["at"]) if frames else now - timedelta(days=30)
    )
    end = _as_utc(until) if until else now

    return {
        "window": {"since": start, "until": end},
        "steps": steps,
        "step_count": len(steps),
        "total_changes": total,
        "truncated": truncated,
        "snapshot_at_end": snapshot(db, end),
        "sources": [
            "infrastructure_status_history (append-only, exact)",
            "simulation_runs (immutable once completed, exact)",
            "incidents (reported_at, exact)",
            "audit_logs (immutable, exact)",
            "repair_tasks (created_at, exact)",
        ],
        "notes": _notes(steps, truncated),
    }


def _notes(steps: list[dict], truncated: bool) -> list[str]:
    notes: list[str] = []
    if not steps:
        notes.append(
            "Nothing was recorded in this window, so there is nothing to replay. "
            "That is a statement about the record, not about the city."
        )
        return notes
    kinds = {}
    for step in steps:
        kinds[step["kind"]] = kinds.get(step["kind"], 0) + 1
    notes.append(
        f"{len(steps)} recorded change(s): "
        + ", ".join(f"{count} {kind}" for kind, count in sorted(kinds.items()))
        + "."
    )
    notes.append(
        "Only moments where something changed are shown. A replay padded with quiet "
        "minutes would suggest the city was being watched more closely than it was."
    )
    if truncated:
        notes.append(
            f"The window contained more changes than the {MAX_FRAMES}-step limit; the "
            "most recent are shown. Narrow the window to see the earlier ones."
        )
    return notes


def compare_moments(db: Session, first: datetime, second: datetime) -> dict:
    """What changed between two moments, expressed as asset-level movement."""
    a = snapshot(db, first)
    b = snapshot(db, second)
    before = {asset["id"]: asset for asset in a["assets"]}
    after = {asset["id"]: asset for asset in b["assets"]}

    changes = []
    for asset_id in sorted(set(before) | set(after)):
        old = before.get(asset_id)
        new = after.get(asset_id)
        old_status = old["status"] if old else "absent"
        new_status = new["status"] if new else "absent"
        if old_status == new_status:
            continue
        delta = SEVERITY_ORDER.get(new_status, 0) - SEVERITY_ORDER.get(old_status, 0)
        if new_status == "absent":
            delta = -1
        elif old_status == "absent":
            delta = 1
        changes.append(
            {
                "asset_id": asset_id,
                "asset_code": (new or old)["code"],
                "asset_name": (new or old)["name"],
                "from": old_status,
                "to": new_status,
                "direction": "worse" if delta > 0 else "better" if delta < 0 else "lateral",
                "at": (new or old).get("as_of"),
            }
        )

    worsened = [c for c in changes if c["direction"] == "worse"]
    improved = [c for c in changes if c["direction"] == "better"]
    return {
        "first": {"moment": a["moment"], "status_counts": a["status_counts"]},
        "second": {"moment": b["moment"], "status_counts": b["status_counts"]},
        "changes": changes,
        "worsened": worsened,
        "improved": improved,
        "population_at_risk": {
            "first": a["population_at_risk"],
            "second": b["population_at_risk"],
            "delta": b["population_at_risk"] - a["population_at_risk"],
        },
        "notes": [
            f"{len(worsened)} asset(s) got worse and {len(improved)} got better between "
            f"{a['moment']} and {b['moment']}."
        ]
        + (
            [
                "Status is reconstructed from append-only history, so these changes are "
                "exact rather than estimated."
            ]
            if changes
            else [
                "No asset changed status in this window; the city's record says it was "
                "steady."
            ]
        ),
    }


def _parse(value: str | None, *, field: str) -> datetime | None:
    """Accept the timestamp forms a client will actually send.

    ``datetime.isoformat()`` produces ``+00:00``, and an unescaped ``+`` in a query
    string arrives as a space. Rejecting that would make every correctly formatted
    UTC timestamp fail with a message about formatting, so both spellings are
    accepted and the space is read as the offset sign it was meant to be.
    """
    if not value:
        return None
    text = value.strip().replace("Z", "+00:00")
    # "+00:00" -> " 00:00" through query decoding; a trailing offset is unambiguous.
    if " " in text:
        head, _, tail = text.partition(" ")
        if tail and (tail[0].isdigit() or tail[0] == "-") and ":" in tail and len(tail) <= 6:
            text = f"{head}+{tail}"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError as exc:  # pragma: no cover - defensive
        raise ApiError(
            f"{field} must be an ISO-8601 timestamp.",
            status_code=422,
            code="invalid_timestamp",
        ) from exc
    return _as_utc(parsed)


def parse_moment(value: str | None, *, field: str) -> datetime | None:
    return _parse(value, field=field)


def latest_activity(db: Session) -> datetime | None:
    return db.scalar(select(func.max(InfrastructureStatusHistory.changed_at)))
