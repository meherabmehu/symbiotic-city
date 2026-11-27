"""The five AI features, server-side.

Shared contract for every endpoint here:

* Read-only by construction: endpoints read the database and return text.
  The one exception is /ai/whatif/extract, which runs the *existing*
  what-if create+run path under the caller's own `resilience:plan`
  permission -- the model only parses the sentence; the user performs the
  action, exactly as they would through the manual form.
* RBAC-scoped retrieval: copilot categories are queried only when the caller
  holds that category's read permission, and one-off entities (incident,
  plan) go through the same permission gates as their normal pages.
* Every reply carries `provider`: "LLM (Groq)" for model output,
  "rule-based (...)" for the deterministic fallbacks -- never blended,
  never claimed the other way.
* Retrieved rows reach the prompt only inside untrusted fences
  (app.services.ai.prompts), and the per-user rate limit below stops one
  session from consuming the free-tier quota.
"""

from __future__ import annotations

import logging
import re
import threading
import time
from collections import deque
from dataclasses import dataclass
from typing import Any

from fastapi import APIRouter, Depends
from sqlalchemy import func, or_, select

from app.api.deps import CurrentUser, DbSession, require_any_permission, require_permissions
from app.core.responses import ApiError, ok
from app.models.infrastructure import InfrastructureAsset as Asset
from app.models.operations import Incident, RepairTask
from app.models.optimization import OptimizationPlan
from app.schemas.ai import (
    CommanderRequest,
    CopilotRequest,
    IncidentExplainRequest,
    PlanExplainRequest,
    ResilienceReportRequest,
    ScenarioCompareRequest,
    WhatIfExtractRequest,
)
from app.services.ai import SYSTEM_GUARD, get_provider, provider_label, untrusted
from app.services.ai import decision as ai_decision
from app.services.ai import features as ai_features
from app.services.ai.provider import AiError, AiReply, AiTruncated

logger = logging.getLogger("symbiotic.ai")

router = APIRouter(tags=["ai"])

# --------------------------------------------------------------- rate limiting
# One window per user, in-process: enough to stop a runaway loop from burning
# the free tier, small enough to need no infrastructure. Not a security
# boundary -- the provider's own 429 is the backstop and is never retried.

_AI_WINDOW_SECONDS = 60.0
_AI_MAX_CALLS = 12
_ai_hits: dict[int, deque[float]] = {}
_ai_lock = threading.Lock()


def _rate_limit(user_id: int) -> None:
    now = time.monotonic()
    with _ai_lock:
        hits = _ai_hits.setdefault(user_id, deque())
        while hits and now - hits[0] > _AI_WINDOW_SECONDS:
            hits.popleft()
        if len(hits) >= _AI_MAX_CALLS:
            raise ApiError(
                "You have reached the AI request limit for this minute; try again shortly.",
                status_code=429,
                code="ai_rate_limited",
            )
        hits.append(now)


# ----------------------------------------------------------------- LLM seam
# get_provider is looked up on this module so tests can swap it in one place.

# Shown next to a deterministic fallback when the reason is *not* "no key".
# The provider label alone cannot say why the model was not used, and an
# operator reading a fallback must be told what happened to the model answer.
TRUNCATED_NOTICE = (
    "The model hit its output-token limit, so its partial answer was discarded "
    "rather than displayed as if it were complete. The text below is the "
    "platform's complete, deterministic summary of the same records."
)
UNAVAILABLE_NOTICE = (
    "The AI provider did not answer (error, timeout or rate limit), so the text "
    "below is the platform's complete, deterministic summary of the same records."
)


@dataclass(frozen=True)
class ChatOutcome:
    """Result of one model attempt: text, honest label, and why it fell back.

    ``text`` is None whenever the deterministic path must supply the answer.
    ``truncated`` is what separates "the model was cut off" from "the model
    was never asked" -- both must be visible, neither may be implied.
    """

    text: str | None
    label: str
    truncated: bool = False
    notice: str | None = None
    finish_reason: str | None = None

    def payload(self) -> dict[str, Any]:
        return {
            "provider": self.label,
            "truncated": self.truncated,
            "notice": self.notice,
        }


def fallback_reason(outcome: ChatOutcome) -> str:
    """One phrase explaining *why* the deterministic text is the answer.

    Never "no LLM key is configured" unless that is actually the reason.
    """
    if outcome.truncated:
        return "the model's answer was cut off at its token limit and discarded"
    if outcome.finish_reason == "grounding_rejected":
        return "the model's draft failed grounding checks"
    if outcome.finish_reason == "error":
        return "the AI provider was unavailable"
    return "no LLM key is configured"


async def _chat(
    messages: list[dict[str, str]], *, max_tokens: int = 700
) -> ChatOutcome:
    """Call the provider; never raise. Fall back with an honest, explicit reason."""
    provider = get_provider()
    if provider is None:
        return ChatOutcome(
            text=None,
            label=provider_label(has_key=False),
            finish_reason="no_key",
        )
    try:
        reply: AiReply = await provider.chat(messages, max_tokens=max_tokens)
    except AiTruncated:
        logger.info("AI reply discarded mid-sentence: provider hit its token limit")
        return ChatOutcome(
            text=None,
            label="rule-based (incomplete AI response discarded)",
            truncated=True,
            notice=TRUNCATED_NOTICE,
            finish_reason="length",
        )
    except AiError as exc:
        logger.info("AI reply unavailable (%s)", type(exc).__name__)
        return ChatOutcome(
            text=None,
            label="rule-based (AI provider unavailable)",
            notice=UNAVAILABLE_NOTICE,
            finish_reason="error",
        )
    except Exception:
        logger.exception("Unexpected error from AI provider")
        return ChatOutcome(
            text=None,
            label="rule-based (AI provider unavailable)",
            notice=UNAVAILABLE_NOTICE,
            finish_reason="error",
        )
    return ChatOutcome(
        text=reply.text,
        label=provider_label(has_key=True),
        # A provider substitute (or a future provider) may not carry the field.
        finish_reason=getattr(reply, "finish_reason", None) or "stop",
    )


