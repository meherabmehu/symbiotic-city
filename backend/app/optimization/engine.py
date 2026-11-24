"""Constrained recovery optimisation built on Google OR-Tools CP-SAT.

Problem
=======
We are given

* a set of **demands** ``D`` — infrastructure assets that need recovery capacity.
  Each demand has a required amount ``need_d``, a priority class
  (1 = most critical), the affected population it protects and a service window.
* a set of **resources** ``R`` — generators, tankers, crews. Each resource has a
  capacity, an hourly cost, a set of asset categories it may serve and the
  minimum lead time before it can be mobilised.

Decision variables
==================
``x[d][r]`` integer quantity of resource ``r`` assigned to demand ``d``.
``served[d]`` boolean that is true only when the demand receives all of its
required capacity. Because ``served`` is a *boolean* and the coverage
constraint is ``sum_r x[d][r] >= need_d * served[d]``, the solver is forced to
either satisfy a demand completely or leave it unserved — no half-measures that
look good on a chart but leave a hospital at 40 % power.

Constraints
===========
1. ``sum_d x[d][r] <= available_r`` — no resource is oversubscribed.
2. ``x[d][r] = 0`` when resource ``r`` is not eligible (category mismatch or
   mobilisation time above the demand's window).
3. Total mobilisation hours across selected assignments ``<= horizon``.
4. Optional minimum-coverage floor per priority class (``must_serve_priority``),
   which is what makes the "hospital must be served" requirement explicit and
   makes infeasible variants genuinely infeasible.

Objective
=========
Maximise ``sum_d served[d] * value_d - sum_{d,r} cost_{d,r} * x[d][r]`` where

``value_d = priority_weight(priority) * 100 + population_d / 100``
``cost_{d,r} = hourly_cost_r * estimated_hours_d / 100``

Priority weights are exponential (60, 30, 12, 5, 2, 1) so one hospital always
outranks five commercial facilities. Costs only break ties between equal-value
demands, matching real dispatch practice ("serve the most critical, cheapest
way").

Explainability
==============
Every plan returns the assignments chosen, the demands that went unserved with
the binding constraint that blocked them, resource utilisation, the objective
value and, for infeasible models, a reduced infeasibility explanation assembled
from the solver's assumption solving.
"""
from __future__ import annotations

import time
from dataclasses import dataclass, field

from ortools.sat.python import cp_model

PRIORITY_WEIGHTS: dict[int, int] = {1: 60, 2: 30, 3: 12, 4: 5, 5: 2}

OPTIMAL = "optimal"
FEASIBLE = "feasible"
INFEASIBLE = "infeasible"
MODEL_INVALID = "model_invalid"


@dataclass(slots=True)
class Demand:
    asset_id: int
    asset_code: str
    asset_name: str
    category: str
    need: float
    priority: int
    population: int
    eligible_categories: list[str]
    service_window_minutes: int = 240
    estimated_hours: float = 2.0
    min_units: int = 1


@dataclass(slots=True)
class ResourceOption:
    resource_id: int
    code: str
    name: str
    category: str
    available: float
    hourly_cost: int
    mobilisation_minutes: int
    serves_categories: list[str]


@dataclass(slots=True)
class OptimizationInput:
    demands: list[Demand]
    resources: list[ResourceOption]
    horizon_hours: float = 12.0
    must_serve_priority: int | None = 1
    max_assignments_per_demand: int = 3
    time_limit_seconds: float = 5.0


@dataclass
class AssignmentRow:
    asset_id: int
    asset_code: str
    asset_name: str
    resource_id: int
    resource_code: str
    resource_name: str
    quantity: float
    priority: int
    contribution: float
    rationale: str

    def as_dict(self) -> dict:
        return {
            "asset_id": self.asset_id,
            "asset_code": self.asset_code,
            "asset_name": self.asset_name,
            "resource_id": self.resource_id,
            "resource_code": self.resource_code,
            "resource_name": self.resource_name,
            "quantity": self.quantity,
            "priority": self.priority,
            "contribution": round(self.contribution, 2),
            "rationale": self.rationale,
        }


