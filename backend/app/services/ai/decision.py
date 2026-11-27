"""Read-only decision intelligence orchestration for AI Disaster Commander,
Multi-Scenario AI Reasoning, and Explainable Recovery Intelligence.

All simulation and optimisation calls here execute the existing deterministic
engines in-memory without writing incidents, simulation runs, plans, or
resource reservations to the database.
"""

from __future__ import annotations

import json
import re
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.infrastructure import (
    CATEGORY_POPULATION_WEIGHT,
    CATEGORY_PRIORITY,
    InfrastructureAsset,
)
from app.models.operations import Incident, IncidentStatus, Resource
from app.models.optimization import OptimizationPlan, OptimizationRequest
from app.optimization.engine import (
    INFEASIBLE,
    OPTIMAL,
    PRIORITY_WEIGHTS,
    Demand,
    OptimizationInput,
    OptimizationResult,
    ResourceOption,
    optimize,
)
from app.seed.catalog import RESOURCE_ELIGIBILITY
from app.services import criticality as criticality_service
from app.services import infrastructure as infra_service
from app.services import optimization as opt_service
from app.services.ai import features as ai_features
from app.simulation.engine import CascadeResult, simulate_cascade

_CODE_RE = re.compile(r"\b([A-Za-z]{2,4}-\d{2})\b")
_SPLIT_SCENARIO_RE = re.compile(
    r"\b(?:vs\.?|versus|compared\s+with|compared\s+to|against|তুলনা)\b",
    re.IGNORECASE,
)


# ------------------------------------------------------------ asset extraction


def _load_active_assets(db: Session) -> list[InfrastructureAsset]:
    return list(
        db.scalars(
            select(InfrastructureAsset)
            .where(InfrastructureAsset.is_archived.is_(False))
            .order_by(InfrastructureAsset.code)
        ).all()
    )


def extract_assets_from_text(db: Session, text: str) -> dict[str, Any]:
    """Resolve asset references in natural language against live DB records.

    Returns a structured resolution dict:
      - status: "resolved" | "ambiguous" | "unknown" | "missing"
      - assets: list of resolved asset dicts
      - candidates: list of candidate asset dicts when ambiguous
      - unknown_codes: list of unrecognised XX-00 tokens
    """
    assets = _load_active_assets(db)
    by_code = {a.code.upper(): a for a in assets}

    raw_codes = [m.group(1).upper() for m in _CODE_RE.finditer(text or "")]
    seen_codes: list[str] = []
    for code in raw_codes:
        if code not in seen_codes:
            seen_codes.append(code)

    unknown_codes = [c for c in seen_codes if c not in by_code]
    matched_by_code = [by_code[c] for c in seen_codes if c in by_code]

    if matched_by_code and not unknown_codes:
        return {
            "status": "resolved",
            "assets": [_asset_brief(a) for a in matched_by_code],
            "candidates": [],
            "unknown_codes": [],
        }

    if unknown_codes and not matched_by_code:
        return {
            "status": "unknown",
            "assets": [],
            "candidates": [_asset_brief(a) for a in assets[:6]],
            "unknown_codes": unknown_codes,
        }

    # Try name / partial keyword matching when no explicit code matched.
    lower = (text or "").lower()
    exact_name_matches = [a for a in assets if a.name.lower() in lower]
    if len(exact_name_matches) == 1:
        return {
            "status": "resolved",
            "assets": [_asset_brief(exact_name_matches[0])],
            "candidates": [],
            "unknown_codes": unknown_codes,
        }
    if len(exact_name_matches) > 1:
        return {
            "status": "resolved",
            "assets": [_asset_brief(a) for a in exact_name_matches],
            "candidates": [],
            "unknown_codes": unknown_codes,
        }

    # Category or partial phrase matching (e.g. "substation", "hospital", "power station")
    category_keywords = {
        "power_station": ("power station", "power plant", "generator station", "পাওয়ার স্টেশন"),
        "substation": ("substation", "সাবস্টেশন"),
        "hospital": ("hospital", "হাসপাতাল"),
        "water_pump": ("water pump", "water station", "pump", "পানি"),
        "telecom": ("telecom", "tower", "টেলিকম"),
        "transport": ("bridge", "depot", "transit", "junction", "পরিবহন"),
        "emergency": ("fire", "dispatch", "emergency", "জরুরি"),
    }
    matched_categories = [
        cat for cat, kws in category_keywords.items() if any(kw in lower for kw in kws)
    ]
    if matched_categories:
        candidates = [a for a in assets if a.category in matched_categories]
        if len(candidates) == 1:
            return {
                "status": "resolved",
                "assets": [_asset_brief(candidates[0])],
                "candidates": [],
                "unknown_codes": unknown_codes,
            }
        if len(candidates) > 1:
            return {
                "status": "ambiguous",
                "assets": [],
                "candidates": [_asset_brief(a) for a in candidates],
                "unknown_codes": unknown_codes,
            }

    return {
        "status": "missing",
        "assets": [],
        "candidates": [_asset_brief(a) for a in assets[:6]],
        "unknown_codes": unknown_codes,
    }