def _messages(system_extra: str, user_block: str) -> list[dict[str, str]]:
    return [
        {"role": "system", "content": f"{SYSTEM_GUARD}\n\n{system_extra}".strip()},
        {"role": "user", "content": user_block},
    ]


def _lang_instruction(lang: str) -> str:
    return "Answer in Bengali (বাংলা)." if lang == "bn" else "Answer in English."


# ------------------------------------------------------------------ copilot

_COPILOT_BASE = ("analytics:read", "twin:read", "resilience:read")
_CRITICALITY_KEYWORDS = frozenset({
    "critical", "criticality", "rank", "ranking", "ranked",
    "risk", "risks", "top", "worst", "most", "impact", "cascade", "consequence", "single",
})


@router.post("/ai/copilot")
async def copilot(
    payload: CopilotRequest,
    db: DbSession,
    user: CurrentUser,
    _gate=Depends(require_any_permission(*_COPILOT_BASE)),
):
    """City Copilot: RBAC-scoped retrieval over the records the caller may
    read, optionally phrased by the model, always with cited entities."""
    _rate_limit(user.id)
    held = user.permission_keys
    tokens = [t for t in _tokenise(payload.message) if len(t) >= 2]
    citations: list[dict] = []
    context_rows: list[dict] = []

    if "infrastructure:read" in held:
        stmt = select(Asset)
        if tokens:
            stmt = stmt.where(
                or_(*[
                    or_(Asset.name.ilike(f"%{t}%"), Asset.code.ilike(f"%{t}%"))
                    for t in tokens[:6]
                ])
            )
        assets = db.scalars(stmt.limit(6)).all()
        for asset in assets:
            citations.append(
                ai_features.citation(
                    "asset", asset.id, f"{asset.code} {asset.name}",
                    f"{asset.category} · {asset.status}",
                )
            )
            context_rows.append(
                {"type": "asset", "code": asset.code, "name": asset.name,
                 "status": asset.status, "category": asset.category}
            )

    if "incident:read" in held:
        stmt = (
            select(Incident)
            .where(Incident.status.notin_(["resolved", "closed", "cancelled"]))
            .order_by(Incident.reported_at.desc())
        )
        token_clauses = [
            or_(Incident.title.ilike(f"%{t}%"), Incident.code.ilike(f"%{t}%"),
                Incident.description.ilike(f"%{t}%"))
            for t in tokens[:6]
        ]
        if token_clauses:
            stmt = stmt.where(or_(*token_clauses))
        incidents = db.scalars(stmt.limit(5)).all()
        for incident in incidents:
            citations.append(
                ai_features.citation(
                    "incident", incident.id, f"{incident.code} {incident.title}",
                    f"{incident.severity} · {incident.status}",
                )
            )
            context_rows.append(
                {"type": "incident", "code": incident.code, "title": incident.title,
                 "status": incident.status, "severity": incident.severity,
                 "description": (incident.description or "")[:400]}
            )

    if "task:read" in held and tokens:
        stmt = select(RepairTask).where(
            or_(*[or_(RepairTask.title.ilike(f"%{t}%"), RepairTask.code.ilike(f"%{t}%"))
                  for t in tokens[:4]])
        )
        tasks = db.scalars(stmt.limit(4)).all()
        for task in tasks:
            citations.append(
                ai_features.citation(
                    "task", task.id, f"{task.code} {task.title}",
                    f"{task.status} · priority {task.priority}",
                )
            )
            context_rows.append(
                {"type": "task", "code": task.code, "title": task.title, "status": task.status}
            )

    if "resilience:read" in held:
        try:
            from app.services import criticality as criticality_service

            crit_data = criticality_service.analyse(db, limit=25)
            ranking = crit_data.get("ranking", [])
            rank_by_code = {
                row["code"]: (pos, row)
                for pos, row in enumerate(ranking, start=1)
            }
            for ctx in context_rows:
                if ctx.get("type") == "asset" and ctx.get("code") in rank_by_code:
                    pos, row = rank_by_code[ctx["code"]]
                    ctx["criticality_rank"] = pos
                    ctx["criticality_index"] = row["criticality_index"]
                    consequence = row.get("consequence") or {}
                    if consequence.get("explanation"):
                        ctx["consequence"] = consequence["explanation"]

            lowered_tokens = {t.lower() for t in tokens}
            if lowered_tokens & _CRITICALITY_KEYWORDS:
                cited_asset_ids = {
                    c["entity_id"] for c in citations if c["entity_type"] == "asset"
                }
                for pos, row in enumerate(ranking[:5], start=1):
                    if row["asset_id"] not in cited_asset_ids:
                        citations.append(
                            ai_features.citation(
                                "asset",
                                row["asset_id"],
                                f"{row['code']} {row['name']}",
                                f"rank #{pos} · criticality {row['criticality_index']}",
                            )
                        )
                        cited_asset_ids.add(row["asset_id"])
                    context_rows.append(
                        {
                            "type": "criticality_ranking",
                            "rank": pos,
                            "code": row["code"],
                            "name": row["name"],
                            "criticality_index": row["criticality_index"],
                            "consequence": (row.get("consequence") or {}).get("explanation", ""),
                        }
                    )
        except Exception:
            # Empty city or stats hiccup never fails the copilot request.
            pass

    system = (
        f"{_lang_instruction(payload.lang)} You answer about the city's live records. "
        "Cite entities by their code exactly as given in the context. "
        "If the context has nothing relevant, say so."
    )
    if context_rows:
        context = ai_features.fenced_block("retrieved records", context_rows)
        user_block = f"{context}\n\nOperator question (instructions from the operator):\n{payload.message}"
    else:
        user_block = f"Operator question:\n{payload.message}"

    outcome = await _chat(
        _messages(system + " Keep the answer complete and under 350 words.", user_block),
        max_tokens=650,
    )
    reply_text = outcome.text
    if reply_text is None:
        reply_text = ai_features.copilot_fallback(
            payload.lang,
            citations,
            has_matches=bool(citations),
            reason=fallback_reason(outcome),
        )
    return ok(
        {
            "reply": reply_text,
            "lang": payload.lang,
            **outcome.payload(),
            "citations": citations,
        }
    )


