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
import threading
import time
from collections import deque
from typing import Any, Callable

from fastapi import APIRouter, Depends
from sqlalchemy import func, or_, select

from app.api.deps import CurrentUser, DbSession, require_any_permission, require_permissions
from app.core.responses import ApiError, ok
from app.models.infrastructure import InfrastructureAsset as Asset
from app.models.operations import Incident, RepairTask
from app.models.optimization import OptimizationPlan
from app.schemas.ai import (
    CopilotRequest,
    IncidentExplainRequest,
    PlanExplainRequest,
    ResilienceReportRequest,
    WhatIfExtractRequest,
)
from app.services.ai import SYSTEM_GUARD, get_provider, provider_label, untrusted
from app.services.ai import features as ai_features
from app.services.ai.provider import AiError, AiReply

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


async def _chat(messages: list[dict[str, str]], *, max_tokens: int = 700) -> tuple[str | None, str]:
    """Call the provider; on any failure return (None, rule-based label).

    Features never surface provider errors as feature errors -- they fall
    back to the deterministic path and keep the honest label.
    """
    provider = get_provider()
    if provider is None:
        return None, provider_label(has_key=False)
    try:
        reply: AiReply = await provider.chat(messages, max_tokens=max_tokens)
    except AiError:
        return None, provider_label(has_key=False)
    except Exception:
        logger.exception("Unexpected error from AI provider")
        return None, provider_label(has_key=False)
    return reply.text, provider_label(has_key=True)


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

    reply_text, label = await _chat(_messages(system, user_block), max_tokens=500)
    if reply_text is None:
        reply_text = ai_features.copilot_fallback(
            payload.lang, citations, has_matches=bool(citations)
        )
    return ok(
        {
            "reply": reply_text,
            "lang": payload.lang,
            "provider": label,
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
    reply_text, label = await _chat(_messages(system, context), max_tokens=600)
    if reply_text is None:
        reply_text = ai_features.incident_fallback(payload.lang, incident_row, asset_label)

    citations = [ai_features.citation("incident", incident.id, f"{incident.code} {incident.title}")]
    if asset:
        citations.append(ai_features.citation("asset", asset.id, f"{asset.code} {asset.name}"))
    for task in open_tasks:
        citations.append(ai_features.citation("task", task.id, f"{task.code} {task.title}"))
    return ok(
        {"reply": reply_text, "lang": payload.lang, "provider": label, "citations": citations}
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
    context = ai_features.fenced_block("solver plan", [plan_dict])
    system = (
        f"{_lang_instruction(payload.lang)} You are the recovery advisor. Explain the "
        "CP-SAT plan: what the solver optimised, how good the answer is, where the "
        "gaps are, and what an operator should confirm before approval. The solver's "
        "numbers are authoritative -- never invent different ones, never present a "
        "new solution as the plan."
    )
    reply_text, label = await _chat(_messages(system, context), max_tokens=700)
    if reply_text is None:
        reply_text = ai_features.plan_fallback(plan_dict)

    citations = [ai_features.citation("optimization_plan", plan.id, f"{plan.code} plan")]
    for row in (plan_dict.get("assignments") or [])[:6]:
        citations.append(
            ai_features.citation(
                "asset", row.get("asset_id"), f"asset #{row.get('asset_id')} assignment",
                f"resource #{row.get('resource_id')}",
            )
        )
    return ok(
        {
            "reply": reply_text,
            "lang": payload.lang,
            "provider": label,
            "solver": {
                "solution_status": plan.solution_status,
                "objective_value": plan.objective_value,
                "coverage_percent": plan.coverage_percent,
                "solver_wall_ms": plan.solver_wall_ms,
            },
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
    system = (
        f"{_lang_instruction(payload.lang)} Summarise what this what-if run showed: "
        "the failures injected, the cascade outcome metrics, and how to read them. "
        "Only use the numbers provided."
    )
    context = ai_features.fenced_block(
        "what-if observation",
        [{"scenario": scenario.code, "metrics": metrics, "note": observation.note}],
    )
    reply_text, label = await _chat(_messages(system, context), max_tokens=500)
    if reply_text is None:
        reply_text = (
            f"Rule-based summary: scenario {scenario.code} ran with "
            f"{len(extracted['initial_failure_ids'])} injected failure(s), mode "
            f"{extracted['failure_mode']} at threshold {extracted['cascade_threshold']}. "
            f"Headline: {observation.headline}. Metrics: "
            f"{', '.join(f'{k}={v}' for k, v in list(metrics.items())[:6])}. "
            "(No LLM key is configured.)"
        )

    return ok(
        {
            **base,
            "scenario": whatif_service.scenario_dict(db, scenario),
            "observation": {"id": observation.id, "run_id": observation.run_id,
                            "headline": observation.headline, "metrics": metrics},
            "reply": reply_text,
            "provider": label,
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
    codes = parsed.get("failure_codes") or floor["failure_codes"]
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
        "figures provided. Do not invent numbers."
    )
    context = ai_features.fenced_block("computed report figures", [stats])
    reply_text, label = await _chat(_messages(system, context), max_tokens=800)
    if reply_text is None:
        reply_text = ai_features.report_fallback(stats)
    return ok({"report": reply_text, "stats": stats, "lang": payload.lang, "provider": label})


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

    try:
        from app.services import criticality as criticality_service

        index = criticality_service.analyse(db, limit=3)
        fleet = index.get("fleet", {})
        stats["criticality"] = {
            "total": fleet.get("total_dependencies", 0),
            "critical_assets": fleet.get("critical_assets", 0),
        }
        stats["top_risks"] = [
            {"label": f"{row['code']} {row['name']}",
             "reason": f"criticality index {row['criticality_index']}"}
            for row in index.get("ranking", [])[:3]
        ]
    except Exception:
        # An empty city (409 from analyse) or any stats hiccup degrades the
        # report's hotspot section -- never the request itself.
        stats["criticality"] = {}
        stats["top_risks"] = []
    return stats
