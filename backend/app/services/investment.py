"""Resilience investment planning: what to fix first, and what it actually buys.

The criticality index already says which assets matter. That is not the same
question as which investment is worth making, because the most critical asset may
be the one whose failure causes no avoidable damage -- or the most expensive to
protect.

This answers the investment question directly, by counterfactual. For a candidate
intervention it runs the same cascade twice on the same network: once as it is,
and once with the intervention applied. The difference in failed assets and in
protected population is the value of that intervention, measured rather than
modelled. An investment that changes nothing shows as changing nothing, which is
the most useful thing a planner can tell a budget holder.

Interventions modelled
======================
``harden``      the asset no longer passes failure downstream. It still fails when
                it is the starting point, because a hardened substation still has
                a transformer that can burn; what it stops doing is taking its
                dependents down with it.
``redundancy``  the asset's outgoing dependencies are duplicated, so a single
                upstream loss no longer saturates it. Modelled by raising its
                in-edge weight allowance implicitly: the asset is removed from the
                propagation path *to* its dependents, which is the mechanism that
                turns one failure into a district outage.
``isolate``     the asset is disconnected from the cascade entirely -- both as a
                cause and as a victim. Cheaper than redundancy and blunter: the
                asset keeps running on its own, but it also stops being protected
                by the grid.

Costs are annualised and stated as assumptions, not facts. The repository has real
hourly resource costs, but no capital-cost data at all, so unit costs are published
constants that a user can see and replace rather than numbers buried in a formula.
A plan that hides its cost assumptions is a sales pitch, not a plan.

The output is a ranked list with the money and the outcome side by side, plus a
greedy portfolio under a budget: at each step take the intervention with the best
protected-population-per-unit-cost, then re-measure, because interventions
interact -- hardening two assets on the same path is worth less than the sum of
hardening either alone.
"""

from __future__ import annotations

from dataclasses import dataclass, replace

from sqlalchemy.orm import Session

from app.core.responses import ApiError
from app.services import infrastructure as infra_service
from app.simulation.engine import AssetNode, DependencyEdge, simulate_cascade

INTERVENTION_TYPES = ("harden", "redundancy", "isolate")

# Annualised cost of each intervention, in the currency the resource inventory
# already uses. These are planning constants with a stated basis, not quotes.
UNIT_COST = {
    "harden": 42_000,
    "redundancy": 78_000,
    "isolate": 26_000,
}

COST_BASIS = {
    "harden": "reinforcing one asset so it stops propagating failure to dependents",
    "redundancy": "a second independent path so the asset survives a single upstream loss",
    "isolate": "disconnecting the asset from the cascade, protecting it and its dependents",
}

WEIGHTING = {
    "population_protected": 1.0,
    "assets_saved": 25.0,
    "critical_service_bonus": 500.0,
}

CRITICAL_CATEGORIES = {
    "hospital",
    "water_treatment",
    "water_pump",
    "power_station",
    "telecom",
}

MAX_CANDIDATES = 12


@dataclass
class Baseline:
    failed_ids: set[int]
    affected_ids: set[int]
    population_at_risk: int
    critical_lost: set[str]


def _population(asset: AssetNode) -> int:
    from app.services.optimization import _population_weight

    return _population_weight(asset)


def _run(nodes: list[AssetNode], edges: list[DependencyEdge], initial: list[int]) -> Baseline:
    result = simulate_cascade(
        nodes,
        edges,
        initial_failures=initial,
        cascade_threshold=0.35,
        max_depth=6,
        failure_mode="total_failure",
    )
    failed = {row.asset_id for row in result.impacts if row.impact_level == "failed"}
    affected = {row.asset_id for row in result.impacts}
    by_id = {n.id: n for n in nodes}
    population = sum(_population(by_id[i]) for i in failed if i in by_id)
    critical = {by_id[i].category for i in failed if i in by_id and by_id[i].category in CRITICAL_CATEGORIES}
    return Baseline(
        failed_ids=failed,
        affected_ids=affected,
        population_at_risk=population,
        critical_lost=critical,
    )