def _tokenise(message: str) -> list[str]:
    import re

    return re.findall(r"[\w#-]+", message)


# ------------------------------------------------------ incident explanation

@router.post("/ai/incidents/{incident_id}/explain")
async def explain_incident(
    incident_id: int,
    payload: IncidentExplainRequest,
    db: DbSession,
    user: CurrentUser,
    _gate=Depends(require_permissions("incident:read")),
):
    _rate_limit(user.id)
    incident = db.get(Incident, incident_id)
    if incident is None:
        raise ApiError("Incident not found.", status_code=404, code="not_found")
    asset = db.get(Asset, incident.primary_asset_id)
    asset_label = f"{asset.code} {asset.name}" if asset else f"asset #{incident.primary_asset_id}"
    open_tasks = db.scalars(
        select(RepairTask).where(RepairTask.incident_id == incident.id).limit(5)
    ).all()

    incident_row = {
        "code": incident.code, "title": incident.title, "category": incident.category,
        "severity": incident.severity, "status": incident.status,
        "affected_population": incident.affected_population,
        "description": incident.description,
    }
    context = ai_features.fenced_block("incident record", [incident_row])
    if asset:
        context += "\n" + ai_features.fenced_block(
            "primary asset",
            [{"code": asset.code, "name": asset.name, "status": asset.status,
              "category": asset.category, "load_percent": asset.load_percent}],
        )
    if open_tasks:
        context += "\n" + ai_features.fenced_block(
            "related repair tasks",
            [{"code": t.code, "title": t.title, "status": t.status} for t in open_tasks],
        )

    system = (
        f"{_lang_instruction(payload.lang)} Explain this incident for an operator: "
        "what happened, what it affects, what is already being done, and what to "
        "check next. Use only the records provided."
    )
    outcome = await _chat(
        _messages(system + " Keep the answer complete and under 450 words.", context),
        max_tokens=850,
    )
    reply_text = outcome.text
    if reply_text is None:
        reply_text = ai_features.incident_fallback(
            payload.lang, incident_row, asset_label, reason=fallback_reason(outcome)
        )

    citations = [ai_features.citation("incident", incident.id, f"{incident.code} {incident.title}")]
    if asset:
        citations.append(ai_features.citation("asset", asset.id, f"{asset.code} {asset.name}"))
    for task in open_tasks:
        citations.append(ai_features.citation("task", task.id, f"{task.code} {task.title}"))
    return ok(
        {"reply": reply_text, "lang": payload.lang, **outcome.payload(), "citations": citations}
    )


# ----------------------------------------------------------- recovery advisor

@router.post("/ai/plans/{plan_id}/explain")
async def explain_plan(
    plan_id: int,
    payload: PlanExplainRequest,
    db: DbSession,
    user: CurrentUser,
    _gate=Depends(require_permissions("optimization:read")),
):
    """Recovery Advisor: narrates an *existing* CP-SAT plan. The solver is
    never invoked here -- if the stored plan needs improving, the operator
    re-runs optimisation themselves."""
    _rate_limit(user.id)
    plan = db.get(OptimizationPlan, plan_id)
    if plan is None:
        raise ApiError("Plan not found.", status_code=404, code="not_found")

    from app.services import optimization as opt_service

    plan_dict = opt_service.plan_to_dict(db, plan, detail=True)
    explanation = plan_dict.get("explanation") or {}
    status = str(plan.solution_status or "unknown")
    status_meaning = ai_features.solver_status_meaning(status)
    reasoning = ai_decision.build_plan_reasoning(db, plan, plan_dict)
    alternatives = (
        ai_decision.generate_alternative_plans(db, plan, plan_dict)
        if payload.include_alternatives
        else []
    )
    compact_assignments = [
        {
            "asset": f"{a.get('asset_code')} ({a.get('asset_name')})",
            "resource": f"{a.get('resource_code')} ({a.get('resource_name')})",
            "quantity": a.get("quantity"),
            "cost": a.get("estimated_cost"),
        }
        for a in (plan_dict.get("assignments") or [])
    ]
    advisor_context = {
        "plan_code": plan.code,
        "status": plan.status,
        "solver_reading": {
            "solution_status": status,
            "status_meaning": status_meaning,
            "objective_value": plan.objective_value,
            "coverage_percent": plan.coverage_percent,
            "wall_ms": plan.solver_wall_ms,
        },
        "assignments": compact_assignments,
        "unserved_demands": explanation.get("unserved") or [],
        "limiting_resources": reasoning["limiting_resources"],
        "recorded_constraints": explanation.get("constraints") or {},
        "alternatives": [
            {
                "strategy": alt["strategy"],
                "status": alt["status"],
                "coverage_percent": alt["coverage_percent"],
                "estimated_cost": alt["estimated_cost"],
                "added_vs_saved": alt["added_vs_saved"],
                "dropped_vs_saved": alt["dropped_vs_saved"],
            }
            for alt in alternatives
        ],
    }
    context = ai_features.fenced_block("solver plan", [advisor_context])
    system = (
        f"{_lang_instruction(payload.lang)} You are the recovery advisor. Explain the "
        "stored CP-SAT plan without rerunning or re-solving it. "
        f"Solver status is '{status}': {status_meaning} "
        "The objective value is a solver score, NOT proof of global business optimality. "
        "Only cite keys inside recorded_constraints. Cover: why this allocation was chosen, "
        "prioritised vs unserved demands, limiting resources, and how any listed solver "
        "alternatives differ. Keep the answer complete and under 380 words."
    )
    outcome = await _chat(_messages(system, context), max_tokens=1800)
    reply_text = outcome.text
    if reply_text is None:
        reply_text = ai_features.plan_fallback(plan_dict, reason=fallback_reason(outcome))

    citations = [ai_features.citation("optimization_plan", plan.id, f"{plan.code} plan")]
    for occurrence, row in enumerate(plan_dict.get("assignments") or [], start=1):
        citations.append(
            ai_features.citation(
                "asset", row.get("asset_id"),
                f"{row.get('asset_code')} — {row.get('asset_name')}",
                f"assignment {occurrence}: {row.get('quantity')} from "
                f"{row.get('resource_code')} — {row.get('resource_name')}",
            )
        )
    return ok(
        {
            "reply": reply_text,
            "lang": payload.lang,
            **outcome.payload(),
            "solver": {
                "solution_status": status,
                "status_meaning": status_meaning,
                "objective_value": plan.objective_value,
                "coverage_percent": plan.coverage_percent,
                "solver_wall_ms": plan.solver_wall_ms,
                "recorded_constraints": advisor_context["recorded_constraints"],
            },
            "reasoning": reasoning,
            "alternatives": alternatives,
            "citations": citations,
        }
    )


