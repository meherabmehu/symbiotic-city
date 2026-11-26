"use client";

/**
 * City Copilot -- the reference dashboard's floating assistant panel, in our
 * identity. Questions hit POST /api/ai/copilot; the reply shows its provider
 * label and links to the entities the backend actually retrieved (which are
 * scoped to this user's permissions on the server, not here).
 */

import { useState } from "react";
import { Send, TerminalSquare } from "lucide-react";
import { Button } from "@/components/ui";
import { AiError, AiLoading, AiReplyCard, useAiCall, type AiReplyPayload } from "@/components/ai/ai-block";

interface CopilotReply extends AiReplyPayload {
  lang: "en" | "bn";
  citations: NonNullable<AiReplyPayload["citations"]>;
}

const SUGGESTIONS = ["What is PS-01?", "Any open incidents?", "Which repair tasks are pending?"];

export function CityCopilot() {
  const [message, setMessage] = useState("");
  const [lang, setLang] = useState<"en" | "bn">("en");
  const { run, result, error, loading } = useAiCall<CopilotReply>();

  async function ask(text: string) {
    const trimmed = text.trim();
    if (!trimmed) return;
    setMessage(trimmed);
    await run("/ai/copilot", { message: trimmed, lang });
  }

  return (
    <section aria-label="City Copilot" className="rounded-2xl border border-white/10 bg-white/[0.02] p-4" data-testid="city-copilot">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-white">
          <TerminalSquare className="h-4 w-4 text-accent" aria-hidden />
          City Copilot
        </h2>
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
          placeholder={lang === "bn" ? "শহর সম্পর্কে প্রশ্ন করুন…" : "Ask about the city…"}
          aria-label="Question for the City Copilot"
          className="min-w-0 flex-1 rounded-lg border border-white/10 bg-navy-950/60 px-3 py-2 text-sm text-white placeholder:text-ink-500 focus:border-accent/50 focus:outline-none"
          maxLength={1200}
        />
        <Button type="submit" variant="primary" disabled={loading || !message.trim()} aria-label="Ask the copilot">
          <Send className="h-4 w-4" aria-hidden />
        </Button>
      </form>

      {SUGGESTIONS.some((hint) => hint.toLowerCase() === message.trim().toLowerCase()) ? null : (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {SUGGESTIONS.map((hint) => (
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

      {loading ? <AiLoading label="Reading the city records…" /> : null}
      {error ? <AiError message={error} /> : null}
      {result ? <AiReplyCard reply={result.reply ?? ""} provider={result.provider} citations={result.citations} /> : null}
    </section>
  );
}