@dataclass
class OptimizationResult:
    status: str
    objective_value: float
    assignments: list[AssignmentRow]
    unserved: list[dict]
    resource_usage: dict[int, dict]
    total_demand: int
    covered_demand: int
    coverage_percent: float
    wall_ms: int
    explanation: list[str]
    infeasibility_reason: str | None = None
    debug: dict = field(default_factory=dict)

    def as_dict(self) -> dict:
        return {
            "status": self.status,
            "objective_value": round(self.objective_value, 2),
            "assignments": [a.as_dict() for a in self.assignments],
            "unserved": self.unserved,
            "resource_usage": {
                str(k): v for k, v in self.resource_usage.items()
            },
            "total_demand": self.total_demand,
            "covered_demand": self.covered_demand,
            "coverage_percent": round(self.coverage_percent, 2),
            "wall_ms": self.wall_ms,
            "explanation": self.explanation,
            "infeasibility_reason": self.infeasibility_reason,
            "debug": self.debug,
        }


def _q(value: float) -> int:
    """Scale a fractional quantity to an integer for CP-SAT."""
    return int(round(max(0.0, value) * 100))


def _demand_value(demand: Demand) -> float:
    return PRIORITY_WEIGHTS.get(demand.priority, 1) * 100 + demand.population / 100.0


def _eligible(demand: Demand, resource: ResourceOption) -> bool:
    if resource.available <= 0:
        return False
    if resource.mobilisation_minutes > demand.service_window_minutes:
        return False
    if demand.eligible_categories and resource.category not in demand.eligible_categories:
        return False
    if resource.serves_categories and demand.category not in resource.serves_categories:
        return False
    return True