# ------------------------------------------------------- what-if extraction

@router.post("/ai/whatif/extract", status_code=201)
async def extract_whatif(
    payload: WhatIfExtractRequest,
    db: DbSession,
    user: CurrentUser,
    _gate=Depends(require_permissions("resilience:plan")),
):
    """Text -> parsed scenario -> validation -> the EXISTING engine -> an
    explanation of what the engine produced.

    Persistence uses the same service calls and permission as the manual
    form: the operator asked for this run with their own credentials; the
    model only read the sentence.
    """
    from app.services import audit
    from app.services import whatif as whatif_service

    _rate_limit(user.id)

    extracted, parsed_by = await _extract(payload.text, db)
    problems = _validate_extracted(extracted, db)
    base = {
        "extracted": extracted,
        "parsed_by": parsed_by,
        "validation": {"ok": not problems, "problems": problems},
    }
    if problems:
        return ok({**base, "scenario": None, "observation": None, "reply": None,
                   "provider": provider_label(has_key=(parsed_by == "llm"))})

    scenario = whatif_service.create_scenario(
        db,
        name=extracted["name"],
        description=extracted["description"],
        initial_failure_ids=extracted["initial_failure_ids"],
        failure_mode=extracted["failure_mode"],
        cascade_threshold=extracted["cascade_threshold"],
        max_depth=extracted["max_depth"],
        random_seed=extracted["random_seed"],
        is_baseline=False,
        actor_id=user.id,
    )
    audit.record(
        db, action="whatif.create", actor=user, resource_type="whatif_scenario",
        resource_id=scenario.id, message=f"{scenario.code} extracted from text",
        metadata={"parsed_by": parsed_by},
    )
    observation = whatif_service.observe(db, scenario, note="extracted from text", actor_id=user.id)
    audit.record(
        db, action="whatif.observe", actor=user, resource_type="whatif_scenario",
        resource_id=scenario.id, message=f"{scenario.code} observed after extraction",
        metadata={"run_id": observation.run_id},
    )
    db.commit()

    import json as _json

    metrics = _json.loads(observation.metrics_json or "{}")
    initial_assets = db.scalars(
        select(Asset).where(Asset.id.in_(extracted["initial_failure_ids"]))
    ).all()
    code_by_id = {asset.id: asset.code for asset in initial_assets}
    initial_codes = [code_by_id[asset_id] for asset_id in extracted["initial_failure_ids"]]
    failed_codes = list(metrics.get("failed_codes") or [])
    cascade_codes = [code for code in failed_codes if code not in set(initial_codes)]
    band = ai_features.severity_band(metrics.get("severity_index", 0))
    grounded_outcome = {
        "initially_injected_asset_codes": initial_codes,
        "downstream_cascading_failure_codes": cascade_codes,
        "total_failed_assets": metrics.get("assets_failed", 0),
        "operational_but_impacted_assets": (
            metrics.get("assets_degraded", 0) + metrics.get("assets_affected", 0)
        ),
        "total_impacted_assets_including_failures": metrics.get("assets_impacted", 0),
        "critical_services_down": metrics.get("critical_services_down", []),
        "maximum_cascade_depth": metrics.get("max_depth_reached", 0),
        "severity": band,
        "failure_mode": extracted["failure_mode"],
        # Definitions travel with the numbers so the model cannot redefine
        # "failed", "impacted" or "cascade" to mean something the engine did.
        "definitions": ai_features.SIMULATION_DEFINITIONS,
    }
    system = (
        f"{_lang_instruction(payload.lang)} Summarise what this what-if run showed, in "
        "short complete sections. Terms have exactly the definitions supplied in the "
        "context: initially injected asset IDs are the hypothesis the operator typed; "
        "downstream cascading failure codes are what the engine propagated from them; "
        "total failed assets counts every asset the engine marked failed; operational "
        "but impacted excludes failures. Asset codes are identifiers, never failure "
        "categories or failure modes. The severity band is the platform's own computation "
        "from the severity index -- quote it, never invent or re-derive it. Labelled "
        "implications must read as model possibilities, not verified engineering facts. "
        "Use only supplied facts. Keep the answer complete and under 350 words."
    )
    context = ai_features.fenced_block(
        "what-if observation",
        [{"scenario": scenario.code, "outcome": grounded_outcome,
          "model_parameters": {"cascade_threshold": extracted["cascade_threshold"],
                               "max_depth": extracted["max_depth"],
                               "random_seed": extracted["random_seed"]},
          "note": observation.note}],
    )
    outcome = await _chat(_messages(system, context), max_tokens=900)
    reply_text = outcome.text
    if reply_text is None:
        reply_text = (
            f"Rule-based summary: scenario {scenario.code} ran with "
            f"initially injected assets {', '.join(initial_codes)} in "
            f"{extracted['failure_mode']} mode. Downstream cascading failures: "
            f"{', '.join(cascade_codes) if cascade_codes else 'none'}. "
            f"Total failed assets: {grounded_outcome['total_failed_assets']}; "
            f"operational but impacted: {grounded_outcome['operational_but_impacted_assets']}; "
            f"critical services down: {len(grounded_outcome['critical_services_down'])}; "
            f"maximum cascade depth: {grounded_outcome['maximum_cascade_depth']}; "
            f"severity index {band['index']} which the platform maps to band "
            f"'{band['band']}' (thresholds {ai_features.SEVERITY_BAND_TEXT}). "
            f"(Rule-based -- {fallback_reason(outcome)}.)"
        )

    return ok(
        {
            **base,
            "scenario": whatif_service.scenario_dict(db, scenario),
            "observation": {"id": observation.id, "run_id": observation.run_id,
                            "headline": observation.headline, "metrics": metrics},
            "reply": reply_text,
            **outcome.payload(),
            "severity": band,
        }
    )


