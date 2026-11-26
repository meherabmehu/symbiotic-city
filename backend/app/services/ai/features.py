"""Deterministic building blocks for the five AI features.

Everything here runs WITHOUT a model: rule-based fallbacks (clearly labelled
by the routes), the rule-based what-if text extractor used when no key is
configured or the model's JSON is unusable, and the context dumps that get
fenced as untrusted data before they reach a prompt.
"""

from __future__ import annotations

import json
import re
from typing import Any, Iterable, Mapping

from .prompts import untrusted

FAILURE_MODES = ("total_failure", "capacity_loss", "maintenance")

_CODE_RE = re.compile(r"\b([A-Z]{2,4}-\d{2})\b")
_THRESHOLD_RE = re.compile(r"threshold\D{0,20}(0?\.\d{1,3}|\b\d{2,3}%\b)", re.IGNORECASE)
_DEPTH_RE = re.compile(r"depth\D{0,10}(\d{1,2})", re.IGNORECASE)
_SEED_RE = re.compile(r"seed\D{0,10}(\d{1,10})", re.IGNORECASE)


# ------------------------------------------------------------------ citations


def citation(entity_type: str, entity_id: Any, label: str, snippet: str = "") -> dict:
    return {
        "entity_type": entity_type,
        "entity_id": entity_id,
        "label": label,
        "snippet": snippet[:240],
    }


# ------------------------------------------------------- grounded terminology

# The simulation engine owns these thresholds (app.simulation.engine.severity_label).
# They are restated here only so a prompt can quote them verbatim instead of a
# model inventing a band. Keep them in step with that function -- the test suite
# asserts the two agree at every boundary.
SEVERITY_BAND_TEXT = "critical >= 75, high >= 50, medium >= 25, low < 25"

SIMULATION_DEFINITIONS = {
    "initially_injected_asset_codes": (
        "the assets the operator hypothesised as failing; inputs, not results"
    ),
    "downstream_cascading_failure_codes": (
        "assets the engine propagated to FAILED from those inputs"
    ),
    "total_failed_assets": "every asset the engine marked failed, inputs included",
    "operational_but_impacted_assets": (
        "assets the engine marked degraded or affected; they are NOT failed"
    ),
    "total_impacted_assets_including_failures": (
        "assets_impacted from the engine: failures plus degraded/affected, so this "
        "already contains total_failed_assets"
    ),
    "critical_services_down": "codes of failed assets in core critical categories",
    "asset_codes": "identifiers, never failure categories or failure modes",
    "failure_mode": "one of total_failure, capacity_loss, maintenance",
}


def severity_band(score: Any) -> dict[str, Any]:
    """The platform's own severity band for a computed severity index.

    A single source of truth: ``app.simulation.engine.severity_label``. The AI
    features may quote a band because the platform computed it; they may never
    derive one themselves.
    """
    from app.simulation.engine import severity_label

    try:
        value = float(score or 0.0)
    except (TypeError, ValueError):
        value = 0.0
    return {
        "index": value,
        "band": severity_label(value),
        "thresholds": SEVERITY_BAND_TEXT,
        "source": "app.simulation.engine.severity_label",
    }


def solver_status_meaning(status: str) -> str:
    """What CP-SAT's saved status does and does not establish.

    'feasible' is emphatically not 'optimal': a feasible solution satisfies
    every encoded constraint, while optimal means the solver proved no better
    objective value exists inside that model.
    """
    normalised = (status or "").strip().lower()
    if normalised == "optimal":
        return (
            "The solver proved this saved solution optimal for the encoded model. "
            "Optimal is still model-relative: it says nothing about reality beyond "
            "the constraints that were encoded."
        )
    if normalised == "feasible":
        return (
            "The solver proved this saved solution FEASIBLE only: it satisfies every "
            "encoded constraint, but global optimality was NOT proven and a better "
            "solution may exist within the same model."
        )
    if normalised == "infeasible":
        return (
            "The solver proved the encoded model INFEASIBLE: no assignment satisfies "
            "all encoded constraints, so no plan exists under them."
        )
    return (
        f"The stored solver status is '{status}', which does not establish optimality; "
        "describe only what the saved record contains."
    )


