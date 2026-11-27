"use client";

/**
 * Explainable Recovery Intelligence card for /optimization/plans/[id].
 *
 * Shows the Groq / deterministic explanation alongside structured solver
 * reasoning (optimality vs feasible, limiting resources, what would improve
 * outcome) and read-only CP-SAT alternative allocations.
 */

import { useState } from "react";
import { CheckCircle2, Cpu, Loader2, ShieldAlert, Sparkles } from "lucide-react";
import { Badge, Button, Panel, PanelHeader } from "@/components/ui";
import { AiError, AiReplyCard, replyText, useAiCall, type AiReplyPayload } from "@/components/ai/ai-block";
import { formatNumber } from "@/lib/format";

interface AlternativePlan {
  strategy: string;
  label: string;
  status: string;
  feasible: boolean;
  coverage_percent: number;
  objective_value: number;
  estimated_cost: number;
  cost_diff_vs_saved: number;
  coverage_diff_vs_saved: number;
  served_assets: string[];
  added_vs_saved: string[];
  dropped_vs_saved: string[];
  unserved_count: number;
  wall_ms: number;
}

interface PlanReasoning {
  why_selected: string;
  optimality_status: string;
  optimality_meaning: string;
  limiting_resources: { resource_code: string; resource_name: string; used: number; available: number; utilization_percent: number }[];
  what_would_improve_outcome: string[];
}

interface ExplainPlanPayload extends AiReplyPayload {
  reasoning?: PlanReasoning;
  alternatives?: AlternativePlan[];
}