async def _extract(text: str, db) -> tuple[dict[str, Any], str]:
    """Model first (when configured), deterministic parser as the floor."""
    provider = get_provider()
    if provider is not None:
        system = (
            "Extract a what-if failure scenario as a single JSON object with keys: "
            "failure_codes (array of asset codes like PS-01), failure_mode "
            "(total_failure|capacity_loss|maintenance), cascade_threshold (0.05-1), "
            "max_depth (1-12), random_seed (integer or null), name (short), "
            "description (the original sentence). JSON only, no prose."
        )
        try:
            reply = await provider.chat(
                _messages(system, f"Sentence:\n{untrusted('operator text', text)}"),
                max_tokens=400,
                temperature=0.0,
            )
            parsed = ai_features.coerce_extracted_json(reply.text)
            if parsed is not None:
                return _merge_extracted(parsed, text), "llm"
        except AiError:
            pass
        except Exception:
            logger.exception("Unexpected error during what-if extraction")
    return ai_features.extract_rule_based(text), "rule-based"


def _merge_extracted(parsed: dict[str, Any], text: str) -> dict[str, Any]:
    floor = ai_features.extract_rule_based(text)
    # Explicit codes in the operator's sentence are authoritative. A model may
    # normalise other fields, but may not silently substitute the assets to run.
    codes = floor["failure_codes"] or parsed.get("failure_codes") or []
    if not isinstance(codes, list):
        codes = floor["failure_codes"]
    mode = parsed.get("failure_mode")
    if mode not in ai_features.FAILURE_MODES:
        mode = floor["failure_mode"]
    threshold = parsed.get("cascade_threshold")
    if not isinstance(threshold, (int, float)):
        threshold = floor["cascade_threshold"]
    depth = parsed.get("max_depth") if isinstance(parsed.get("max_depth"), int) else floor["max_depth"]
    seed = parsed.get("random_seed") if isinstance(parsed.get("random_seed"), int) else floor["random_seed"]
    name = str(parsed.get("name") or floor["name"]).strip()[:120] or floor["name"]
    if len(name) < 3:
        name = floor["name"]
    return {
        "failure_codes": [str(c) for c in codes][:10],
        "failure_mode": mode,
        "cascade_threshold": float(threshold) if threshold is not None else None,
        "max_depth": depth,
        "random_seed": seed,
        "name": name,
        "description": str(parsed.get("description") or text)[:1000],
    }


def _validate_extracted(extracted: dict[str, Any], db) -> list[str]:
    problems: list[str] = []
    codes = extracted.get("failure_codes") or []
    if not codes:
        problems.append("No asset codes found in the text (for example PS-01).")
    else:
        found = db.scalars(select(Asset).where(Asset.code.in_(codes))).all()
        ids = [a.id for a in found]
        unknown = sorted(set(codes) - {a.code for a in found})
        if unknown:
            problems.append(f"Unknown asset codes: {', '.join(unknown)}.")
        if not ids:
            problems.append("No recognised assets to fail.")
        extracted["initial_failure_ids"] = ids
    if extracted.get("failure_mode") not in ai_features.FAILURE_MODES:
        problems.append(f"failure_mode must be one of {', '.join(ai_features.FAILURE_MODES)}.")
    threshold = extracted.get("cascade_threshold")
    if threshold is not None and not (0.05 <= float(threshold) <= 1.0):
        problems.append("cascade_threshold must be between 0.05 and 1.0.")
    if extracted.get("cascade_threshold") is None:
        extracted["cascade_threshold"] = 0.35
    depth = extracted.get("max_depth")
    if depth is not None and not (1 <= int(depth) <= 12):
        problems.append("max_depth must be between 1 and 12.")
    if extracted.get("max_depth") is None:
        extracted["max_depth"] = 6
    seed = extracted.get("random_seed")
    if seed is not None and not (0 <= int(seed) <= 2**31 - 1):
        problems.append("random_seed out of range.")
    if extracted.get("random_seed") is None:
        extracted["random_seed"] = 42
    if len(extracted.get("name", "")) < 3:
        problems.append("name must be at least 3 characters.")
    if not extracted.get("initial_failure_ids") and not problems:
        problems.append("No recognised assets to fail.")
    return problems