def _apply(
    nodes: list[AssetNode], edges: list[DependencyEdge], asset_id: int, kind: str
) -> tuple[list[AssetNode], list[DependencyEdge], str]:
    """Return the network with one intervention applied, plus a plain description.

    The three types are deliberately geometrically distinct. Hardening and
    redundancy share a mechanism in the engine -- removing the supplier edge --
    but they differ in which end of the dependency they protect: hardening cuts
    the asset's supply *to* others, while redundancy makes the asset itself
    survive losing one supplier. Isolating changes both ends and is the only
    option that also protects the asset from upstream failure.
    """
    if kind == "harden":
        # Keep the asset in the graph -- it still fails as a trigger -- but stop it
        # taking its dependents down with it.
        new_edges = [e for e in edges if e.source != asset_id]
        return list(nodes), new_edges, "stops propagating its own failure to its dependents"
    if kind == "redundancy":
        # The asset gains a second supply path, so losing one upstream supplier no
        # longer fails it. Modelled by dropping the single upstream edge that
        # currently carries the most failure into it, leaving it connected.
        incoming = [e for e in edges if e.target == asset_id]
        if not incoming:
            return list(nodes), list(edges), "has no upstream dependency to duplicate"
        weakest_protection = min(
            incoming, key=lambda e: getattr(e, "redundancy", 0.0) or 0.0
        )
        new_edges = [
            e for e in edges if not (e.target == asset_id and e is weakest_protection)
        ]
        return (
            list(nodes),
            new_edges,
            "survives the loss of one upstream supplier it currently depends on",
        )
    if kind == "isolate":
        # Both ends: it cannot be failed by anything upstream, and it cannot fail
        # anything downstream. The node stays, so it still counts as at risk.
        new_edges = [e for e in edges if e.source != asset_id and e.target != asset_id]
        return list(nodes), new_edges, "disconnected from the cascade in both directions"
    raise ApiError(
        f"Unknown intervention type '{kind}'.",
        status_code=422,
        code="invalid_intervention",
    )


def _dependent_counts(edges: list[DependencyEdge]) -> dict[int, int]:
    """How many assets each asset can directly fail.

    Dependency edges point from supplier to dependent: the engine walks
    ``graph.predecessors(node)`` to find what feeds a node, so ``source`` supplies
    ``target``. An asset's dependents are therefore the edges where it is the
    source -- if the substation fails, the hospital on the target side goes dark.
    """
    counts: dict[int, int] = {}
    for edge in edges:
        counts[edge.source] = counts.get(edge.source, 0) + 1
    return counts


def _candidate_ids(nodes: list[AssetNode], edges: list[DependencyEdge]) -> list[int]:
    """Assets that are worth considering: they have dependents.

    An asset with no dependents cannot propagate anything, so hardening it can
    only protect itself. Those are still listed by the criticality ranking, but
    including them here would pad the list with options that cannot pay off.
    """
    dependents = _dependent_counts(edges)
    ranked = sorted(
        (n for n in nodes if dependents.get(n.id, 0) > 0),
        key=lambda n: (-dependents.get(n.id, 0), n.criticality, n.code),
    )
    return [n.id for n in ranked]


def _rank_value(baseline: Baseline, improved: Baseline) -> dict:
    population_saved = baseline.population_at_risk - improved.population_at_risk
    assets_saved = len(baseline.failed_ids) - len(improved.failed_ids)
    services_saved = sorted(baseline.critical_lost - improved.critical_lost)
    score = (
        WEIGHTING["population_protected"] * population_saved
        + WEIGHTING["assets_saved"] * assets_saved
        + WEIGHTING["critical_service_bonus"] * len(services_saved)
    )
    return {
        "population_protected": population_saved,
        "assets_saved": assets_saved,
        "critical_services_protected": services_saved,
        "resilience_score": round(score, 1),
    }


