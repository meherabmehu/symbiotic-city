"""Multi-objective recovery planning: show the trade-off instead of asserting it.

The existing optimiser answers one question well -- "serve the most critical
demands, break ties on cost" -- because that is the dispatch rule the city uses.
But a coordinator about to spend a night moving generators across the city is
making a trade-off, not applying a rule: protecting this hospital may mean three
clinics stay dark. A single optimum hides the alternatives it rejected.

This runs the same CP-SAT model several times under explicit weightings, then
reports only the plans that are not dominated: a plan survives only if no other
plan is at least as good on *every* objective and strictly better on one. What is
left is the trade-off frontier, and every plan on it is a defensible answer --
choosing between them is a judgement for the coordinator, not something a solver
should decide silently.

Three objectives, each measured from the resulting plan rather than assumed:

* **criticality** -- priority-weighted value of the demands fully served. A
  hospital counts far more than a depot, exponentially so.
* **coverage** -- number of demands fully served. This is what separates "protect
  the two worst-affected places" from "restore service as widely as possible".
* **cost** -- mobilisation cost of the chosen assignments.

The search is honest about its limits. It is weighted-sum exploration, so it can
only find supported points on a non-convex frontier; the result says so rather
than claiming completeness. And when one plan dominates all others it says that
too -- a clean answer is information, not a failure.
"""

from __future__ import annotations

from dataclasses import dataclass

from app.optimization.engine import (
    OPTIMAL,
    PRIORITY_WEIGHTS,
    OptimizationInput,
    OptimizationResult,
    optimize,
)



OBJECTIVES = ("criticality", "coverage", "cost")

# How many coverage requirements to try. Each one is a full solve.
MAX_LEVELS = 6


@dataclass
class Plan:
    """One optimised plan with its measured objectives."""

    direction: str
    result: OptimizationResult
    criticality: float
    coverage: float
    cost: float
    served_codes: list[str]
    served_population: int
    bands: dict[str, str]

    def signature(self) -> tuple:
        """Identity of the *decision*, not of the solver run.

        Two weightings that choose the same assets are the same plan, however
        differently they got there.
        """
        return tuple(sorted(self.served_codes))

    def as_dict(self, *, detailed: bool = False) -> dict:
        payload = {
            "direction": self.direction,
            "objectives": {
                "criticality": round(self.criticality, 3),
                "coverage": self.coverage,
                "cost": round(self.cost, 2),
            },
            "bands": self.bands,
            "status": self.result.status,
            "covered_demand": self.result.covered_demand,
            "total_demand": self.result.total_demand,
            "coverage_percent": round(self.result.coverage_percent, 1),
            "served_assets": self.served_codes,
            "served_population": self.served_population,
            "unserved_count": len(self.result.unserved),
            "wall_ms": self.result.wall_ms,
        }
        if detailed:
            payload["assignments"] = [a.as_dict() for a in self.result.assignments]
            payload["unserved"] = self.result.unserved
            payload["resource_usage"] = {str(k): v for k, v in self.result.resource_usage.items()}
            payload["explanation"] = self.result.explanation
        return payload


def _priority_value(priority: int) -> int:
    return PRIORITY_WEIGHTS.get(priority, 1)