# ----------------------------------------------------- resilience report

@router.post("/ai/resilience/report")
async def resilience_report(
    payload: ResilienceReportRequest,
    db: DbSession,
    user: CurrentUser,
    _gate=Depends(require_permissions("resilience:read")),
):
    """Resilience Report Assistant: figures are always computed by the
    platform; the wording is either the deterministic template or a model
    pass over exactly those figures -- labelled either way."""
    _rate_limit(user.id)
    stats = _report_stats(db)
    system = (
        f"{_lang_instruction(payload.lang)} Write the narrative sections of a "
        "resilience report (overview, hotspots, recommended focus) using ONLY the "
        "figures provided. active_incident_records is the ONLY authority for current "
        "incidents and for which asset each one is actually on. top_risks is a "
        "criticality ranking of infrastructure: never evidence of an incident, a "
        "recorded failure or a simulated failure, and an asset can rank highly with no "
        "incident at all. Never state or imply that an asset has an active incident "
        "unless a record in active_incident_records names it as the primary asset. The "
        "payload contains no simulated results; do not describe any. Quote computed "
        "figures, invent nothing. Keep the report complete and under 500 words: a short "
        "complete report beats a truncated one."
    )
    context = ai_features.fenced_block("computed report figures", [stats])
    outcome = await _chat(_messages(system, context), max_tokens=1200)
    reply_text = outcome.text
    grounding: dict[str, Any] = {"checked": False, "problems": []}
    if reply_text is not None:
        problems = report_grounding_problems(reply_text, stats)
        grounding = {"checked": True, "problems": problems}
        if problems:
            logger.warning("resilience report rejected as ungrounded: %s", problems)
            outcome = ChatOutcome(
                text=None,
                label="rule-based (model answer failed grounding checks)",
                notice=(
                    "The model's draft attributed an incident to an asset that has no "
                    "recorded incident, so the draft was rejected rather than shown. "
                    "The text below is the platform's deterministic report."
                ),
                finish_reason="grounding_rejected",
            )
            reply_text = None
    if reply_text is None:
        reply_text = ai_features.report_fallback(stats, reason=fallback_reason(outcome))
    citations = [
        ai_features.citation("incident", row["id"], f"{row['code']} — {row['title']}",
                             f"primary asset {row['primary_asset_code']} — {row['primary_asset_name']}")
        for row in stats.get("active_incident_records", [])
    ]
    citations.extend(
        ai_features.citation(
            "asset", row["asset_id"], row["label"],
            f"{row['reason']} · criticality ranking only, no recorded incident",
        )
        for row in stats.get("top_risks", [])
    )
    return ok(
        {
            "report": reply_text,
            "stats": stats,
            "lang": payload.lang,
            **outcome.payload(),
            "citations": citations,
            "grounding": grounding,
        }
    )


def _report_stats(db) -> dict[str, Any]:
    from app.core.types import utcnow
    from datetime import timedelta

    assets_total = db.scalar(select(func.count()).select_from(Asset)) or 0
    active_incidents = db.scalar(
        select(func.count()).select_from(Incident).where(
            Incident.status.notin_(["resolved", "closed", "cancelled"])
        )
    ) or 0
    since = utcnow() - timedelta(days=30)
    reported_30d = db.scalar(
        select(func.count()).select_from(Incident).where(Incident.reported_at >= since)
    ) or 0
    open_tasks = db.scalar(
        select(func.count()).select_from(RepairTask).where(
            RepairTask.status.notin_(["completed", "verified", "cancelled"])
        )
    ) or 0

    stats: dict[str, Any] = {
        "assets_total": assets_total,
        "active_incidents": active_incidents,
        "incidents_reported_30d": reported_30d,
        "open_tasks": open_tasks,
    }
    active_rows = db.execute(
        select(Incident, Asset)
        .join(Asset, Asset.id == Incident.primary_asset_id)
        .where(Incident.status.notin_(["resolved", "closed", "cancelled"]))
        .order_by(Incident.reported_at.desc())
    ).all()
    stats["active_incident_records"] = [
        {"id": incident.id, "code": incident.code, "title": incident.title,
         "status": incident.status, "severity": incident.severity,
         "primary_asset_id": asset.id, "primary_asset_code": asset.code,
         "primary_asset_name": asset.name}
        for incident, asset in active_rows
    ]

    try:
        from app.services import criticality as criticality_service

        index = criticality_service.analyse(db, limit=3)
        fleet = index.get("fleet", {})
        stats["criticality"] = {
            "total": fleet.get("total_dependencies", 0),
            "critical_assets": fleet.get("critical_assets", 0),
        }
        active_codes = {
            row["primary_asset_code"] for row in stats["active_incident_records"]
        }
        stats["top_risks"] = [
            {
                "rank": position,
                "asset_id": row["asset_id"],
                "code": row["code"],
                "label": f"{row['code']} — {row['name']}",
                "reason": f"criticality index {row['criticality_index']}",
                # Explicit on the row itself: a criticality rank is not an
                # incident, and this asset may or may not happen to have one.
                "is_recorded_incident_asset": row["code"] in active_codes,
                "claim": "criticality ranking only; not an incident claim",
            }
            for position, row in enumerate(index.get("ranking", [])[:3], start=1)
        ]
    except Exception:
        # An empty city (409 from analyse) or any stats hiccup degrades the
        # report's hotspot section -- never the request itself.
        stats["criticality"] = {}
        stats["top_risks"] = []
    stats["definitions"] = {
        "active_incident_records": (
            "incidents whose status is not resolved/closed/cancelled, with the asset "
            "recorded as their primary asset"
        ),
        "top_risks": "criticality ranking over dependencies; never an incident or failure",
        "criticality": "priority scoring, not an operational status",
        "recorded_failures": "only what appears in active_incident_records",
        "simulated_results": "none included in this payload",
    }
    stats["assets_with_active_incidents"] = sorted(
        {row["primary_asset_code"] for row in stats["active_incident_records"]}
    )
    return stats