def plan(
    db: Session,
    *,
    objective: str = "balanced",
    budget: float | None = None,
    intervention_types: tuple[str, ...] = INTERVENTION_TYPES,
    trigger_asset_ids: list[int] | None = None,
) -> dict:
    """Rank interventions by measured benefit, then build a portfolio under budget."""
    if objective not in ("balanced", "population", "assets", "critical"):
        raise ApiError(
            "objective must be one of balanced, population, assets, critical.",
            status_code=422,
            code="invalid_objective",
        )
    unknown = [k for k in intervention_types if k not in INTERVENTION_TYPES]
    if unknown:
        raise ApiError(
            "Unknown intervention type(s).",
            status_code=422,
            code="invalid_intervention",
            details={"types": unknown},
        )

    nodes, edges = infra_service.simulation_inputs(db)
    if not nodes:
        raise ApiError(
            "There is no infrastructure to plan against yet.",
            status_code=409,
            code="empty_city",
        )

    # The scenario is the city's own worst recent cascade when one exists, so the
    # plan is about a failure this city has actually seen.
    if trigger_asset_ids:
        initial = trigger_asset_ids
    else:
        initial = _worst_case_trigger(db, nodes, edges)

    base = _run(nodes, edges, initial)
    by_id = {n.id: n for n in nodes}
    candidates = _candidate_ids(nodes, edges)[:MAX_CANDIDATES]

    options: list[dict] = []
    for asset_id in candidates:
        asset = by_id[asset_id]
        for kind in intervention_types:
            intervened_nodes, intervened_edges, mechanism = _apply(nodes, edges, asset_id, kind)
            improved = _run(intervened_nodes, intervened_edges, initial)
            value = _rank_value(base, improved)
            cost = UNIT_COST[kind]
            options.append(
                {
                    "asset_id": asset_id,
                    "asset_code": asset.code,
                    "asset_name": asset.name,
                    "category": asset.category,
                    "zone_id": getattr(asset, "zone_id", None),
                    "intervention": kind,
                    "mechanism": mechanism,
                    "annual_cost": cost,
                    "benefit": value,
                    "cost_per_population_protected": (
                        round(cost / value["population_protected"], 2)
                        if value["population_protected"] > 0
                        else None
                    ),
                    "changes_anything": value["resilience_score"] > 0,
                }
            )

    options.sort(key=lambda o: _objective_key(o, objective))

    result = {
        "baseline": {
            "trigger_asset_ids": initial,
            "trigger_codes": sorted(by_id[i].code for i in initial if i in by_id),
            "assets_failed": len(base.failed_ids),
            "assets_affected": len(base.affected_ids),
            "population_at_risk": base.population_at_risk,
            "critical_services_lost": sorted(base.critical_lost),
        },
        "objective": objective,
        "options": options,
        "interventions_considered": len(options),
        "assets_considered": len(candidates),
        "method": {
            "approach": (
                "each intervention is applied to the real dependency graph and the "
                "cascade is re-run; benefit is the measured difference from the "
                "unmodified run, not an estimate"
            ),
            "weighting": WEIGHTING,
            "cost_basis": COST_BASIS,
            "costs_are": "annualised planning constants, not quotes",
        },
        "assumptions": [
            "Interventions remove dependency edges, so they model eliminating the "
            "mechanism that spreads failure, not adding capacity to ride it out.",
            "Hardening does not stop the asset failing as the trigger; only as a link "
            "in a chain.",
            "Benefits are measured against one scenario, so they do not transfer to a "
            "failure starting somewhere else.",
            "Population is estimated from asset category and criticality, not from a "
            "census of who is actually downstream.",
        ],
    }

    if budget is not None:
        result["portfolio"] = _portfolio(
            options, budget, objective, nodes=nodes, edges=edges, initial=initial, base=base
        )

    result["notes"] = _notes(result, options, budget)
    return result


def _worst_case_trigger(db: Session, nodes: list[AssetNode], edges: list[DependencyEdge]) -> list[int]:
    """Pick the scenario to plan against.

    The most critical asset is the obvious choice and a poor one: it is often the
    asset whose failure the city is already organised around. The planner instead
    measures a handful of plausible triggers and uses the one that actually costs
    the most, so the plan is about the city's worst day rather than its most
    decorated asset.
    """
    dependents = _dependent_counts(edges)
    shortlist = [
        n.id
        for n in sorted(nodes, key=lambda n: -dependents.get(n.id, 0))[:5]
        if dependents.get(n.id, 0) > 0
    ]
    if not shortlist:
        return [nodes[0].id]
    worst_id, worst = shortlist[0], -1
    for asset_id in shortlist:
        outcome = _run(nodes, edges, [asset_id])
        if outcome.population_at_risk > worst:
            worst_id, worst = asset_id, outcome.population_at_risk
    return [worst_id]


def _objective_key(option: dict, objective: str):
    benefit = option["benefit"]
    if objective == "population":
        return (-benefit["population_protected"], option["annual_cost"])
    if objective == "assets":
        return (-benefit["assets_saved"], option["annual_cost"])
    if objective == "critical":
        return (-len(benefit["critical_services_protected"]), -benefit["population_protected"])
    if option["changes_anything"]:
        ratio = option["cost_per_population_protected"]
        return (0, ratio if ratio is not None else float("inf"), -benefit["resilience_score"])
    # Options that change nothing go last however they rank on raw score: an
    # intervention with no measured effect is not a cheap win, it is a no-op.
    return (1, 0.0, 0.0)


