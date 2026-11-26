"use client";

/**
 * Natural-language scenario extraction for the What-If Lab: prose in, a
 * validated scenario out. The backend parses (LLM when keyed, deterministic
 * fallback otherwise), validates against the scenario schema, creates and
 * runs the scenario under the caller's own resilience:plan permission, then
 * explains the recorded metrics -- so the reply always carries the engine's
 * real numbers, never model arithmetic.
 */

import { useState } from "react";
import { Beaker, Loader2, Send } from "lucide-react";
import { Button, Panel, PanelHeader } from "@/components/ui";
import { AiError, AiReplyCard, ProviderChip, useAiCall } from "@/components/ai/ai-block";

interface ExtractResult {
  reply: string | null;
  provider: string;
  truncated?: boolean;
  notice?: string | null;
  lang: "en" | "bn";
  parsed_by?: string;
  severity?: {
    index: number;
    band: string;
    thresholds: string;
    source: string;
  };
  scenario: { id: number; name: string; steps?: number } | null;
  validation?: { ok: boolean; problems: string[] };
  observation?: Record<string, unknown> | null;
}

/** Validation failures arrive under `validation.problems`, never as a reply. */
function validationProblems(result: ExtractResult): string[] {
  if (result.scenario) return [];
  return result.validation?.problems ?? [];
}

const PLACEHOLDERS = [
  "What if TX-01 and SS-02 fail at once? Threshold 0.6, depth 5, seed 99",
  "মার্চে হারিকেন ঝড়ে জেলা সিএন-১ ধ্বংস হলে কী হবে?",
];

export function WhatIfExtract({ onCreated }: { onCreated?: () => void }) {
  const [text, setText] = useState("");
  const [lang, setLang] = useState<"en" | "bn">("en");
  const { run, result, error, loading } = useAiCall<ExtractResult>();

  async function extract() {
    const trimmed = text.trim();
    if (!trimmed) return;
    const outcome = await run("/ai/whatif/extract", { text: trimmed, lang });
    if (outcome?.scenario) {
      setText("");
      onCreated?.();
    }
  }

  return (
    <Panel data-testid="whatif-extract">
      <PanelHeader
        title="Describe a failure in plain language"
        subtitle="Extraction validates first, then creates and runs the scenario — nothing is persisted if the definition is invalid."
        icon={<Beaker className="h-4 w-4" aria-hidden />}
      />
      <form
        className="mt-1 flex flex-col gap-2 sm:flex-row"
        onSubmit={(event) => {
          event.preventDefault();
          void extract();
        }}
      >
        <textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder={PLACEHOLDERS[lang === "bn" ? 1 : 0]}
          aria-label="Scenario description"
          rows={2}
          maxLength={1500}
          className="min-w-0 flex-1 resize-y rounded-lg border border-white/10 bg-navy-950/60 px-3 py-2 text-sm text-white placeholder:text-ink-500 focus:border-accent/50 focus:outline-none"
        />
        <div className="flex items-end gap-2">
          <div className="flex rounded-lg border border-white/10 bg-navy-950/60 p-0.5" role="group" aria-label="Language">
            {(["en", "bn"] as const).map((code) => (
              <button
                key={code}
                type="button"
                onClick={() => setLang(code)}
                aria-pressed={lang === code}
                className={`rounded-md px-2 py-1.5 text-[11px] font-semibold transition ${
                  lang === code ? "bg-accent/20 text-accent" : "text-ink-400 hover:text-ink-200"
                }`}
              >
                {code === "en" ? "EN" : "বাংলা"}
              </button>
            ))}
          </div>
          <Button type="submit" variant="primary" disabled={loading || !text.trim()} aria-label="Extract and run scenario">
            {loading ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Send className="h-4 w-4" aria-hidden />}
            Extract &amp; run
          </Button>
        </div>
      </form>

      {loading ? <p className="mt-3 text-xs text-ink-400" role="status">Validating and running the scenario…</p> : null}
      {error ? <AiError message={error} /> : null}
      {result ? (
        <div className="mt-3">
          {validationProblems(result).length > 0 ? (
            <div className="rounded-xl border border-coral/30 bg-coral/10 p-3" data-testid="extract-problems">
              <div className="flex flex-wrap items-center gap-2">
                <ProviderChip provider={result.provider} />
                <span className="text-[11px] font-semibold uppercase tracking-wider text-coral">Nothing was created</span>
              </div>
              <ul className="mt-2 list-inside list-disc text-sm text-ink-200">
                {validationProblems(result).map((problem) => (
                  <li key={problem}>{problem}</li>
                ))}
              </ul>
            </div>
          ) : (
            <AiReplyCard
              reply={result.reply ?? ""}
              provider={result.provider}
              notice={result.notice}
              footer={
                <>
                  {result.parsed_by ? (
                    <p className="mt-2 text-[11px] text-ink-500">Parsed by {result.parsed_by}.</p>
                  ) : null}
                  {result.scenario ? (
                    <p className="mt-1 text-[11px] text-accent">
                      Scenario #{result.scenario.id} recorded — see it in Saved scenarios and Run history.
                    </p>
                  ) : null}
                </>
              }
            />
          )}
        </div>
      ) : null}
    </Panel>
  );
}
