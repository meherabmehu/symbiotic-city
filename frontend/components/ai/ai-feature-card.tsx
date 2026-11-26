"use client";

/**
 * Button-triggered AI feature card: one request, honest provider label,
 * citations when the backend supplied them. Used by the incident explain,
 * recovery advisor and resilience report entries.
 */

import { Loader2, Sparkles } from "lucide-react";
import { Button, Panel, PanelHeader } from "@/components/ui";
import { AiError, AiReplyCard, replyText, useAiCall, type AiReplyPayload } from "@/components/ai/ai-block";

export function AiFeatureCard({
  title,
  subtitle,
  endpoint,
  body,
  buttonLabel,
  icon,
  testId,
}: {
  title: string;
  subtitle: string;
  endpoint: string;
  body?: Record<string, unknown>;
  buttonLabel: string;
  icon?: React.ReactNode;
  testId?: string;
}) {
  const { run, result, error, loading } = useAiCall<AiReplyPayload>();

  return (
    <Panel data-testid={testId}>
      <PanelHeader title={title} subtitle={subtitle} icon={icon ?? <Sparkles className="h-4 w-4" aria-hidden />} />
      <div className="mt-1">
        <Button
          variant="secondary"
          size="sm"
          disabled={loading}
          onClick={() => void run(endpoint, body ?? {})}
          aria-label={buttonLabel}
        >
          {loading ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Sparkles className="h-4 w-4" aria-hidden />}
          {buttonLabel}
        </Button>
        {loading ? <p className="mt-3 text-xs text-ink-400" role="status">Asking the assistant…</p> : null}
        {error ? <AiError message={error} /> : null}
        {result ? (
          <AiReplyCard
            reply={replyText(result)}
            provider={result.provider}
            citations={result.citations}
            notice={result.notice}
          />
        ) : null}
      </div>
    </Panel>
  );
}