# ------------------------------------------------------------- context fences


def fenced_block(title: str, rows: Iterable[Mapping[str, Any]]) -> str:
    payload = "\n".join(json.dumps(dict(row), default=str, ensure_ascii=False) for row in rows)
    return untrusted(title, payload) if payload else ""


# --------------------------------------------------------- rule-based fallbacks


def copilot_fallback(
    lang: str,
    citations: list[dict],
    has_matches: bool,
    reason: str = "no LLM key is configured",
) -> str:
    """What the copilot says when no model phrased the answer: retrieval still
    works, the answer is honestly a pointer to it, not a simulated model reply.

    ``reason`` states why the deterministic path ran, so a discarded or failed
    model answer never masquerades as "no key configured".
    """
    if lang == "bn":
        if not has_matches:
            return (
                "এই প্রশ্নের সাথে মেলে এমন রেকর্ড পাওয়া যায়নি। সম্পাদক বা সম্পদের "
                f"কোড দিয়ে আবার চেষ্টা করুন। (নিয়মভিত্তিক উত্তর — {reason}।)"
            )
        listed = "، ".join(c["label"] for c in citations[:5])
        return (
            f"আপনার প্রশ্নের সাথে মিলে এমন রেকর্ড পাওয়া গেছে: {listed}। "
            "বিস্তারিত দেখতে উদ্ধৃত সত্তাগুলো খুলুন। "
            f"(নিয়মভিত্তিক উত্তর — {reason}।)"
        )
    if not has_matches:
        return (
            "I could not find records matching that question. Try naming an "
            "asset code (for example PS-01) or an incident reference. "
            f"(Rule-based response -- {reason}.)"
        )
    listed = ", ".join(c["label"] for c in citations[:5])
    return (
        f"Records matching your question: {listed}. Open the cited entities for "
        f"full detail. (Rule-based response -- {reason}.)"
    )


def incident_fallback(
    lang: str,
    incident: Mapping[str, Any],
    asset_label: str,
    reason: str = "no LLM key is configured",
) -> str:
    status = incident.get("status", "unknown")
    severity = incident.get("severity", "unknown")
    category = incident.get("category", "unknown")
    if lang == "bn":
        return (
            f"নিয়মভিত্তিক ব্যাখ্যা: {asset_label} — {category} বিভাগে "
            f"{severity} তীব্রতার ঘটনা, বর্তমান অবস্থা {status}। "
            "প্রথমে ঘটনার কারণ যাচাই করুন, তারপর সংযুক্ত সম্পদের অবস্থা দেখুন এবং "
            f"প্রয়োজনে মেরামত টাস্ক খুলুন। (নিয়মভিত্তিক — {reason}।)"
        )
    return (
        f"Rule-based explanation: a {severity} {category} incident on {asset_label} "
        f"is currently '{status}'. Verify the triggering signal, check the asset's "
        "dependencies, and open a repair task if the asset stays degraded. "
        f"(Rule-based -- {reason}.)"
    )


def plan_fallback(plan: Mapping[str, Any], reason: str = "no LLM key is configured") -> str:
    status = str(plan.get("solution_status", "unknown"))
    covered = plan.get("covered_demand", 0)
    total = plan.get("total_demand", 0)
    objective = plan.get("objective_value", 0)
    assignments = plan.get("assignments") or []
    explanation = plan.get("explanation") or {}
    constraints = explanation.get("constraints") or {}
    lines = [
        f"Rule-based read-out of solver plan {plan.get('code', '?')}:",
        f"- Solver status: {status}.",
        f"- {solver_status_meaning(status)}",
        f"- Coverage: {covered} of {total} demand units ({plan.get('coverage_percent', 0)}%).",
        f"- Objective value reported by CP-SAT: {objective}. It is a solver score for "
        "the encoded model, not proof that a business objective was maximised.",
    ]
    if plan.get("infeasibility_reason"):
        lines.append(f"- Infeasibility reason: {plan['infeasibility_reason']}.")
    if constraints:
        recorded = ", ".join(f"{key}={value}" for key, value in constraints.items())
        lines.append(f"- Encoded constraints recorded with the request: {recorded}.")
    if assignments:
        lines.append(f"- All {len(assignments)} saved assignments:")
        for item in assignments:
            lines.append(
                f"  {item.get('asset_code', item.get('asset_id'))} — "
                f"{item.get('asset_name', 'asset')} receives {item.get('quantity')} from "
                f"{item.get('resource_code', item.get('resource_id'))} — "
                f"{item.get('resource_name', 'resource')}."
            )
    lines.append(
        "The solver's own answer stands; this text only narrates the saved record. "
        f"(Rule-based -- {reason}.)"
    )
    return "\n".join(lines)