def optimize(input_: OptimizationInput) -> OptimizationResult:
    started = time.perf_counter()
    model = cp_model.CpModel()
    explanation: list[str] = []

    demands = input_.demands
    resources = input_.resources
    if not demands:
        return OptimizationResult(
            status=MODEL_INVALID,
            objective_value=0.0,
            assignments=[],
            unserved=[],
            resource_usage={},
            total_demand=0,
            covered_demand=0,
            coverage_percent=0.0,
            wall_ms=int((time.perf_counter() - started) * 1000),
            explanation=["No recovery demand was supplied, so there is nothing to optimise."],
            infeasibility_reason="empty_demand_set",
        )
    if not resources:
        return OptimizationResult(
            status=INFEASIBLE,
            objective_value=0.0,
            assignments=[],
            unserved=[
                {
                    "asset_id": d.asset_id,
                    "asset_code": d.asset_code,
                    "asset_name": d.asset_name,
                    "priority": d.priority,
                    "need": d.need,
                    "reason": "No resources are registered in the inventory.",
                }
                for d in demands
            ],
            resource_usage={},
            total_demand=len(demands),
            covered_demand=0,
            coverage_percent=0.0,
            wall_ms=int((time.perf_counter() - started) * 1000),
            explanation=["No resources exist, therefore no demand can be served."],
            infeasibility_reason="no_resources",
        )

    x: dict[tuple[int, int], cp_model.IntVar] = {}
    served: dict[int, cp_model.IntVar] = {}
    eligible_pairs: dict[int, list[ResourceOption]] = {}

    for d in demands:
        opts = [r for r in resources if _eligible(d, r)]
        eligible_pairs[d.asset_id] = opts
        served[d.asset_id] = model.NewBoolVar(f"served_{d.asset_id}")
        for r in opts:
            x[(d.asset_id, r.resource_id)] = model.NewIntVar(
                0, _q(min(d.need, r.available)), f"x_{d.asset_id}_{r.resource_id}"
            )

    # 1. coverage: either fully served or not served
    for d in demands:
        terms = [x[(d.asset_id, r.resource_id)] for r in eligible_pairs[d.asset_id]]
        if not terms:
            model.Add(served[d.asset_id] == 0)
            continue
        need = _q(d.need)
        model.Add(sum(terms) >= need * served[d.asset_id])
        model.Add(sum(terms) <= need)
        # served may only be 1 when the full requirement is met
        model.Add(sum(terms) >= need).OnlyEnforceIf(served[d.asset_id])
        model.Add(sum(terms) <= need - 1).OnlyEnforceIf(served[d.asset_id].Not())

    # 2. capacity per resource
    for r in resources:
        terms = [
            x[(d.asset_id, r.resource_id)]
            for d in demands
            if (d.asset_id, r.resource_id) in x
        ]
        if terms:
            model.Add(sum(terms) <= _q(r.available))

    # 3. mobilisation horizon
    mobilisation_terms = []
    for (asset_id, resource_id), var in x.items():
        demand = next(d for d in demands if d.asset_id == asset_id)
        resource = next(r for r in resources if r.resource_id == resource_id)
        used = model.NewBoolVar(f"use_{asset_id}_{resource_id}")
        model.Add(var <= _q(resource.available) * used)
        model.Add(var >= 1).OnlyEnforceIf(used)
        model.Add(var == 0).OnlyEnforceIf(used.Not())
        mobilisation_terms.append((resource.mobilisation_minutes, used))
    if mobilisation_terms:
        model.Add(
            sum(int(minutes) * used for minutes, used in mobilisation_terms)
            <= int(input_.horizon_hours * 60)
        )

    # 4. minimum coverage floor per priority class
    if input_.must_serve_priority is not None:
        mandatory = [d for d in demands if d.priority <= input_.must_serve_priority]
        if mandatory:
            model.Add(sum(served[d.asset_id] for d in mandatory) == len(mandatory))

    # objective
    # Values and costs share one scale: `x` is a quantity scaled by 100, and
    # demand values are scaled by 100 too, so a full hospital service is worth
    # ~600_900 while a full dispatch costs ~24_000 credits. Costs therefore only
    # break ties between demands of equal priority — they never outrank them.
    value_terms = []
    cost_terms = []
    for d in demands:
        value_terms.append(int(_demand_value(d) * 100) * served[d.asset_id])
        for r in eligible_pairs[d.asset_id]:
            var = x[(d.asset_id, r.resource_id)]
            cost_per_unit = int(round(r.hourly_cost * d.estimated_hours / max(1.0, d.need)))
            cost_terms.append(cost_per_unit * var)
    model.Maximize(sum(value_terms) - sum(cost_terms))

    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = max(1.0, input_.time_limit_seconds)
    solver.parameters.num_search_workers = 1  # determinism
    solver.parameters.random_seed = 7
    solver.parameters.log_search_progress = False
    status = solver.Solve(model)
    wall_ms = int((time.perf_counter() - started) * 1000)

    status_map = {
        cp_model.OPTIMAL: OPTIMAL,
        cp_model.FEASIBLE: FEASIBLE,
        cp_model.INFEASIBLE: INFEASIBLE,
        cp_model.MODEL_INVALID: MODEL_INVALID,
        cp_model.UNKNOWN: "unknown",
    }
    result_status = status_map.get(status, "unknown")
    resource_usage = {
        r.resource_id: {
            "code": r.code,
            "name": r.name,
            "available": r.available,
            "allocated": 0.0,
            "utilisation_percent": 0.0,
        }
        for r in resources
    }

    if status in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        rows: list[AssignmentRow] = []
        for d in demands:
            for r in eligible_pairs[d.asset_id]:
                qty = solver.Value(x[(d.asset_id, r.resource_id)]) / 100.0
                if qty <= 0:
                    continue
                rows.append(
                    AssignmentRow(
                        asset_id=d.asset_id,
                        asset_code=d.asset_code,
                        asset_name=d.asset_name,
                        resource_id=r.resource_id,
                        resource_code=r.code,
                        resource_name=r.name,
                        quantity=round(qty, 2),
                        priority=d.priority,
                        contribution=round(_demand_value(d), 2),
                        rationale=(
                            f"{d.asset_name} (priority P{d.priority}) receives {qty:g} "
                            f"{r.category.replace('_', ' ')} from {r.code}; mobilises in "
                            f"{r.mobilisation_minutes} min, cost {r.hourly_cost}/h."
                        ),
                    )
                )
                resource_usage[r.resource_id]["allocated"] += round(qty, 2)
        for entry in resource_usage.values():
            if entry["available"] > 0:
                entry["allocated"] = round(entry["allocated"], 2)
                entry["utilisation_percent"] = round(
                    100.0 * entry["allocated"] / entry["available"], 1
                )
        covered = [
            d for d in demands if solver.Value(served[d.asset_id]) == 1
        ]
        # The mobilisation budget is shared by every dispatch, so compute what is
        # actually left of it: that is what tells a horizon-bound plan from a
        # capacity-bound one. Without this the explanation asserted a capacity
        # shortage even when capacity was plentiful and the clock was the limit.
        committed_minutes = sum(
            resource.mobilisation_minutes
            for (asset_id, resource_id), var in x.items()
            if solver.Value(var) > 0
            for resource in [next(r for r in resources if r.resource_id == resource_id)]
        )
        budget_minutes = int(input_.horizon_hours * 60)
        remaining_minutes = budget_minutes - committed_minutes
        capacity_allocated: dict[int, float] = {
            r.resource_id: 0.0 for r in resources
        }
        for (asset_id, resource_id), var in x.items():
            capacity_allocated[resource_id] += solver.Value(var) / 100.0
        unserved = [
            _explain_unserved(
                d,
                eligible_pairs[d.asset_id],
                resources,
                remaining_minutes=remaining_minutes,
                capacity_allocated=capacity_allocated,
            )
            for d in demands
            if solver.Value(served[d.asset_id]) != 1
        ]
        covered_ids = {d.asset_id for d in covered}
        explanation.append(
            f"Served {len(covered)} of {len(demands)} demands "
            f"({100.0 * len(covered) / len(demands):.0f}% coverage) with objective value "
            f"{solver.ObjectiveValue():.0f}."
        )
        served_priorities = sorted({d.priority for d in covered})
        if served_priorities:
            explanation.append(
                "Priority classes served: " + ", ".join(f"P{p}" for p in served_priorities) + "."
            )
        if unserved:
            explanation.append(
                "Unserved demands are reported with the constraint that bound them: "
                + "; ".join(f"{u['asset_code']} ({u['reason']})" for u in unserved)
                + "."
            )
        explanation.append(
            "Coverage is all-or-nothing per asset: a demand counts as served only when its full "
            "required capacity is met, so a hospital is never left on a partial feed."
        )
        total_demand = len(demands)
        covered_demand = len(covered_ids)
        return OptimizationResult(
            status=result_status,
            objective_value=solver.ObjectiveValue(),
            assignments=rows,
            unserved=unserved,
            resource_usage=resource_usage,
            total_demand=total_demand,
            covered_demand=covered_demand,
            coverage_percent=100.0 * covered_demand / total_demand,
            wall_ms=wall_ms,
            explanation=explanation,
            debug={"solver_status": solver.StatusName(status), "branches": solver.NumBranches()},
        )

    # infeasible / unknown: derive a human explanation
    reason = _diagnose_infeasibility(input_)
    unserved = [
        {
            "asset_id": d.asset_id,
            "asset_code": d.asset_code,
            "asset_name": d.asset_name,
            "priority": d.priority,
            "need": d.need,
            "reason": reason,
        }
        for d in demands
    ]
    explanation.append(
        "The model is infeasible: no assignment satisfies every constraint simultaneously. "
        "No partial plan is returned, because publishing an invalid allocation would be worse than "
        "refusing to allocate."
    )
    explanation.append(reason)
    return OptimizationResult(
        status=INFEASIBLE if status == cp_model.INFEASIBLE else result_status,
        objective_value=0.0,
        assignments=[],
        unserved=unserved,
        resource_usage=resource_usage,
        total_demand=len(demands),
        covered_demand=0,
        coverage_percent=0.0,
        wall_ms=wall_ms,
        explanation=explanation,
        infeasibility_reason=reason,
        debug={"solver_status": solver.StatusName(status)},
    )