def _asset_brief(asset: InfrastructureAsset) -> dict[str, Any]:
    return {
        "id": asset.id,
        "code": asset.code,
        "name": asset.name,
        "category": asset.category,
        "status": asset.status,
        "criticality": asset.criticality,
        "zone_id": asset.zone_id,
    }


# -------------------------------------------- read-only deterministic simulation


def simulate_asset_failure_readonly(
    db: Session,
    *,
    asset_ids: list[int],
    failure_mode: str = "total_failure",
    cascade_threshold: float = 0.35,
    max_depth: int = 6,
    random_seed: int = 42,
    label: str = "Read-only decision simulation",
) -> dict[str, Any]:
    """Run the real cascade engine in-memory without writing to the database."""
    nodes, edges = infra_service.simulation_inputs(db)
    if not nodes:
        return {"error": "No infrastructure assets available."}

    node_by_id = {n.id: n for n in nodes}
    result: CascadeResult = simulate_cascade(
        nodes,
        edges,
        initial_failures=asset_ids,
        cascade_threshold=cascade_threshold,
        max_depth=max_depth,
        failure_mode=failure_mode,
        random_seed=random_seed,
        run_code="READONLY",
        scenario_label=label,
    )

    initial_set = set(asset_ids)
    directly_failed = []
    cascading_failed = []
    degraded_or_affected = []
    critical_services_down = []
    impacted_paths = []

    for imp in result.impacts:
        entry = {
            "asset_id": imp.asset_id,
            "code": imp.code,
            "name": imp.name,
            "category": imp.category,
            "impact_level": imp.impact_level,
            "depth": imp.depth,
            "capacity_loss_percent": imp.capacity_loss_percent,
            "affected_population": imp.affected_population,
            "cause_asset_id": imp.cause_asset_id,
            "cause_code": node_by_id[imp.cause_asset_id].code if imp.cause_asset_id in node_by_id else None,
            "explanation": imp.explanation,
        }
        if imp.cause_asset_id and imp.cause_asset_id in node_by_id:
            impacted_paths.append(
                {
                    "from_code": node_by_id[imp.cause_asset_id].code,
                    "to_code": imp.code,
                    "depth": imp.depth,
                    "impact_level": imp.impact_level,
                }
            )
        if imp.impact_level == "failed":
            if imp.asset_id in initial_set and imp.depth == 0:
                directly_failed.append(entry)
            else:
                cascading_failed.append(entry)
            if imp.category in ("hospital", "water_pump", "telecom", "emergency"):
                critical_services_down.append(imp.code)
        else:
            degraded_or_affected.append(entry)

    sev = ai_features.severity_band(result.summary.get("severity_index"))
    return {
        "summary": {
            "assets_failed": result.summary.get("assets_failed", 0),
            "assets_impacted": result.summary.get("assets_impacted", 0),
            "affected_population": result.summary.get("affected_population", 0),
            "max_depth_reached": result.summary.get("max_depth_reached", 0),
            "severity_index": sev["index"],
            "severity_band": sev["band"],
            "severity_thresholds": sev["thresholds"],
        },
        "directly_failed": directly_failed,
        "cascading_failed": cascading_failed,
        "degraded_or_affected": degraded_or_affected,
        "critical_services_down": critical_services_down,
        "impacted_paths": impacted_paths,
        "failed_asset_ids": [
            e["asset_id"] for e in (directly_failed + cascading_failed)
        ],
        "impacted_asset_ids": [
            e["asset_id"] for e in (directly_failed + cascading_failed + degraded_or_affected)
        ],
    }