def _measure(input_: OptimizationInput, result: OptimizationResult) -> dict:
    """Read the three objectives off a finished plan.

    Value is only credited for *fully* served demands, matching the model's
    all-or-nothing coverage rule: a partially powered hospital is not a
    delivered outcome, so it must not earn partial credit here either.
    """
    covered = {a.asset_id for a in result.assignments}
    # A demand is served only if the result says so; assignments exist for
    # unserved demands too (they may carry a partial quantity).
    served_ids = {
        d.asset_id
        for d in input_.demands
        if d.asset_id not in {u["asset_id"] for u in result.unserved}
    }
    by_id = {d.asset_id: d for d in input_.demands}

    criticality = 0.0
    for asset_id in served_ids:
        demand = by_id[asset_id]
        criticality += _priority_value(demand.priority) * 100.0 + demand.population / 100.0

    cost = sum(
        next(r.hourly_cost for r in input_.resources if r.resource_id == row.resource_id)
        * row.quantity
        * by_id[row.asset_id].estimated_hours
        / max(1.0, by_id[row.asset_id].need)
        for row in result.assignments
        if row.asset_id in served_ids
    )
    population = sum(by_id[i].population for i in served_ids)
    return {
        "criticality": criticality,
        "coverage": float(len(served_ids)),
        "cost": float(round(cost, 2)),
        "served_codes": sorted(by_id[i].asset_code for i in served_ids),
        "served_population": population,
        "assigned": len(covered),
    }


def _dominates(a: Plan, b: Plan, *, tolerance: float = 1e-6) -> bool:
    """True when ``a`` is at least as good as ``b`` everywhere and better once."""
    better = False
    for objective in OBJECTIVES:
        av, bv = getattr(a, objective), getattr(b, objective)
        # cost is minimised; everything else is maximised
        if objective == "cost":
            if av > bv + tolerance:
                return False
            if av < bv - tolerance:
                better = True
        else:
            if av < bv - tolerance:
                return False
            if av > bv + tolerance:
                better = True
    return better


def _bands(plans: list[Plan]) -> None:
    """Label each plan's position on each objective, for reading not sorting."""
    for objective in OBJECTIVES:
        values = [getattr(p, objective) for p in plans]
        low, high = min(values), max(values)
        for plan in plans:
            value = getattr(plan, objective)
            if high - low <= 1e-9:
                plan.bands[objective] = "only"
            elif abs(value - low) < 1e-9:
                plan.bands[objective] = "low" if objective != "cost" else "cheapest"
            elif abs(value - high) < 1e-9:
                plan.bands[objective] = "high" if objective != "cost" else "dearest"
            else:
                plan.bands[objective] = "middle"