# The wording an ungrounded report tends to use, and the wording that makes a
# sentence an explicit *contrast* rather than a conflation.
_INCIDENT_WORD_RE = re.compile(r"\bincidents?\b", re.IGNORECASE)
_CONTRAST_RE = re.compile(
    r"\b(no|not|none|never|without|while|whereas|although|though|but|versus|vs\.?|"
    r"only|just|merely|solely|ranking|ranked|criticality|unrelated|distinct|"
    r"separate|differ\w*|contrast\w*|distinguish\w*)\b",
    re.IGNORECASE,
)


def report_grounding_problems(text: str, stats: dict[str, Any]) -> list[str]:
    """Reject the conflation actually observed in testing.

    The model was given INC-0005 on SS-01 as the only live incident and PS-02 as
    the top criticality rank, and it recommended sending resources to PS-02 "to
    stabilise an active incident". Only ``active_incident_records`` may assert an
    incident, so any sentence that pairs the word "incident" with a merely
    ranked asset -- without contrasting wording -- is reported here and the
    draft is discarded instead of shown.
    """
    active_codes = {
        str(row.get("primary_asset_code") or "")
        for row in stats.get("active_incident_records", [])
    }
    ranked_codes = set()
    for row in stats.get("top_risks", []):
        label = str(row.get("label") or row.get("code") or "")
        code = label.split("—")[0].strip().split(" ")[0]
        if code:
            ranked_codes.add(code)
    risky_only = ranked_codes - active_codes
    if not risky_only:
        return []

    problems: list[str] = []
    for sentence in re.split(r"(?<=[.!?])\s+", text):
        if not _INCIDENT_WORD_RE.search(sentence) or _CONTRAST_RE.search(sentence):
            continue
        named = set(re.findall(r"\b([A-Z]{2,4}-\d{2})\b", sentence))
        for code in sorted(named & risky_only):
            problems.append(
                f"{code} is described alongside an incident but is only a criticality "
                "ranking entry with no record in active_incident_records"
            )
    return problems


# ------------------------------------------------------- AI Disaster Commander


@router.post("/ai/commander")
async def disaster_commander(
    payload: CommanderRequest,
    db: DbSession,
    user: CurrentUser,
    _gate=Depends(require_permissions("simulation:read")),
):
    """AI Disaster Commander: natural-language query -> live asset resolution ->
    read-only deterministic cascade simulation + CP-SAT recovery preview ->
    grounded Groq explanation with deterministic fallback."""
    _rate_limit(user.id)
    resolution = ai_decision.extract_assets_from_text(db, payload.question)
    if resolution["status"] != "resolved":
        status = resolution["status"]
        if status == "unknown":
            msg = (
                f"Unknown asset code(s): {', '.join(resolution['unknown_codes'])}. "
                "Select a valid asset from Aurora Vale below."
            )
        elif status == "ambiguous":
            names = ", ".join(f"{c['code']} ({c['name']})" for c in resolution["candidates"][:5])
            msg = f"Multiple assets match your question ({names}). Pick a specific asset code to simulate."
        else:
            msg = "Please name an infrastructure asset (for example PS-01, SS-01, or HO-01) to run a disaster simulation."
        return ok(
            {
                "reply": msg,
                "lang": payload.lang,
                "provider": provider_label(has_key=False),
                "truncated": False,
                "notice": None,
                "resolution": resolution,
                "sections": None,
                "simulation": None,
                "recovery_preview": None,
                "next_actions": [],
                "citations": [
                    ai_features.citation("asset", c["id"], f"{c['code']} — {c['name']}", c["category"])
                    for c in resolution["candidates"][:6]
                ],
            }
        )

    evidence = ai_decision.build_commander_evidence(
        db,
        resolved_assets=resolution["assets"],
        failure_mode=payload.failure_mode,
        cascade_threshold=payload.cascade_threshold,
        max_depth=payload.max_depth,
    )
    sections = ai_decision.commander_sections_from_evidence(evidence)
    sim = evidence["simulation"]
    rec = evidence["recovery_preview"]

    compact_context = {
        "question": payload.question,
        "target_assets": evidence["target_assets"],
        "target_criticality": evidence["target_criticality"],
        "active_incidents_on_targets": evidence["active_incidents_on_targets"],
        "simulation_summary": sim["summary"],
        "directly_failed": [e["code"] for e in sim["directly_failed"]],
        "cascading_failed": [e["code"] for e in sim["cascading_failed"]],
        "critical_services_down": sim["critical_services_down"],
        "recovery_preview": {
            "status": rec["status"],
            "coverage_percent": rec["coverage_percent"],
            "assignments": rec["assignments"][:6],
            "unserved_count": len(rec["unserved"]),
            "limiting_resources": rec["limiting_resources"],
        },
        "assumptions": evidence["assumptions"],
    }
    system = (
        f"{_lang_instruction(payload.lang)} You are the AI Disaster Commander for Aurora Vale. "
        "Answer using ONLY the simulated and solver figures in the context. Format with these "
        "sections: Situation Summary, Affected Infrastructure, Cascading Impact, Population at Risk, "
        "Recommended Immediate Actions, Resource Constraints, Evidence and Limitations. "
        "Do not invent failures, population figures, or solver results. Explicitly state that no "
        "database writes or resource reservations were executed. Keep under 420 words."
    )
    outcome = await _chat(_messages(system, ai_features.fenced_block("commander evidence", [compact_context])), max_tokens=1600)
    reply_text = outcome.text
    if reply_text is None:
        reply_text = ai_decision.commander_fallback(evidence, lang=payload.lang, reason=fallback_reason(outcome))

    citations = [
        ai_features.citation("asset", a["id"], f"{a['code']} — {a['name']}", f"target ({a['category']})")
        for a in resolution["assets"]
    ]
    for e in sim["cascading_failed"][:5]:
        citations.append(
            ai_features.citation("asset", e["asset_id"], f"{e['code']} — {e['name']}", f"cascading failure depth {e['depth']}")
        )
    for inc in evidence["active_incidents_on_targets"][:3]:
        citations.append(
            ai_features.citation("incident", inc["id"], f"{inc['code']} — {inc['title']}", inc["status"])
        )

    target_codes = ",".join(a["code"] for a in resolution["assets"])
    next_actions = [
        {"label": "Open in Simulation Lab", "href": f"/simulation?asset={target_codes}"},
        {"label": "Open Recovery Planner", "href": "/optimization"},
        {"label": "Highlight in 3D Digital Twin", "href": f"/twin?highlight={','.join(str(i) for i in sim['failed_asset_ids'])}"},
    ]

    return ok(
        {
            "reply": reply_text,
            "lang": payload.lang,
            **outcome.payload(),
            "resolution": resolution,
            "sections": sections,
            "simulation": sim,
            "recovery_preview": rec,
            "next_actions": next_actions,
            "citations": citations,
        }
    )