def _demands_from_failed_entries(
    db: Session, failed_entries: list[dict[str, Any]]
) -> list[Demand]:
    """Derive CP-SAT demands from failed assets without mutating the database."""
    if not failed_entries:
        return []
    assets = {
        a.id: a
        for a in db.scalars(
            select(InfrastructureAsset).where(
                InfrastructureAsset.id.in_([e["asset_id"] for e in failed_entries])
            )
        ).all()
    }
    demands: list[Demand] = []
    for entry in failed_entries:
        asset = assets.get(entry["asset_id"])
        if asset is None or asset.is_archived:
            continue
        priority = CATEGORY_PRIORITY.get(asset.category, 3)
        pop_weight = CATEGORY_POPULATION_WEIGHT.get(asset.category, 500) * max(1, asset.criticality)
        need = max(20.0, round(entry.get("capacity_loss_percent", 100.0) * 0.4, 1))
        eligible = [
            rcat
            for rcat, targets in RESOURCE_ELIGIBILITY.items()
            if asset.category in targets
        ] or ["repair_crew"]
        demands.append(
            Demand(
                asset_id=asset.id,
                asset_code=asset.code,
                asset_name=asset.name,
                category=asset.category,
                need=need,
                priority=priority,
                population=pop_weight,
                eligible_categories=eligible,
                service_window_minutes=180,
                estimated_hours=4.0,
            )
        )
    return demands


def optimize_for_cascade_readonly(
    db: Session, failed_entries: list[dict[str, Any]]
) -> dict[str, Any]:
    """Run the real CP-SAT solver in-memory for a simulated cascade."""
    demands = _demands_from_failed_entries(db, failed_entries)
    resources = opt_service.build_resource_options(db, None)
    if not demands:
        return {
            "status": "not_needed",
            "status_meaning": "No failed assets require resource allocation.",
            "assignments": [],
            "unserved": [],
            "limiting_resources": [],
            "coverage_percent": 100.0,
            "objective_value": 0.0,
            "resources": [
                {
                    "code": r.code,
                    "name": r.name,
                    "category": r.category,
                    "available": r.available,
                }
                for r in resources
            ],
        }

    opt_input = OptimizationInput(demands=demands, resources=resources)
    res: OptimizationResult = optimize(opt_input)
    limiting = _find_limiting_resources(res.resource_usage, resources)
    return {
        "status": res.status,
        "status_meaning": ai_features.solver_status_meaning(res.status),
        "objective_value": round(res.objective_value, 2),
        "coverage_percent": round(res.coverage_percent, 1),
        "covered_demand": round(res.covered_demand, 2),
        "total_demand": round(res.total_demand, 2),
        "wall_ms": res.wall_ms,
        "assignments": [a.as_dict() for a in res.assignments],
        "unserved": res.unserved,
        "limiting_resources": limiting,
        "constraints": (
            res.explanation.get("constraints", {})
            if isinstance(res.explanation, dict)
            else {"notes": list(res.explanation or [])}
        ),
        "resources": [
            {
                "code": r.code,
                "name": r.name,
                "category": r.category,
                "available": r.available,
            }
            for r in resources
        ],
    }


def _find_limiting_resources(
    resource_usage: dict[Any, dict[str, Any]], resources: list[ResourceOption] | None = None
) -> list[dict[str, Any]]:
    limiting = []
    for _rid, usage in (resource_usage or {}).items():
        avail = float(usage.get("available") or 0)
        used = float(usage.get("used") or 0)
        pct = float(usage.get("utilization_percent") or 0)
        if avail <= 0 or pct >= 85.0:
            limiting.append(
                {
                    "resource_code": usage.get("code"),
                    "resource_name": usage.get("name"),
                    "used": used,
                    "available": avail,
                    "utilization_percent": pct,
                }
            )
    if resources:
        for r in resources:
            if r.available <= 0 and not any(x["resource_code"] == r.code for x in limiting):
                limiting.append(
                    {
                        "resource_code": r.code,
                        "resource_name": r.name,
                        "used": 0.0,
                        "available": 0.0,
                        "utilization_percent": 100.0,
                    }
                )
    return limiting