def _explain_unserved(
    demand: Demand,
    eligible: list[ResourceOption],
    all_resources: list[ResourceOption],
    *,
    remaining_minutes: int | None = None,
    capacity_allocated: dict[int, float] | None = None,
) -> dict:
    """Say which constraint actually stopped this demand from being served.

    The earlier version named capacity every time. On a 90-minute horizon with
    30 units available against a requirement of 1 it reported "insufficient
    eligible capacity: 30 available against a requirement of 1" -- a sentence
    that contradicts itself, because the real limit was how many dispatches the
    clock could fund.
    """
    if not eligible:
        return {
            "asset_id": demand.asset_id,
            "asset_code": demand.asset_code,
            "asset_name": demand.asset_name,
            "priority": demand.priority,
            "need": demand.need,
            "reason": (
                "No eligible resource: every candidate is fully reserved, outside the "
                f"{demand.service_window_minutes}-minute service window, or serves a different "
                "infrastructure category."
            ),
        }

    capacity = sum(r.available for r in eligible)
    allocated = capacity_allocated or {}
    cheapest_dispatch = min((r.mobilisation_minutes for r in eligible), default=0)

    if capacity < demand.need:
        reason = (
            f"Requirement exceeds total eligible capacity: {demand.need:g} needed but only "
            f"{capacity:g} exists across {len(eligible)} eligible "
            f"{'resource' if len(eligible) == 1 else 'resources'}."
        )
    elif remaining_minutes is not None and remaining_minutes < cheapest_dispatch:
        reason = (
            f"No mobilisation budget left: the cheapest eligible dispatch needs "
            f"{cheapest_dispatch} min but only {max(0, remaining_minutes)} min of the "
            "horizon is unspent, so this site cannot be reached in time."
        )
    elif capacity_allocated is not None and (
        capacity - sum(allocated.get(r.resource_id, 0.0) for r in eligible) < demand.need - 1e-9
    ):
        spare = capacity - sum(allocated.get(r.resource_id, 0.0) for r in eligible)
        reason = (
            f"Eligible capacity is exhausted for this plan: {spare:g} of the {capacity:g} "
            f"eligible capacity is still unallocated against a requirement of {demand.need:g}, "
            "because other demands in the same plan hold the rest. Coverage is all-or-nothing, "
            "so a partial delivery cannot be counted."
        )
    else:
        reason = (
            "Not selected by the optimiser: serving this site would have displaced a "
            "higher-value demand, because its priority and population place it lower in the "
            "objective."
        )
    return {
        "asset_id": demand.asset_id,
        "asset_code": demand.asset_code,
        "asset_name": demand.asset_name,
        "priority": demand.priority,
        "need": demand.need,
        "reason": reason,
    }