# ------------------------------------------------ Multi-Scenario AI Reasoning


@router.post("/ai/scenarios/compare")
async def compare_scenarios_ai(
    payload: ScenarioCompareRequest,
    db: DbSession,
    user: CurrentUser,
    _gate=Depends(require_permissions("simulation:read")),
):
    """Multi-Scenario AI Reasoning: evaluates 2–3 failure scenarios
    independently in-memory using the deterministic cascade engine, computes
    metric deltas on the backend, and narrates trade-offs via Groq."""
    _rate_limit(user.id)
    scenario_defs: list[dict[str, Any]] = []

    if payload.scenarios:
        assets = ai_decision._load_active_assets(db)
        by_code = {a.code.upper(): a for a in assets}
        for spec in payload.scenarios:
            matched = []
            missing = []
            for code in spec.asset_codes:
                a = by_code.get(code.strip().upper())
                if a:
                    matched.append(ai_decision._asset_brief(a))
                else:
                    missing.append(code)
            if missing or not matched:
                raise ApiError(
                    f"Unknown asset code(s) in scenario: {', '.join(missing) or 'none provided'}.",
                    status_code=422,
                    code="invalid_asset",
                )
            scenario_defs.append(
                {
                    "label": spec.label or ", ".join(a["code"] for a in matched),
                    "assets": matched,
                    "failure_mode": spec.failure_mode,
                    "cascade_threshold": spec.cascade_threshold,
                    "max_depth": spec.max_depth,
                }
            )
    elif payload.question:
        scenario_defs = ai_decision.parse_comparison_question(db, payload.question)
        if len(scenario_defs) < 2:
            return ok(
                {
                    "reply": "Please specify at least two valid asset codes to compare (for example: 'Compare PS-01 vs SS-01').",
                    "lang": payload.lang,
                    "provider": provider_label(has_key=False),
                    "truncated": False,
                    "notice": None,
                    "scenarios": [],
                    "metrics_table": [],
                    "set_differences": {},
                    "citations": [],
                }
            )
    else:
        raise ApiError("Provide either 'question' or 'scenarios'.", status_code=422, code="validation_error")

    comparison = ai_decision.compare_scenarios_readonly(db, scenario_defs)
    compact = {
        "scenarios": [
            {
                "label": s["label"],
                "metrics": s["metrics"],
                "severity_band": s["severity_band"],
                "critical_services_down": s["critical_services_down"],
            }
            for s in comparison["scenarios"]
        ],
        "metrics_table": comparison["metrics_table"],
        "set_differences": comparison["set_differences"],
    }
    system = (
        f"{_lang_instruction(payload.lang)} Compare the simulated failure scenarios using ONLY "
        "the computed metrics_table and set_differences. State which scenario has higher impact "
        "per metric (or 'tied'). Never invent an overall disaster score. Keep under 360 words."
    )
    outcome = await _chat(_messages(system, ai_features.fenced_block("scenario comparison", [compact])), max_tokens=1400)
    reply_text = outcome.text
    if reply_text is None:
        reply_text = ai_decision.compare_fallback(comparison, lang=payload.lang, reason=fallback_reason(outcome))

    citations = []
    for s in comparison["scenarios"]:
        for a in s["target_assets"]:
            citations.append(
                ai_features.citation("asset", a["id"], f"{a['code']} — {a['name']}", f"scenario {s['label']}")
            )

    return ok(
        {
            "reply": reply_text,
            "lang": payload.lang,
            **outcome.payload(),
            **comparison,
            "citations": citations,
        }
    )