# -------------------------------------------- AI Disaster Commander context


def build_commander_evidence(
    db: Session,
    *,
    resolved_assets: list[dict[str, Any]],
    failure_mode: str,
    cascade_threshold: float,
    max_depth: int,
) -> dict[str, Any]:
    asset_ids = [a["id"] for a in resolved_assets]
    sim = simulate_asset_failure_readonly(
        db,
        asset_ids=asset_ids,
        failure_mode=failure_mode,
        cascade_threshold=cascade_threshold,
        max_depth=max_depth,
        label="AI Disaster Commander simulation",
    )
    failed_all = sim["directly_failed"] + sim["cascading_failed"]
    recovery = optimize_for_cascade_readonly(db, failed_all)

    active_incidents = [
        {
            "id": inc.id,
            "code": inc.code,
            "title": inc.title,
            "severity": inc.severity,
            "status": inc.status,
            "primary_asset_id": inc.primary_asset_id,
        }
        for inc in db.scalars(
            select(Incident)
            .where(
                Incident.primary_asset_id.in_(asset_ids),
                Incident.status.notin_(["resolved", "closed", "cancelled"]),
            )
            .order_by(Incident.reported_at.desc())
        ).all()
    ]

    crit_data = criticality_service.analyse(db)
    crit_by_id = {r["asset_id"]: r for r in crit_data.get("ranking", [])}
    target_criticality = [
        {
            "code": a["code"],
            "criticality_index": crit_by_id[a["id"]]["criticality_index"],
        }
        for a in resolved_assets
        if a["id"] in crit_by_id
    ]

    return {
        "target_assets": resolved_assets,
        "target_criticality": target_criticality,
        "active_incidents_on_targets": active_incidents,
        "simulation": sim,
        "recovery_preview": recovery,
        "assumptions": [
            "Simulation is steady-state dependency screening on Aurora Vale synthetic data.",
            f"Parameters: failure_mode={failure_mode}, cascade_threshold={cascade_threshold}, max_depth={max_depth}.",
            "No database records were created or modified; no resources were reserved.",
        ],
    }


def commander_sections_from_evidence(evidence: dict[str, Any]) -> dict[str, Any]:
    sim = evidence["simulation"]
    summary = sim["summary"]
    rec = evidence["recovery_preview"]
    targets = ", ".join(f"{a['code']} ({a['name']})" for a in evidence["target_assets"])

    return {
        "situation_summary": (
            f"Simulated {targets} failure: {summary['assets_failed']} failed assets "
            f"({len(sim['directly_failed'])} direct, {len(sim['cascading_failed'])} cascading), "
            f"{len(sim['degraded_or_affected'])} degraded/affected, severity {summary['severity_index']} "
            f"({summary['severity_band']})."
        ),
        "affected_infrastructure": [
            {
                "code": e["code"],
                "name": e["name"],
                "category": e["category"],
                "impact_level": e["impact_level"],
                "depth": e["depth"],
            }
            for e in (sim["directly_failed"] + sim["cascading_failed"] + sim["degraded_or_affected"])
        ],
        "cascading_impact": {
            "direct_failures": [e["code"] for e in sim["directly_failed"]],
            "cascading_failures": [e["code"] for e in sim["cascading_failed"]],
            "critical_services_down": sim["critical_services_down"],
            "max_depth_reached": summary["max_depth_reached"],
            "paths_count": len(sim["impacted_paths"]),
        },
        "population_at_risk": summary["affected_population"],
        "recommended_immediate_actions": [
            f"Dispatch {a['resource_code']} ({a['quantity']} units) to {a['asset_code']} ({a['asset_name']})"
            for a in rec.get("assignments", [])[:5]
        ]
        or ["Open Simulation Lab and Recovery Planner to inspect manual restoration options."],
        "resource_constraints": {
            "solver_status": rec["status"],
            "coverage_percent": rec["coverage_percent"],
            "limiting_resources": rec.get("limiting_resources", []),
            "unserved_count": len(rec.get("unserved", [])),
        },
        "evidence_and_limitations": evidence["assumptions"],
    }


