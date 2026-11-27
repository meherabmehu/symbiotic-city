"use client";

/**
 * Multi-Scenario AI Reasoning panel for /resilience.
 *
 * Compares 2-3 failure hypotheses side-by-side using deterministic backend
 * simulation outputs and Groq trade-off narration (with deterministic fallback).
 */

import Link from "next/link";
import { useState } from "react";
import { ArrowUpRight, GitCompare, Loader2, Send } from "lucide-react";
import { Badge, Button, Panel, PanelHeader } from "@/components/ui";
import { AiError, AiReplyCard, replyText, useAiCall, type AiReplyPayload } from "@/components/ai/ai-block";
import { formatNumber } from "@/lib/format";

interface EvaluatedScenario {
  key: string;
  label: string;
  failure_mode: string;
  severity_band: string;
  metrics: {
    directly_failed_assets: number;
    cascading_failures: number;
    total_failed_assets: number;
    impacted_dependency_paths: number;
    affected_population: number;
    severity_index: number;
    target_criticality_index: number;
    recovery_demands_count: number;
  };
  critical_services_down: string[];
  failed_asset_ids: number[];
}

interface MetricTableRow {
  metric: string;
  label: string;
  values: Record<string, number>;
  higher_impact: string;
  spread: number;
}

interface ScenarioComparePayload extends AiReplyPayload {
  scenarios?: EvaluatedScenario[];
  metrics_table?: MetricTableRow[];
  set_differences?: {
    shared_failures?: string[];
    only_in_first?: string[];
    only_in_second?: string[];
  };
}

const PRESETS = [
  "Compare PS-01 failure versus SS-01 failure",
  "Compare PS-02 vs SS-02",
  "Compare PS-01 vs PS-02 vs SS-01",
];

export function ScenarioCompareAi() {
  const [question, setQuestion] = useState(PRESETS[0]);
  const [lang, setLang] = useState<"en" | "bn">("en");
  const { run, result, error, loading } = useAiCall<ScenarioComparePayload>();

  async function submit(text: string) {
    const trimmed = text.trim();
    if (!trimmed) return;
    setQuestion(trimmed);
    await run("/ai/scenarios/compare", { question: trimmed, lang });
  }

  return (
    <Panel data-testid="scenario-compare-ai">
      <PanelHeader
        title="Multi-Scenario AI Reasoning"
        subtitle="Compare two or three failure hypotheses side-by-side with read-only deterministic cascade maths and Groq trade-off analysis."
        icon={<GitCompare className="h-4 w-4 text-accent" aria-hidden />}
        action={
          <div className="flex items-center gap-1 rounded-lg border border-white/10 bg-navy-950/60 p-0.5" role="group" aria-label="Comparison language">
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

      <form
        className="mt-2 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void submit(question);
        }}
      >
        <input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="e.g. Compare the impact of PS-01 failure versus SS-01 failure"
          aria-label="Multi-scenario comparison prompt"
          className="min-w-0 flex-1 rounded-lg border border-white/10 bg-navy-950/60 px-3 py-2 text-sm text-white placeholder:text-ink-500 focus:border-accent/50 focus:outline-none"
        />
        <Button type="submit" variant="primary" disabled={loading || !question.trim()}>
          {loading ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Send className="h-4 w-4" aria-hidden />}
          Compare
        </Button>
      </form>

      <div className="mt-2 flex flex-wrap gap-1.5">
        {PRESETS.map((preset) => (
          <button
            key={preset}
            type="button"
            onClick={() => void submit(preset)}
            className="rounded-full border border-white/10 px-2.5 py-1 text-[11px] text-ink-400 transition hover:border-accent/40 hover:text-ink-200"
          >
            {preset}
          </button>
        ))}
      </div>

      {loading ? (
        <p className="mt-3 text-xs text-ink-400" role="status">
          Running independent deterministic simulations…
        </p>
      ) : null}
      {error ? <AiError message={error} /> : null}

      {result ? (
        <div className="mt-4 space-y-4">
          {result.scenarios && result.scenarios.length > 0 ? (
            <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
              {result.scenarios.map((sc) => (
                <div key={sc.key} className="rounded-xl border border-white/10 bg-navy-950/50 p-3 text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-semibold text-white">{sc.label}</span>
                    <Badge tone={sc.severity_band === "critical" || sc.severity_band === "high" ? "danger" : "warning"}>
                      {sc.severity_band} ({sc.metrics.severity_index})
                    </Badge>
                  </div>
                  <div className="mt-2 grid grid-cols-2 gap-2 text-ink-300">
                    <div>Failed: <strong className="text-white">{sc.metrics.total_failed_assets}</strong></div>
                    <div>Cascading: <strong className="text-white">{sc.metrics.cascading_failures}</strong></div>
                    <div>Population: <strong className="text-white">{formatNumber(sc.metrics.affected_population)}</strong></div>
                    <div>Criticality: <strong className="text-white">{sc.metrics.target_criticality_index}</strong></div>
                  </div>
                  <div className="mt-2">
                    <Link
                      href={`/twin?highlight=${sc.failed_asset_ids.join(",")}`}
                      className="inline-flex items-center gap-1 text-[11px] text-accent hover:underline"
                    >
                      Highlight in 3D Twin <ArrowUpRight className="h-3 w-3" aria-hidden />
                    </Link>
                  </div>
                </div>
              ))}
            </div>
          ) : null}

          {result.metrics_table && result.metrics_table.length > 0 && result.scenarios ? (
            <div className="overflow-x-auto rounded-xl border border-white/10 bg-navy-950/40 p-3">
              <table className="w-full text-left text-xs border-collapse">
                <thead>
                  <tr className="border-b border-white/10 text-ink-400">
                    <th className="py-1.5 pr-3">Metric</th>
                    {result.scenarios.map((sc) => (
                      <th key={sc.key} className="py-1.5 pr-3 text-white">{sc.label}</th>
                    ))}
                    <th className="py-1.5">Higher Impact</th>
                  </tr>
                </thead>
                <tbody>
                  {result.metrics_table.map((row) => (
                    <tr key={row.metric} className="border-b border-white/5 text-ink-200">
                      <td className="py-1.5 pr-3 font-medium text-ink-300">{row.label}</td>
                      {result.scenarios!.map((sc) => (
                        <td key={sc.key} className="py-1.5 pr-3 font-mono text-white">
                          {formatNumber(row.values[sc.label] ?? 0)}
                        </td>
                      ))}
                      <td className="py-1.5">
                        <Badge tone={row.higher_impact === "tied" ? "neutral" : "accent"}>
                          {row.higher_impact}
                        </Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}

          <AiReplyCard
            reply={replyText(result)}
            provider={result.provider}
            citations={result.citations}
            notice={result.notice}
          />
        </div>
      ) : null}
    </Panel>
  );
}
