"use client";

/**
 * City Copilot & AI Disaster Commander — dual-mode assistant panel on /dashboard.
 *
 * - City Copilot: POST /api/ai/copilot (RBAC-scoped DB Q&A)
 * - AI Disaster Commander: POST /api/ai/commander (read-only cascade simulation
 *   + CP-SAT recovery preview + 3D twin highlight & action links)
 */

import Link from "next/link";
import { useState } from "react";
import { ArrowUpRight, Send, ShieldAlert, TerminalSquare } from "lucide-react";
import { Badge, Button } from "@/components/ui";
import { AiError, AiLoading, AiReplyCard, useAiCall, type AiReplyPayload } from "@/components/ai/ai-block";
import { formatNumber } from "@/lib/format";

interface CopilotReply extends AiReplyPayload {
  lang: "en" | "bn";
  citations: NonNullable<AiReplyPayload["citations"]>;
}

interface CommanderReply extends AiReplyPayload {
  lang: "en" | "bn";
  resolution?: {
    status: "resolved" | "ambiguous" | "unknown" | "missing";
    assets: { id: number; code: string; name: string }[];
    candidates: { id: number; code: string; name: string; category: string }[];
  };
  sections?: {
    population_at_risk: number;
    cascading_impact: {
      direct_failures: string[];
      cascading_failures: string[];
      max_depth_reached: number;
    };
    resource_constraints: {
      solver_status: string;
      coverage_percent: number;
    };
  } | null;
  simulation?: {
    summary: {
      assets_failed: number;
      affected_population: number;
      max_depth_reached: number;
      severity_index: number;
      severity_band: string;
    };
    failed_asset_ids: number[];
  } | null;
  next_actions?: { label: string; href: string }[];
}

const COPILOT_SUGGESTIONS = ["What is PS-01?", "Any open incidents?", "Which repair tasks are pending?"];
const COMMANDER_SUGGESTIONS = [
  "If PS-01 fails, what happens to Aurora Vale, and what should we do first?",
  "What happens if SS-01 fails?",
  "If PS-02 fails, which hospital is impacted and what resources do we need?",
];