def commander_fallback(evidence: dict[str, Any], *, lang: str = "en", reason: str = "") -> str:
    sim = evidence["simulation"]
    s = sim["summary"]
    rec = evidence["recovery_preview"]
    targets = ", ".join(f"**{a['code']}** ({a['name']})" for a in evidence["target_assets"])
    direct = ", ".join(e["code"] for e in sim["directly_failed"]) or "none"
    cascade = ", ".join(e["code"] for e in sim["cascading_failed"]) or "none"
    crit_down = ", ".join(sim["critical_services_down"]) or "none"
    actions = "\n".join(
        f"- Assign **{a['resource_code']}** ({a['quantity']} units) to **{a['asset_code']}** ({a['asset_name']})"
        for a in rec.get("assignments", [])[:6]
    ) or "- No automatic solver assignment was generated."
    limiting = ", ".join(
        f"{r['resource_code']} ({r['utilization_percent']}% used)"
        for r in rec.get("limiting_resources", [])
    ) or "None at >= 85% utilization"

    note = f"\n\n> {reason}" if reason else ""
    if lang == "bn":
        return (
            f"### পরিস্থিতি সারসংক্ষেপ\n"
            f"{targets} ব্যর্থ হলে মোট **{s['assets_failed']}টি** সম্পদ ব্যর্থ হয় "
            f"(প্রাথমিক: {direct}; ক্যাসকেড: {cascade}), তীব্রতা সূচক **{s['severity_index']}** ({s['severity_band']})।\n\n"
            f"### ঝুঁকিতে থাকা জনসংখ্যা\n"
            f"আনুমানিক **{s['affected_population']:,}** মানুষ প্রভাবিত।\n\n"
            f"### ক্যাসকেডিং প্রভাব\n"
            f"সর্বোচ্চ গভীরতা **{s['max_depth_reached']}**; জরুরি সেবা বন্ধ: {crit_down}।\n\n"
            f"### প্রস্তাবিত তাৎক্ষণিক পদক্ষেপ\n{actions}\n\n"
            f"### সম্পদের সীমাবদ্ধতা\n"
            f"সলভার স্ট্যাটাস: **{rec['status']}** (কভারেজ {rec['coverage_percent']}%)। সীমিত সম্পদ: {limiting}।\n\n"
            f"### প্রমাণ ও সীমাবদ্ধতা\n"
            f"- এটি Aurora Vale-এর সিন্থেটিক ডেটার ওপর নির্ধারিত (deterministic) রিড-অনলি সিমুলেশন।"
            f"{note}"
        )

    return (
        f"### Situation Summary\n"
        f"Simulating {targets} yields **{s['assets_failed']} failed assets** "
        f"(direct: {direct}; cascading: {cascade}) and **{len(sim['degraded_or_affected'])} degraded/affected**, "
        f"with severity index **{s['severity_index']}** ({s['severity_band']}).\n\n"
        f"### Affected Infrastructure & Cascading Impact\n"
        f"- **Directly failed:** {direct}\n"
        f"- **Cascading failures:** {cascade} (max depth {s['max_depth_reached']})\n"
        f"- **Critical services down:** {crit_down}\n\n"
        f"### Population at Risk\n"
        f"Estimated **{s['affected_population']:,}** people affected.\n\n"
        f"### Recommended Immediate Actions\n{actions}\n\n"
        f"### Resource Constraints\n"
        f"- **CP-SAT preview status:** `{rec['status']}` ({rec['coverage_percent']}% demand coverage)\n"
        f"- **Limiting resources:** {limiting}\n\n"
        f"### Evidence and Limitations\n"
        f"- Read-only deterministic cascade + CP-SAT preview on synthetic Aurora Vale data; no database records were modified."
        f"{note}"
    )