def search(
    input_: OptimizationInput,
    *,
    coverage_floor: bool = True,
) -> dict:
    """Sweep the coverage requirement and keep the plans that survive.

    Weighted sums were tried first and rejected. Mixing "value of a served
    hospital" with "number of served sites" under one weight means a plan that
    serves more sites can score worse than one that serves fewer, and the
    pure-cost direction degenerates to doing nothing at all -- which is optimal
    and useless, because saving money by serving nobody always wins.

    A lexicographic sweep avoids both problems. For each coverage level the
    solver maximises the documented objective (criticality, cost as tie-break)
    subject to "serve at least this many demands". That is a feasibility
    constraint, so every point on the frontier is guaranteed to serve the sites
    it claims, and the trade-off between width and criticality is measured
    rather than assumed.

    Doing nothing is never offered. A plan that serves no demand restores no
    service; presenting it as an option would be presenting the absence of a
    decision as a decision.
    """
    demands = input_.demands
    total = len(demands)
    if total == 0:
        return {
            "frontier": [],
            "explored": 0,
            "directions_run": 0,
            "skipped": [{"direction": "coverage-0", "status": "no_demands"}],
            "solver_ms": 0,
            "dominated": {},
            "notes": _notes([], [], []),
        }

    # A ceiling on solver calls: the sweep is one per level, and a long list of
    # demands must not turn a page load into a batch job. Six levels costs about
    # six seconds, because the engine floors each solve at one second to keep
    # results reproducible; that is reported back as wall_ms rather than hidden.
    max_levels = MAX_LEVELS
    levels = sorted({max(1, round(total * i / min(total, max_levels))) for i in range(1, min(total, max_levels) + 1)})
    if levels and levels[-1] != total:
        levels.append(total)
    if not coverage_floor:
        levels = [None]  # type: ignore[list-item]

    plans: list[Plan] = []
    seen: dict[tuple, Plan] = {}
    skipped: list[dict] = []

    for level in levels:
        label = f"coverage-{level}" if level is not None else "unconstrained"
        attempt = OptimizationInput(
            demands=demands,
            resources=input_.resources,
            horizon_hours=input_.horizon_hours,
            must_serve_priority=input_.must_serve_priority,
            max_assignments_per_demand=input_.max_assignments_per_demand,
            # One second per solve: the engine floor. Longer budgets found the same
            # frontier in measurement, so asking for more only makes the page wait.
            time_limit_seconds=1.0,
            objective_weights=input_.objective_weights,
            min_coverage=level,
        )
        result = optimize(attempt)
        if result.status not in (OPTIMAL, "feasible"):
            skipped.append(
                {
                    "direction": label,
                    "status": result.status,
                    "requested_coverage": level,
                    "explanation": (result.explanation or [""])[-1][:240],
                }
            )
            continue
        measured = _measure(input_, result)
        if measured["coverage"] <= 0:
            skipped.append(
                {
                    "direction": label,
                    "status": "serves_nothing",
                    "requested_coverage": level,
                }
            )
            continue
        plan = Plan(
            direction=label,
            result=result,
            criticality=measured["criticality"],
            coverage=measured["coverage"],
            cost=measured["cost"],
            served_codes=measured["served_codes"],
            served_population=measured["served_population"],
            bands={},
        )
        # Two plans serving the same number of demands are the same answer to the
        # question the sweep asks; keep the better one rather than show a tie that
        # is really solver jitter between runs.
        same_width = next(
            (existing for existing in plans if int(existing.coverage) == int(plan.coverage)),
            None,
        )
        if same_width is not None:
            if plan.criticality > same_width.criticality:
                plans.remove(same_width)
                seen.pop(same_width.signature(), None)
            else:
                skipped.append(
                    {
                        "direction": label,
                        "status": "weaker_at_same_coverage",
                        "requested_coverage": level,
                        "kept": f"serve {int(same_width.coverage)} of {total}",
                    }
                )
                continue
        signature = plan.signature()
        if signature in seen:
            skipped.append(
                {
                    "direction": label,
                    "status": "duplicate",
                    "same_as": seen[signature].direction,
                }
            )
            continue
        seen[signature] = plan
        plans.append(plan)

    frontier = [
        p for p in plans if not any(_dominates(other, p) for other in plans if other is not p)
    ]
    frontier.sort(key=lambda p: (-p.coverage, -p.criticality, p.cost))
    for plan in frontier:
        plan.bands = {}
        # Name the plan by the decision it represents. "coverage-5" describes the
        # constraint; a coordinator needs to read the plan.
        plan.direction = f"serve {int(plan.coverage)} of {total}"
    _bands(frontier)

    dominated = {
        p.direction: {
            "served_assets": p.served_codes,
            "objectives": {
                "criticality": round(p.criticality, 3),
                "coverage": p.coverage,
                "cost": round(p.cost, 2),
            },
            "dominated_by": next(
                (
                    f"serve {int(other.coverage)} of {total}"
                    for other in plans
                    if other is not p and _dominates(other, p)
                ),
                None,
            ),
        }
        for p in plans
        if p not in frontier
    }

    return {
        "frontier": frontier,
        "explored": len(plans) + len([s for s in skipped if s["status"] == "duplicate"]),
        "directions_run": len(levels),
        "solver_ms": sum(p.result.wall_ms for p in plans),
        "skipped": skipped,
        "dominated": dominated,
        "notes": _notes(frontier, plans, skipped),
    }