export function ExplainableRecoveryCard({ planId }: { planId: number }) {
  const [lang, setLang] = useState<"en" | "bn">("en");
  const { run, result, error, loading } = useAiCall<ExplainPlanPayload>();

  return (
    <Panel data-testid="plan-explain">
      <PanelHeader
        title="Explainable Recovery Intelligence"
        subtitle="Grounded CP-SAT interpretation, limiting resource analysis, and read-only alternative solver strategies."
        icon={<Sparkles className="h-4 w-4" aria-hidden />}
        action={
          <div className="flex items-center gap-1 rounded-lg border border-white/10 bg-navy-950/60 p-0.5" role="group" aria-label="Explanation language">
            {(["en", "bn"] as const).map((code) => (
              <button
                key={code}
                type="button"
                onClick={() => setLang(code)}
                aria-pressed={lang === code}
                className={`rounded-md px-2 py-1 text-[11px] font-semibold transition ${
                  lang === code ? "bg-accent/20 text-accent" : "text-ink-400 hover:text-ink-200"
                }`}
              >
                {code === "en" ? "EN" : "বাংলা"}
              </button>
            ))}
          </div>
        }
      />

      <div className="mt-2 flex flex-wrap gap-2">
        <Button
          variant="secondary"
          size="sm"
          disabled={loading}
          onClick={() => void run(`/ai/plans/${planId}/explain`, { lang, include_alternatives: true })}
          aria-label="Explain this plan with alternatives"
        >
          {loading ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Sparkles className="h-4 w-4" aria-hidden />}
          Explain plan &amp; compare alternatives
        </Button>
      </div>

      {loading ? (
        <p className="mt-3 text-xs text-ink-400" role="status">
          Analysing solver constraints and evaluating CP-SAT alternatives…
        </p>
      ) : null}
      {error ? <AiError message={error} /> : null}

      {result ? (
        <div className="mt-3 space-y-4">
          <AiReplyCard
            reply={replyText(result)}
            provider={result.provider}
            citations={result.citations}
            notice={result.notice}
          />

          {result.reasoning ? (
            <div className="grid gap-3 md:grid-cols-2">
              <div className="rounded-xl border border-white/10 bg-navy-950/50 p-3 text-xs">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold text-white">Solver Optimality &amp; Selection</span>
                  <Badge tone={result.reasoning.optimality_status === "optimal" ? "success" : "warning"}>
                    {result.reasoning.optimality_status}
                  </Badge>
                </div>
                <p className="mt-1.5 text-ink-300 leading-relaxed">{result.reasoning.why_selected}</p>
                <p className="mt-1 text-ink-400">{result.reasoning.optimality_meaning}</p>
              </div>

              <div className="rounded-xl border border-white/10 bg-navy-950/50 p-3 text-xs">
                <div className="flex items-center gap-1.5 font-semibold text-white">
                  <ShieldAlert className="h-3.5 w-3.5 text-amber" aria-hidden />
                  Limiting Resources &amp; Improvement
                </div>
                {result.reasoning.limiting_resources.length > 0 ? (
                  <ul className="mt-1.5 space-y-1 text-ink-300">
                    {result.reasoning.limiting_resources.map((r) => (
                      <li key={r.resource_code}>
                        <span className="font-mono text-white">{r.resource_code}</span> ({r.resource_name}):{" "}
                        {r.used}/{r.available} ({r.utilization_percent}% used)
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-1.5 text-ink-400">No resource reached ≥ 85% utilization.</p>
                )}
                {result.reasoning.what_would_improve_outcome.length > 0 ? (
                  <ul className="mt-2 list-disc pl-4 space-y-1 text-ink-300">
                    {result.reasoning.what_would_improve_outcome.map((hint, idx) => (
                      <li key={idx}>{hint}</li>
                    ))}
                  </ul>
                ) : null}
              </div>
            </div>
          ) : null}

          {result.alternatives && result.alternatives.length > 0 ? (
            <div className="rounded-xl border border-white/10 bg-navy-950/50 p-3">
              <div className="flex items-center justify-between gap-2 mb-2">
                <h4 className="flex items-center gap-1.5 text-xs font-semibold text-white">
                  <Cpu className="h-3.5 w-3.5 text-accent" aria-hidden />
                  Read-Only Alternative CP-SAT Strategies
                </h4>
                <span className="text-[11px] text-ink-400">No database changes · comparison only</span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs border-collapse">
                  <thead>
                    <tr className="border-b border-white/10 text-ink-400">
                      <th className="py-1.5 pr-3">Strategy</th>
                      <th className="py-1.5 pr-3">Solver</th>
                      <th className="py-1.5 pr-3">Coverage</th>
                      <th className="py-1.5 pr-3">Est. Cost</th>
                      <th className="py-1.5">Diff vs Saved Plan</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.alternatives.map((alt) => (
                      <tr key={alt.strategy} className="border-b border-white/5 text-ink-200">
                        <td className="py-2 pr-3 font-medium text-white">{alt.label}</td>
                        <td className="py-2 pr-3">
                          <Badge tone={alt.feasible ? "success" : "danger"}>{alt.status}</Badge>
                        </td>
                        <td className="py-2 pr-3">
                          {alt.coverage_percent}%
                          {alt.coverage_diff_vs_saved !== 0 ? (
                            <span className="ml-1 text-ink-400">
                              ({alt.coverage_diff_vs_saved > 0 ? "+" : ""}
                              {alt.coverage_diff_vs_saved}%)
                            </span>
                          ) : null}
                        </td>
                        <td className="py-2 pr-3">
                          {formatNumber(alt.estimated_cost)}
                          {alt.cost_diff_vs_saved !== 0 ? (
                            <span className="ml-1 text-ink-400">
                              ({alt.cost_diff_vs_saved > 0 ? "+" : ""}
                              {formatNumber(alt.cost_diff_vs_saved)})
                            </span>
                          ) : null}
                        </td>
                        <td className="py-2 text-ink-300">
                          {alt.added_vs_saved.length === 0 && alt.dropped_vs_saved.length === 0 ? (
                            <span className="inline-flex items-center gap-1 text-mint">
                              <CheckCircle2 className="h-3 w-3" aria-hidden /> Matches saved allocation
                            </span>
                          ) : (
                            <span>
                              {alt.added_vs_saved.length > 0 ? `+${alt.added_vs_saved.join(", ")} ` : ""}
                              {alt.dropped_vs_saved.length > 0 ? `-${alt.dropped_vs_saved.join(", ")}` : ""}
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </Panel>
  );
}