def report_fallback(stats: Mapping[str, Any], reason: str = "no LLM key is configured") -> str:
    """The resilience report's deterministic body -- same figures the API
    computed, phrased once. The LLM path may rephrase but may not recompute.

    Incident claims come only from ``active_incident_records``; criticality
    ranks are printed as ranks and explicitly not as incidents.
    """
    critical = stats.get("criticality", {})
    lines = [
        "SYMBIOTIC CITY — Resilience report (rule-based)",
        "",
        f"Assets in scope: {stats.get('assets_total', 0)}.",
        f"Active incidents: {stats.get('active_incidents', 0)} "
        f"({stats.get('incidents_reported_30d', 0)} reported in the last 30 days).",
        f"Open repair tasks: {stats.get('open_tasks', 0)}.",
    ]
    if critical.get("critical_assets") is not None:
        lines.append(
            f"Critical assets (priority scoring): {critical['critical_assets']} "
            f"of {critical.get('total', 0)} scored."
        )
    incidents = stats.get("active_incident_records", [])
    if incidents:
        lines.append("Current incidents (recorded, status not resolved/closed):")
        for row in incidents:
            lines.append(
                f"- {row['code']} — {row['title']} · primary asset "
                f"{row['primary_asset_code']} — {row['primary_asset_name']} "
                f"({row['status']})."
            )
    else:
        lines.append("Current incidents: none recorded.")
    for row in stats.get("top_risks", [])[:3]:
        lines.append(
            f"- Criticality ranking #{row.get('rank', '?')}: {row['label']} — "
            f"{row['reason']}. This is a ranking only, not an incident claim."
        )
    lines.append(
        "Figures are computed by the platform; this wording is rule-based "
        f"(rule-based -- {reason})."
    )
    return "\n".join(lines)


# ------------------------------------------------- what-if rule-based extraction


def extract_rule_based(text: str) -> dict[str, Any]:
    """Parse a failure hypothesis without a model: asset codes, failure mode,
    threshold, depth, seed, and a name assembled from the sentence."""
    codes = list(dict.fromkeys(_CODE_RE.findall(text)))
    mode = next((m for m in FAILURE_MODES if m.replace("_", " ") in text.lower() or m in text.lower()), None)

    threshold: float | None = None
    match = _THRESHOLD_RE.search(text)
    if match:
        raw = match.group(1)
        value = float(raw[:-1]) / 100 if raw.endswith("%") else float(raw)
        threshold = value

    depth_match = _DEPTH_RE.search(text)
    seed_match = _SEED_RE.search(text)

    name = " ".join(text.strip().split()[:8])[:120] or "Extracted scenario"
    if len(name) < 3:
        name = "Extracted scenario"

    return {
        "failure_codes": codes,
        "failure_mode": mode or "total_failure",
        "cascade_threshold": threshold,
        "max_depth": int(depth_match.group(1)) if depth_match else None,
        "random_seed": int(seed_match.group(1)) if seed_match else None,
        "name": name,
        "description": text.strip()[:1000],
    }


def coerce_extracted_json(raw: str) -> dict[str, Any] | None:
    """Accept a model's JSON object, tolerating code fences and leading prose."""
    candidate = raw.strip()
    if candidate.startswith("```"):
        candidate = re.sub(r"^```[a-zA-Z]*\n?", "", candidate)
        candidate = re.sub(r"\n?```$", "", candidate)
    start = candidate.find("{")
    end = candidate.rfind("}")
    if start == -1 or end <= start:
        return None
    try:
        parsed = json.loads(candidate[start : end + 1])
    except json.JSONDecodeError:
        return None
    return parsed if isinstance(parsed, dict) else None