# ---------------------------------------- Multi-Scenario AI Reasoning helpers


def parse_comparison_question(db: Session, question: str) -> list[dict[str, Any]]:
    """Split a natural-language comparison query into 2–3 asset scenarios."""
    parts = [p.strip() for p in _SPLIT_SCENARIO_RE.split(question or "") if p.strip()]
    scenarios: list[dict[str, Any]] = []
    if len(parts) >= 2:
        for idx, part in enumerate(parts[:3], start=1):
            res = extract_assets_from_text(db, part)
            if res["status"] == "resolved":
                scenarios.append(
                    {
                        "label": " + ".join(a["code"] for a in res["assets"]),
                        "assets": res["assets"],
                        "failure_mode": "total_failure",
                        "cascade_threshold": 0.35,
                        "max_depth": 6,
                    }
                )
    if len(scenarios) >= 2:
        return scenarios

    # Fallback: extract all explicit codes from the whole question and treat each as a scenario.
    res_all = extract_assets_from_text(db, question or "")
    if res_all["status"] == "resolved" and len(res_all["assets"]) >= 2:
        return [
            {
                "label": a["code"],
                "assets": [a],
                "failure_mode": "total_failure",
                "cascade_threshold": 0.35,
                "max_depth": 6,
            }
            for a in res_all["assets"][:3]
        ]
    return scenarios


def compare_scenarios_readonly(
    db: Session, scenario_defs: list[dict[str, Any]]
) -> dict[str, Any]:
    """Run each scenario independently and compute exact backend metric diffs."""
    crit_data = criticality_service.analyse(db)
    crit_by_id = {r["asset_id"]: r["criticality_index"] for r in crit_data.get("ranking", [])}

    evaluated: list[dict[str, Any]] = []
    for idx, sc in enumerate(scenario_defs, start=1):
        asset_ids = [a["id"] for a in sc["assets"]]
        sim = simulate_asset_failure_readonly(
            db,
            asset_ids=asset_ids,
            failure_mode=sc.get("failure_mode", "total_failure"),
            cascade_threshold=sc.get("cascade_threshold", 0.35),
            max_depth=sc.get("max_depth", 6),
            label=sc.get("label") or f"Scenario {idx}",
        )
        failed_all = sim["directly_failed"] + sim["cascading_failed"]
        demands = _demands_from_failed_entries(db, failed_all)
        crit_vals = [crit_by_id[aid] for aid in asset_ids if aid in crit_by_id]
        max_crit = round(max(crit_vals), 1) if crit_vals else 0.0
        s = sim["summary"]
        evaluated.append(
            {
                "key": f"S{idx}",
                "label": sc.get("label") or ", ".join(a["code"] for a in sc["assets"]),
                "target_assets": sc["assets"],
                "failure_mode": sc.get("failure_mode", "total_failure"),
                "metrics": {
                    "directly_failed_assets": len(sim["directly_failed"]),
                    "cascading_failures": len(sim["cascading_failed"]),
                    "total_failed_assets": s["assets_failed"],
                    "impacted_dependency_paths": len(sim["impacted_paths"]),
                    "affected_population": s["affected_population"],
                    "severity_index": s["severity_index"],
                    "target_criticality_index": max_crit,
                    "recovery_demands_count": len(demands),
                },
                "severity_band": s["severity_band"],
                "failed_codes": [e["code"] for e in failed_all],
                "cascading_codes": [e["code"] for e in sim["cascading_failed"]],
                "critical_services_down": sim["critical_services_down"],
                "failed_asset_ids": sim["failed_asset_ids"],
            }
        )

    metric_specs = [
        ("directly_failed_assets", "Directly Failed Assets"),
        ("cascading_failures", "Cascading Failures"),
        ("total_failed_assets", "Total Failed Assets"),
        ("impacted_dependency_paths", "Impacted Dependency Paths"),
        ("affected_population", "Affected Population"),
        ("severity_index", "Severity Index"),
        ("target_criticality_index", "Target Criticality Index"),
        ("recovery_demands_count", "Recovery Demands Required"),
    ]

    metrics_table = []
    for key, title in metric_specs:
        values = {sc["label"]: sc["metrics"][key] for sc in evaluated}
        max_val = max(values.values())
        min_val = min(values.values())
        winners = [lbl for lbl, v in values.items() if v == max_val]
        if max_val == min_val:
            higher = "tied"
        elif len(winners) == 1:
            higher = winners[0]
        else:
            higher = ", ".join(winners)
        metrics_table.append(
            {
                "metric": key,
                "label": title,
                "values": values,
                "higher_impact": higher,
                "spread": round(max_val - min_val, 2),
            }
        )

    # Set differences for first two scenarios
    diffs: dict[str, Any] = {}
    if len(evaluated) >= 2:
        a_set = set(evaluated[0]["failed_codes"])
        b_set = set(evaluated[1]["failed_codes"])
        diffs = {
            "shared_failures": sorted(a_set & b_set),
            "only_in_first": sorted(a_set - b_set),
            "only_in_second": sorted(b_set - a_set),
        }

    return {
        "scenarios": evaluated,
        "metrics_table": metrics_table,
        "set_differences": diffs,
        "note": "No composite disaster score is invented; each metric is compared individually.",
    }