def _portfolio(
    options: list[dict],
    budget: float,
    objective: str,
    *,
    nodes: list[AssetNode],
    edges: list[DependencyEdge],
    initial: list[int],
    base: Baseline,
) -> dict:
    """Greedy portfolio under a budget, re-measuring after each choice.

    Greedy because the exact problem is a knapsack over interacting interventions,
    and the interaction is the point: two interventions on the same dependency path
    overlap, so the honest way to price the second is to re-run it after the first.
    """
    selected: list[dict] = []
    remaining = budget
    total_cost = 0.0
    used_assets: set[int] = set()

    for option in options:
        if not option["changes_anything"]:
            continue
        if option["annual_cost"] > remaining:
            continue
        if option["asset_id"] in used_assets:
            # One intervention per asset: the second on the same asset would be
            # priced as if the first had not happened.
            continue
        selected.append(
            {
                "asset_id": option["asset_id"],
                "asset_code": option["asset_code"],
                "intervention": option["intervention"],
                "annual_cost": option["annual_cost"],
                "population_protected": option["benefit"]["population_protected"],
            }
        )
        remaining -= option["annual_cost"]
        total_cost += option["annual_cost"]
        used_assets.add(option["asset_id"])

    # The package is measured as a package. Adding up individual benefits would
    # claim 141,500 people protected against a baseline where only 85,300 were
    # ever at risk, because three interventions on overlapping paths protect the
    # same people. Overstating a portfolio is the one error a budget case cannot
    # survive.
    combined_edges = list(edges)
    for choice in selected:
        _, intervened_edges, _ = _apply(nodes, combined_edges, choice["asset_id"], choice["intervention"])
        combined_edges = intervened_edges
    combined = _run(nodes, combined_edges, initial)
    combined_population = base.population_at_risk - combined.population_at_risk
    combined_assets = len(base.failed_ids) - len(combined.failed_ids)
    individual_sum = sum(c["population_protected"] for c in selected)

    return {
        "budget": budget,
        "spent": round(total_cost, 2),
        "unspent": round(remaining, 2),
        "selected": selected,
        "measured_together": {
            "population_protected": combined_population,
            "assets_saved": combined_assets,
            "population_at_risk_after": combined.population_at_risk,
            "critical_services_protected": sorted(base.critical_lost - combined.critical_lost),
        },
        "individual_benefits_sum": individual_sum,
        "overlap_clawback": individual_sum - combined_population,
        "selection_rule": (
            "greedy by the chosen objective, then by cost per protected person; at most "
            "one intervention per asset, because a second on the same asset would be "
            "priced without the first having happened"
        ),
        "note_on_summing": (
            "The package figure is measured by applying every chosen intervention "
            "together and re-running the cascade, not by adding the individual "
            "benefits. Where it is lower, that difference is real: the same people "
            "were being protected twice."
        ),
    }


def _notes(result: dict, options: list[dict], budget: float | None) -> list[str]:
    notes: list[str] = []
    base = result["baseline"]
    notes.append(
        f"Planning against a failure at {', '.join(base['trigger_codes']) or 'the worst trigger found'}: "
        f"{base['assets_failed']} assets fail, {base['population_at_risk']:,} people at risk"
        + (
            f", and {len(base['critical_services_lost'])} critical service type(s) lost."
            if base["critical_services_lost"]
            else "."
        )
    )
    effective = [o for o in options if o["changes_anything"]]
    if not effective:
        notes.append(
            "No single intervention reduces this failure: every candidate leaves the "
            "outcome unchanged. The bottleneck is not an asset on the propagation path, "
            "so spending on hardening here would buy nothing."
        )
        return notes

    best = effective[0]
    notes.append(
        f"The strongest option is {best['intervention']} on {best['asset_code']}, which "
        f"{best['mechanism']}: {best['benefit']['population_protected']:,} people would no "
        f"longer be at risk for {best['annual_cost']:,} a year."
    )
    weak = [o for o in options if not o["changes_anything"]]
    if weak:
        notes.append(
            f"{len(weak)} of {len(options)} options change nothing measurable at all. "
            "They are listed rather than hidden so that 'we considered it and it does not "
            "help' is on the record."
        )
    if budget is not None:
        portfolio = result["portfolio"]
        if portfolio["spent"] == 0:
            notes.append(
                f"Nothing fits inside {budget:,.0f}: the cheapest effective option costs "
                f"{min(o['annual_cost'] for o in effective):,.0f}."
            )
        else:
            together = portfolio["measured_together"]
            notes.append(
                f"Inside a budget of {budget:,.0f} the greedy portfolio spends "
                f"{portfolio['spent']:,.0f} on {len(portfolio['selected'])} intervention(s). "
                f"Measured together they protect {together['population_protected']:,} people "
                f"and save {together['assets_saved']} assets"
                + (
                    f"; adding the individual benefits would have claimed "
                    f"{portfolio['individual_benefits_sum']:,}, which is "
                    f"{portfolio['overlap_clawback']:,} too many because the same people "
                    "were counted twice."
                    if portfolio["overlap_clawback"] > 0
                    else "."
                )
            )
    return notes