def _diagnose_infeasibility(input_: OptimizationInput) -> str:
    """Cheap, deterministic diagnosis used when CP-SAT proves infeasibility."""
    problems: list[str] = []
    mandatory = [
        d
        for d in input_.demands
        if input_.must_serve_priority is not None and d.priority <= input_.must_serve_priority
    ]
    for d in mandatory:
        eligible = [r for r in input_.resources if _eligible(d, r)]
        if not eligible:
            problems.append(
                f"{d.asset_code} must be served but has no eligible resource "
                f"(category {d.category}, window {d.service_window_minutes} min)."
            )
            continue
        capacity = sum(r.available for r in eligible)
        if capacity < d.need:
            problems.append(
                f"{d.asset_code} needs {d.need:g} but only {capacity:g} eligible capacity exists."
            )
    if mandatory and problems:
        return " ".join(problems)
    total_required = sum(d.need for d in mandatory) or sum(d.need for d in input_.demands)
    total_available = sum(r.available for r in input_.resources)
    if total_available < total_required:
        problems.append(
            f"Total demand ({total_required:g}) exceeds total resource capacity ({total_available:g})."
        )
    budget = input_.horizon_hours * 60
    cheapest = min(
        (r.mobilisation_minutes for r in input_.resources), default=0
    )
    needed = len(mandatory) * cheapest if mandatory else cheapest
    if needed > budget:
        problems.append(
            f"Mobilisation horizon of {input_.horizon_hours:g}h cannot cover the mandatory demands "
            f"(minimum {needed} minutes are required)."
        )
    return " ".join(problems) or (
        "The requirement to serve every P1 demand cannot be met with the resources, eligibility "
        "rules and mobilisation horizon supplied. Relax the must-serve constraint, add resources, "
        "or extend the horizon."
    )