def compare_fallback(comparison: dict[str, Any], *, lang: str = "en", reason: str = "") -> str:
    scenarios = comparison["scenarios"]
    table_rows = []
    for row in comparison["metrics_table"]:
        vals = " | ".join(f"{k}: **{v}**" for k, v in row["values"].items())
        table_rows.append(f"- **{row['label']}:** {vals} (Higher impact: `{row['higher_impact']}`)")
    rows_md = "\n".join(table_rows)
    diffs = comparison.get("set_differences") or {}
    shared = ", ".join(diffs.get("shared_failures", [])) or "none"
    note = f"\n\n> {reason}" if reason else ""

    if lang == "bn":
        return (
            f"### বহু-পরিস্থিতি তুলনামূলক বিশ্লেষণ ({' বনাম '.join(s['label'] for s in scenarios)})\n"
            f"{rows_md}\n\n"
            f"**যৌথভাবে ব্যর্থ সম্পদ:** {shared}।"
            f"{note}"
        )

    return (
        f"### Multi-Scenario Comparison ({' vs '.join(s['label'] for s in scenarios)})\n"
        f"{rows_md}\n\n"
        f"- **Shared failures across first two scenarios:** {shared}\n"
        f"- Each metric is computed deterministically by the backend simulation engine; tied metrics are marked `tied`."
        f"{note}"
    )


# ------------------------------------- Explainable Recovery & Alternative Plans


def build_plan_reasoning(db: Session, plan: OptimizationPlan, plan_dict: dict[str, Any]) -> dict[str, Any]:
    """Build deterministic explainable recovery reasoning from stored CP-SAT outputs."""
    explanation = plan_dict.get("explanation") or {}
    status = str(plan.solution_status or "unknown")
    assignments = plan_dict.get("assignments") or []
    unserved = explanation.get("unserved") or []
    resource_usage = explanation.get("resource_usage") or {}
    constraints = explanation.get("constraints") or {}

    limiting = _find_limiting_resources(resource_usage)

    # Prioritized demands: assets served sorted by priority desc
    prioritized = sorted(
        [
            {
                "asset_code": a.get("asset_code"),
                "asset_name": a.get("asset_name"),
                "resource_code": a.get("resource_code"),
                "quantity": a.get("quantity"),
            }
            for a in assignments
        ],
        key=lambda x: str(x.get("asset_code") or ""),
    )

    improve_hints = []
    if unserved:
        total_shortfall = sum(float(u.get("need") or 0) for u in unserved)
        improve_hints.append(
            f"{len(unserved)} demand(s) remain unserved (total {round(total_shortfall, 1)} units needed). "
            "Adding eligible resource capacity or relaxing mobilisation windows would allow the solver to serve them."
        )
    if limiting:
        names = ", ".join(f"{r['resource_code']} ({r['utilization_percent']}%)" for r in limiting)
        improve_hints.append(f"Limiting resources at/near capacity: {names}.")
    if not unserved and status.lower() == "optimal":
        improve_hints.append("All encoded demands are fully served under an optimal CP-SAT solution.")

    return {
        "why_selected": (
            f"CP-SAT evaluated the encoded demands using exponential priority weights "
            f"(hospital/emergency outranking lower-priority assets) with an all-or-nothing coverage gate, "
            f"achieving {plan.coverage_percent}% demand coverage and solver objective {plan.objective_value}."
        ),
        "optimality_status": status,
        "optimality_meaning": ai_features.solver_status_meaning(status),
        "prioritized_allocations": prioritized,
        "unserved_demands": unserved,
        "limiting_resources": limiting,
        "recorded_constraints": constraints,
        "what_would_improve_outcome": improve_hints,
    }