export function CityCopilot() {
  const [mode, setMode] = useState<"copilot" | "commander">("copilot");
  const [message, setMessage] = useState("");
  const [lang, setLang] = useState<"en" | "bn">("en");
  const copilotCall = useAiCall<CopilotReply>();
  const commanderCall = useAiCall<CommanderReply>();

  const activeCall = mode === "copilot" ? copilotCall : commanderCall;
  const suggestions = mode === "copilot" ? COPILOT_SUGGESTIONS : COMMANDER_SUGGESTIONS;

  async function ask(text: string) {
    const trimmed = text.trim();
    if (!trimmed) return;
    setMessage(trimmed);
    if (mode === "copilot") {
      await copilotCall.run("/ai/copilot", { message: trimmed, lang });
    } else {
      await commanderCall.run("/ai/commander", { question: trimmed, lang });
    }
  }

  return (
    <section aria-label="City Copilot and AI Disaster Commander" className="rounded-2xl border border-white/10 bg-white/[0.02] p-4" data-testid="city-copilot">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1 rounded-lg border border-white/10 bg-navy-950/60 p-0.5" role="tablist" aria-label="AI Assistant Mode">
            <button
              type="button"
              role="tab"
              aria-selected={mode === "copilot"}
              onClick={() => setMode("copilot")}
              className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-semibold transition ${
                mode === "copilot" ? "bg-accent/20 text-accent" : "text-ink-400 hover:text-ink-200"
              }`}
            >
              <TerminalSquare className="h-3.5 w-3.5" aria-hidden />
              City Copilot
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === "commander"}
              onClick={() => setMode("commander")}
              className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-semibold transition ${
                mode === "commander" ? "bg-coral/20 text-coral" : "text-ink-400 hover:text-ink-200"
              }`}
            >
              <ShieldAlert className="h-3.5 w-3.5" aria-hidden />
              Disaster Commander
            </button>
          </div>
        </div>

        <div className="flex items-center gap-1 rounded-lg border border-white/10 bg-navy-950/60 p-0.5" role="group" aria-label="Reply language">
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
      </div>

      <form
        className="mt-3 flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void ask(message);
        }}
      >
        <input
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          placeholder={
            mode === "commander"
              ? lang === "bn"
                ? "বিপর্যয় পরিস্থিতি লিখুন (যেমন: PS-01 ব্যর্থ হলে কী হবে?)…"
                : "Ask a disaster scenario (e.g. If PS-01 fails, what happens?)…"
              : lang === "bn"
              ? "শহর সম্পর্কে প্রশ্ন করুন…"
              : "Ask about the city…"
          }
          aria-label={mode === "commander" ? "Question for the AI Disaster Commander" : "Question for the City Copilot"}
          className="min-w-0 flex-1 rounded-lg border border-white/10 bg-navy-950/60 px-3 py-2 text-sm text-white placeholder:text-ink-500 focus:border-accent/50 focus:outline-none"
          maxLength={1200}
        />
        <Button
          type="submit"
          variant="primary"
          disabled={activeCall.loading || !message.trim()}
          aria-label={mode === "commander" ? "Ask the commander" : "Ask the copilot"}
        >
          <Send className="h-4 w-4" aria-hidden />
        </Button>
      </form>

      {suggestions.some((hint) => hint.toLowerCase() === message.trim().toLowerCase()) ? null : (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {suggestions.map((hint) => (
            <button
              key={hint}
              type="button"
              onClick={() => void ask(hint)}
              className="rounded-full border border-white/10 px-2.5 py-1 text-[11px] text-ink-400 transition hover:border-accent/40 hover:text-ink-200"
            >
              {hint}
            </button>
          ))}
        </div>
      )}

      {activeCall.loading ? (
        <AiLoading
          label={
            mode === "commander"
              ? "Running deterministic cascade & CP-SAT preview…"
              : "Reading the city records…"
          }
        />
      ) : null}
      {activeCall.error ? <AiError message={activeCall.error} /> : null}

      {mode === "copilot" && copilotCall.result ? (
        <AiReplyCard
          reply={copilotCall.result.reply ?? ""}
          provider={copilotCall.result.provider}
          citations={copilotCall.result.citations}
          notice={copilotCall.result.notice}
        />
      ) : null}

      {mode === "commander" && commanderCall.result ? (
        <div className="mt-3 space-y-3">
          {commanderCall.result.simulation ? (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <div className="rounded-xl border border-white/10 bg-navy-950/50 p-2.5 text-xs">
                <div className="text-ink-400">Assets Failed</div>
                <div className="mt-0.5 text-base font-bold text-coral">
                  {commanderCall.result.simulation.summary.assets_failed}
                </div>
              </div>
              <div className="rounded-xl border border-white/10 bg-navy-950/50 p-2.5 text-xs">
                <div className="text-ink-400">Population at Risk</div>
                <div className="mt-0.5 text-base font-bold text-white">
                  {formatNumber(commanderCall.result.simulation.summary.affected_population)}
                </div>
              </div>
              <div className="rounded-xl border border-white/10 bg-navy-950/50 p-2.5 text-xs">
                <div className="text-ink-400">Severity</div>
                <div className="mt-0.5 flex items-center gap-1.5">
                  <span className="text-base font-bold text-amber">
                    {commanderCall.result.simulation.summary.severity_index}
                  </span>
                  <Badge tone="warning">{commanderCall.result.simulation.summary.severity_band}</Badge>
                </div>
              </div>
              <div className="rounded-xl border border-white/10 bg-navy-950/50 p-2.5 text-xs">
                <div className="text-ink-400">CP-SAT Coverage</div>
                <div className="mt-0.5 text-base font-bold text-mint">
                  {commanderCall.result.sections?.resource_constraints.coverage_percent ?? 0}%
                </div>
              </div>
            </div>
          ) : null}

          {commanderCall.result.resolution &&
          commanderCall.result.resolution.status !== "resolved" &&
          commanderCall.result.resolution.candidates.length > 0 ? (
            <div className="flex flex-wrap items-center gap-1.5 rounded-xl border border-amber/30 bg-amber/10 p-2.5 text-xs">
              <span className="text-amber font-medium">Pick a specific asset:</span>
              {commanderCall.result.resolution.candidates.slice(0, 6).map((c) => (
                <button
                  key={c.code}
                  type="button"
                  onClick={() => void ask(`If ${c.code} fails, what happens and what should we do first?`)}
                  className="rounded-full border border-amber/40 bg-navy-950/60 px-2.5 py-0.5 text-white hover:border-accent"
                >
                  {c.code} — {c.name}
                </button>
              ))}
            </div>
          ) : null}

          <AiReplyCard
            reply={commanderCall.result.reply ?? ""}
            provider={commanderCall.result.provider}
            citations={commanderCall.result.citations}
            notice={commanderCall.result.notice}
          />

          {commanderCall.result.next_actions && commanderCall.result.next_actions.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {commanderCall.result.next_actions.map((act) => (
                <Link
                  key={act.href}
                  href={act.href}
                  className="inline-flex items-center gap-1 rounded-lg border border-white/15 bg-white/[0.04] px-3 py-1.5 text-xs font-medium text-accent transition hover:border-accent/40 hover:bg-accent/10"
                >
                  {act.label}
                  <ArrowUpRight className="h-3.5 w-3.5" aria-hidden />
                </Link>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