def _notes(frontier: list[Plan], all_plans: list[Plan], skipped: list[dict]) -> list[str]:
    """State what the frontier does and does not prove."""
    notes: list[str] = []
    if not frontier:
        notes.append(
            "No feasible plan was found that serves any demand, so there is no "
            "trade-off to show. Every alternative here restores nothing; the "
            "single-plan optimiser reports which constraint is binding."
        )
        return notes

    if len(frontier) == 1:
        plan = frontier[0]
        unreachable = [s for s in skipped if s.get("requested_coverage") and s["status"] != "duplicate"]
        if unreachable:
            highest = max(s["requested_coverage"] for s in unreachable)
            notes.append(
                f"One plan survives comparison: it serves {plan.result.covered_demand} "
                f"demands for {plan.cost:,.0f}. Serving {highest} was not achievable with "
                "the resources, eligibility rules and mobilisation horizon supplied, so the "
                "narrower plan is not a preference -- it is the most that fits."
            )
        else:
            notes.append(
                f"One plan is best on every objective at once: serving "
                f"{plan.result.covered_demand} of {plan.result.total_demand} demands for "
                f"{plan.cost:,.0f}. There is no trade-off to make here; the alternatives "
                "were worse on at least one measure and no better on any."
            )
    else:
        notes.append(
            f"{len(frontier)} of {len(all_plans)} distinct plans are not dominated by any "
            "other: each is the best available answer for some amount of coverage, so which "
            "one is right depends on how much the city is prepared to restore and how much "
            "it is prepared to spend."
        )
        widest = max(frontier, key=lambda p: (p.coverage, p.criticality))
        sharpest = max(frontier, key=lambda p: (p.criticality, p.coverage))
        if widest is not sharpest:
            notes.append(
                f"The widest plan restores {widest.result.covered_demand} demands and "
                f"protects {widest.served_population:,} people; the most criticality-heavy "
                f"restores {sharpest.result.covered_demand} and protects "
                f"{sharpest.served_population:,}. Restoring more sites means serving lower "
                "priority demands with capacity the critical ones needed."
            )

    cheapest = min(frontier, key=lambda p: p.cost)
    dearest = max(frontier, key=lambda p: p.cost)
    if dearest.cost > cheapest.cost + 1e-6:
        extra_cost = dearest.cost - cheapest.cost
        gain = dearest.criticality - cheapest.criticality
        if gain >= 0:
            trade = f"buys {gain:,.0f} more weighted criticality"
        else:
            # Paying more for less criticality is legitimate -- it buys width --
            # but it must be stated as such, not disguised as a gain.
            trade = (
                f"buys {abs(gain):,.0f} less weighted criticality, and "
                f"{dearest.coverage - cheapest.coverage:+.0f} more restored sites"
            )
        notes.append(
            f"Moving from the cheapest plan ({cheapest.direction}, {cheapest.cost:,.0f}) to "
            f"the most expensive ({dearest.direction}, {dearest.cost:,.0f}) costs "
            f"{extra_cost:,.0f} more and {trade}. That exchange rate is the number worth "
            "arguing about."
        )

    duplicates = [s for s in skipped if s["status"] == "duplicate"]
    if duplicates:
        notes.append(
            f"{len(duplicates)} coverage requirement(s) produced a plan already on the "
            "frontier; they are recorded as duplicates rather than shown as separate "
            "options, because two labels for one decision is a false choice."
        )
    infeasible = [s for s in skipped if s["status"] not in ("duplicate", "serves_nothing", "weaker_at_same_coverage")]
    if infeasible:
        notes.append(
            f"{len(infeasible)} coverage requirement(s) could not be met at all and are "
            "omitted rather than approximated: "
            + ", ".join(sorted({str(s.get("requested_coverage")) for s in infeasible}))
            + ". A plan that claims to serve a site it cannot supply would be worse than "
            "one that says it cannot."
        )
    same_width = [s for s in skipped if s["status"] == "weaker_at_same_coverage"]
    if same_width:
        notes.append(
            f"{len(same_width)} solve(s) reached the same number of sites with a weaker "
            "plan for that width; only the stronger one is shown, so two labels never "
            "describe the same choice."
        )
    notes.append(
        "Coverage is treated as a requirement and criticality as the thing to maximise "
        "within it. That finds the best plan at each achievable width, but it cannot "
        "prove no better plan exists off this frontier."
    )
    return notes