def generate_alternative_plans(
    db: Session, plan: OptimizationPlan, plan_dict: dict[str, Any]
) -> list[dict[str, Any]]:
    """Run the actual CP-SAT solver under explicit alternative objective weights
    without persisting or modifying any database records."""
    req = db.get(OptimizationRequest, plan.request_id)
    if req is None:
        return []
    raw_demands = json.loads(req.demand_json or "[]")
    if not raw_demands:
        return []

    demands: list[Demand] = []
    for item in raw_demands:
        asset = db.get(InfrastructureAsset, item.get("asset_id"))
        if asset is None or asset.is_archived:
            continue
        demands.append(
            Demand(
                asset_id=asset.id,
                asset_code=asset.code,
                asset_name=asset.name,
                category=asset.category,
                need=float(item["need"]),
                priority=int(item["priority"]),
                population=CATEGORY_POPULATION_WEIGHT.get(asset.category, 500) * max(1, asset.criticality),
                eligible_categories=list(item.get("eligible_categories") or []),
                service_window_minutes=int(item.get("service_window_minutes") or 180),
                estimated_hours=float(item.get("estimated_hours") or 4.0),
            )
        )
    if not demands:
        return []

    resources = opt_service.build_resource_options(db, None)
    base_served = {
        a.get("asset_code")
        for a in (plan_dict.get("assignments") or [])
        if a.get("asset_code")
    }

    strategies = [
        ("priority_first", "Priority-First (criticality & hospital priority)", {"criticality": 1000, "coverage": 10, "cost": 1}),
        ("coverage_max", "Balanced / Maximum Coverage (restore most sites)", {"criticality": 100, "coverage": 1000, "cost": 1}),
        ("resource_conservative", "Resource-Conservative (minimize mobilisation cost)", {"criticality": 100, "coverage": 10, "cost": 50}),
    ]

    alternatives: list[dict[str, Any]] = []
    for strategy_key, label, weights in strategies:
        opt_input = OptimizationInput(
            demands=demands,
            resources=resources,
            objective_weights=weights,
            time_limit_seconds=1.5,
        )
        res = optimize(opt_input)
        served_codes = sorted(
            {
                d.asset_code
                for d in demands
                if d.asset_id not in {u["asset_id"] for u in res.unserved}
            }
        )
        total_cost = round(sum(float(a.as_dict().get("estimated_cost") or 0) for a in res.assignments), 2)
        base_cost = round(
            sum(float(a.get("estimated_cost") or 0) for a in (plan_dict.get("assignments") or [])),
            2,
        )
        alternatives.append(
            {
                "strategy": strategy_key,
                "label": label,
                "status": res.status,
                "feasible": res.status != INFEASIBLE,
                "coverage_percent": round(res.coverage_percent, 1),
                "objective_value": round(res.objective_value, 2),
                "estimated_cost": total_cost,
                "cost_diff_vs_saved": round(total_cost - base_cost, 2),
                "coverage_diff_vs_saved": round(res.coverage_percent - float(plan.coverage_percent or 0), 1),
                "served_assets": served_codes,
                "added_vs_saved": sorted(set(served_codes) - base_served),
                "dropped_vs_saved": sorted(base_served - set(served_codes)),
                "unserved_count": len(res.unserved),
                "wall_ms": res.wall_ms,
            }
        )
    return alternatives
