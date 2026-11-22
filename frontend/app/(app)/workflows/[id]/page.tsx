"use client";

/**
 * Workflow console — step timeline, compensation evidence, fault injection and
 * retry. This is the screen that demonstrates A07 end to end.
 */

import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  Bug,
  CheckCircle2,
  Circle,
  CircleSlash,
  GitBranch,
  History,
  RefreshCw,
  RotateCcw,
  Workflow as WorkflowIcon,
  XCircle,
} from "lucide-react";
import {
  Alert,
  Badge,
  Button,
  Field,
  Modal,
  PageHeader,
  Panel,
  PanelHeader,
  Select,
  Spinner,
  StatusPill,
  Tabs,
} from "@/components/ui";
import { api, errorMessage, qs } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatDateTime, titleCase, timeAgo } from "@/lib/format";
import { useAsync } from "@/lib/hooks";
import type { Workflow } from "@/lib/types";

interface StepDef {
  key: string;
  label: string;
  automatic: boolean;
}

export default function WorkflowDetailPage() {
  const params = useParams<{ id: string }>();
  const id = Number(params.id);
  const { can } = useAuth();
  const [refreshKey, setRefreshKey] = useState(0);
  const [faultOpen, setFaultOpen] = useState(false);
  const [faultStep, setFaultStep] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [tab, setTab] = useState<"steps" | "events">("steps");

  const workflow = useAsync<Workflow>(() => api.get(`/workflows/${id}`), [id, refreshKey]);
  const steps = useAsync<StepDef[]>(() => api.get("/workflows/steps"), []);

  async function retry() {
    setBusy("retry");
    setError(null);
    try {
      const updated = await api.post<Workflow>(`/workflows/${id}/retry`);
      setNotice(`Retry accepted. Workflow is now ${updated.status.replace(/_/g, " ")} at ${updated.current_step}.`);
      setRefreshKey((k) => k + 1);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  async function injectFault() {
    if (!faultStep) {
      setError("Choose the step where the fault should fire.");
      return;
    }
    setBusy("fault");
    setError(null);
    try {
      await api.post(`/workflows/${id}/simulate-failure${qs({ step: faultStep })}`);
      setNotice(`Fault scheduled at ${faultStep}. It fires the next time that step executes.`);
      setFaultOpen(false);
      setRefreshKey((k) => k + 1);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  const data = workflow.data;

  if (workflow.loading && !data) {
    return <div className="grid place-items-center py-24"><Spinner label="Loading workflow…" /></div>;
  }

  if (!data) {
    return (
      <Alert tone="danger" title="Workflow not found">
        {workflow.error ?? "This workflow does not exist."}
        <div className="mt-3">
          <Link href="/workflows" className="btn-secondary btn-sm">Back to workflows</Link>
        </div>
      </Alert>
    );
  }

  const orderedSteps = steps.data ?? [];
  const completed = new Set(data.completed_steps ?? []);
  const failedEvents = (data.events ?? []).filter((event) => event.outcome !== "succeeded");
  const compensationEvents = failedEvents.filter((event) => /compensat|release|rollback/i.test(event.message));

  return (
    <>
      <div className="mb-4">
        <Link href="/workflows" className="inline-flex items-center gap-1.5 text-xs text-ink-400 hover:text-white">
          <ArrowLeft className="h-3.5 w-3.5" /> Recovery workflows
        </Link>
      </div>

      <PageHeader
        eyebrow={`${data.code} · ${titleCase(data.workflow_type)}`}
        title={data.title}
        description={`Current step: ${titleCase(data.current_step)} · ${completed.size} of ${orderedSteps.length} steps complete · attempt ${data.retry_count + 1}`}
        actions={
          <>
            <Button variant="secondary" onClick={() => setRefreshKey((k) => k + 1)} loading={workflow.loading}>
              <RefreshCw className="h-4 w-4" aria-hidden /> Refresh
            </Button>
            {data.status === "failed" && can("workflow:manage") ? (
              <Button onClick={retry} loading={busy === "retry"}>
                <RotateCcw className="h-4 w-4" aria-hidden /> Retry workflow
              </Button>
            ) : null}
            {can("workflow:manage") && data.status !== "completed" ? (
              <Button variant="secondary" onClick={() => { setError(null); setFaultStep(""); setFaultOpen(true); }}>
                <Bug className="h-4 w-4" aria-hidden /> Inject fault
              </Button>
            ) : null}
          </>
        }
      >
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <StatusPill status={data.status} />
          {data.failure_step ? (
            <Badge tone="danger">
              <XCircle className="h-3 w-3" /> failed at {data.failure_step.replace(/_/g, " ")}
            </Badge>
          ) : null}
          {data.retry_count > 0 ? <Badge tone="warning">{data.retry_count} retries</Badge> : null}
          {data.incident_id ? (
            <Link href={`/incidents/${data.incident_id}`} className="badge border border-accent/30 bg-accent/10 text-accent">
              incident #{data.incident_id}
            </Link>
          ) : null}
          {data.plan_id ? (
            <Link href={`/optimization/plans/${data.plan_id}`} className="badge border border-accent/30 bg-accent/10 text-accent">
              plan #{data.plan_id}
            </Link>
          ) : null}
          {data.simulation_run_id ? (
            <Link href={`/simulations/${data.simulation_run_id}`} className="badge">
              run #{data.simulation_run_id}
            </Link>
          ) : null}
        </div>
      </PageHeader>

      {error ? <Alert tone="danger" title="Action failed">{error}</Alert> : null}
      {notice ? <Alert tone="success" action={<Button variant="ghost" size="sm" onClick={() => setNotice(null)}>Dismiss</Button>}>{notice}</Alert> : null}

      {data.status === "failed" ? (
        <Alert tone="danger" title="This workflow stopped on a controlled failure">
          {data.failure_reason ?? "A step raised a failure and the workflow halted."}
          {compensationEvents.length ? (
            <ul className="mt-2 space-y-1">
              {compensationEvents.map((event) => (
                <li key={event.id} className="text-xs text-ink-300">
                  • {event.message}
                </li>
              ))}
            </ul>
          ) : null}
          <p className="mt-2 text-xs text-ink-400">
            Compensation ran before the failure was recorded: every capacity hold created by this attempt was released.
            Retry is idempotent and will not double-book resources.
          </p>
        </Alert>
      ) : null}

      {data.status === "awaiting_approval" ? (
        <Alert tone="warning" title="Waiting for operator approval">
          The plan is generated and validated. Approving it reserves resources transactionally and dispatches repair
          tasks.{" "}
          {data.plan_id ? (
            <Link href={`/optimization/plans/${data.plan_id}`} className="link">
              Open the plan
            </Link>
          ) : null}
        </Alert>
      ) : null}

      {data.status === "awaiting_field" ? (
        <Alert tone="info" title="Waiting for field execution">
          Repair tasks have been dispatched. The workflow advances when engineers accept and complete work, then an
          operator verifies the repairs.
        </Alert>
      ) : null}

      <div className="grid gap-4 xl:grid-cols-[1fr_340px]">
        <Panel>
          <Tabs
            value={tab}
            onChange={setTab}
            label="Workflow detail views"
            tabs={[
              { id: "steps", label: "Step timeline", count: orderedSteps.length },
              { id: "events", label: "Event ledger", count: data.events?.length },
            ]}
          />
          <div className="mt-4">
            {tab === "steps" ? (
              <ol className="space-y-3">
                {orderedSteps.map((step, index) => {
                  const isDone = completed.has(step.key);
                  const isFailed = data.failure_step === step.key;
                  const isCurrent = data.current_step === step.key && !isFailed;
                  return (
                    <li key={step.key} className="relative flex gap-3 pb-1">
                      <div className="flex flex-col items-center">
                        <span
                          className={`grid h-7 w-7 shrink-0 place-items-center rounded-full border ${
                            isFailed
                              ? "border-coral/50 bg-coral/15 text-coral"
                              : isDone
                                ? "border-mint/50 bg-mint/15 text-mint"
                                : isCurrent
                                  ? "border-accent/60 bg-accent/15 text-accent"
                                  : "border-white/10 bg-white/[0.03] text-ink-600"
                          }`}
                        >
                          {isFailed ? (
                            <XCircle className="h-3.5 w-3.5" />
                          ) : isDone ? (
                            <CheckCircle2 className="h-3.5 w-3.5" />
                          ) : isCurrent ? (
                            <GitBranch className="h-3.5 w-3.5" />
                          ) : (
                            <Circle className="h-3 w-3" />
                          )}
                        </span>
                        {index < orderedSteps.length - 1 ? (
                          <span className={`mt-1 h-full w-px ${isDone ? "bg-mint/30" : "bg-white/10"}`} aria-hidden />
                        ) : null}
                      </div>
                      <div className="flex-1 pb-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className={`text-sm ${isDone || isCurrent || isFailed ? "font-medium text-white" : "text-ink-500"}`}>
                            {step.label}
                          </p>
                          {step.automatic ? <Badge tone="accent">auto</Badge> : <Badge>manual</Badge>}
                          {isFailed ? <Badge tone="danger">failed</Badge> : null}
                          {isCurrent ? <Badge tone="accent">current</Badge> : null}
                        </div>
                        <p className="font-mono text-[10px] text-ink-600">{step.key}</p>
                        {isFailed && data.failure_reason ? (
                          <p className="mt-1 rounded-lg border border-coral/25 bg-coral/[0.06] px-2 py-1 text-[11px] text-coral">
                            {data.failure_reason}
                          </p>
                        ) : null}
                      </div>
                    </li>
                  );
                })}
              </ol>
            ) : (
              <ul className="space-y-2">
                {(data.events ?? []).map((event) => (
                  <li key={event.id} className="rounded-xl border border-white/10 bg-white/[0.02] px-3 py-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="flex items-center gap-1.5 text-[11px]">
                        {event.outcome === "succeeded" ? (
                          <CheckCircle2 className="h-3 w-3 text-mint" />
                        ) : (
                          <CircleSlash className="h-3 w-3 text-coral" />
                        )}
                        <span className="font-mono text-[10px] text-ink-500">{event.step}</span>
                        <span className={event.outcome === "succeeded" ? "text-mint" : "text-coral"}>{event.outcome}</span>
                        <span className="text-ink-600">attempt {event.attempt}</span>
                      </span>
                      <span className="text-[10px] text-ink-500">{formatDateTime(event.created_at)}</span>
                    </div>
                    <p className="mt-1 text-xs text-ink-300">{event.message}</p>
                  </li>
                ))}
                {!data.events?.length ? (
                  <li className="py-6 text-center text-xs text-ink-500">No events recorded yet.</li>
                ) : null}
              </ul>
            )}
          </div>
        </Panel>

        <div className="space-y-4">
          <Panel>
            <PanelHeader title="Progress" icon={<WorkflowIcon className="h-4 w-4" />} />
            <div className="flex items-baseline gap-2">
              <span className="font-display text-3xl font-semibold text-white">{completed.size}</span>
              <span className="text-sm text-ink-400">/ {orderedSteps.length} steps</span>
            </div>
            <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-white/10">
              <div
                className="h-full rounded-full bg-gradient-to-r from-accent to-mint transition-all"
                style={{ width: `${(completed.size / Math.max(1, orderedSteps.length)) * 100}%` }}
              />
            </div>
            <dl className="mt-3 space-y-1.5 text-[11px]">
              <div className="flex justify-between">
                <dt className="text-ink-500">Started</dt>
                <dd className="text-ink-200">{formatDateTime(data.started_at)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-ink-500">Last update</dt>
                <dd className="text-ink-200">{timeAgo(data.updated_at)}</dd>
              </div>
              {data.completed_at ? (
                <div className="flex justify-between">
                  <dt className="text-ink-500">Completed</dt>
                  <dd className="text-mint">{formatDateTime(data.completed_at)}</dd>
                </div>
              ) : null}
              <div className="flex justify-between">
                <dt className="text-ink-500">Attempts</dt>
                <dd className="text-ink-200">{data.retry_count + 1}</dd>
              </div>
            </dl>
          </Panel>

          {data.next_actions?.length ? (
            <Panel>
              <PanelHeader title="Next actions" subtitle="What the system expects next" />
              <ul className="space-y-1.5">
                {data.next_actions.map((action) => (
                  <li key={action} className="rounded-lg bg-white/[0.03] px-2.5 py-1.5 text-[11px] text-ink-300">
                    {titleCase(action)}
                  </li>
                ))}
              </ul>
            </Panel>
          ) : null}

          <Panel>
            <PanelHeader title="Compensation" subtitle="How rollback is guaranteed" icon={<AlertTriangle className="h-4 w-4" />} />
            <ul className="space-y-2 text-[11px] leading-relaxed text-ink-400">
              <li>Every step that writes to the database registers a compensating action.</li>
              <li>
                On failure the engine runs those actions in reverse order — released reservations, cancelled tasks,
                cleared plan links — then flips the workflow to failed.
              </li>
              <li>
                {failedEvents.length} non-success event{failedEvents.length === 1 ? "" : "s"} recorded on this workflow
                {compensationEvents.length ? `, ${compensationEvents.length} of them compensation` : ""}.
              </li>
            </ul>
          </Panel>

          <Panel>
            <PanelHeader title="Event ledger" subtitle="Server-side truth" icon={<History className="h-4 w-4" />} />
            <p className="text-[11px] text-ink-400">
              {(data.events ?? []).length} events recorded. Every state change is append-only; nothing is edited after
              the fact.
            </p>
            <Button variant="ghost" size="sm" className="mt-2 w-full" onClick={() => setTab("events")}>
              Inspect ledger
            </Button>
          </Panel>
        </div>
      </div>

      <Modal
        open={faultOpen}
        onClose={() => setFaultOpen(false)}
        title="Inject a controlled failure"
        description="The fault fires when the workflow next executes that step. Pending steps only."
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setFaultOpen(false)} disabled={busy === "fault"}>Cancel</Button>
            <Button variant="danger" onClick={injectFault} loading={busy === "fault"}>Schedule fault</Button>
          </>
        }
      >
        <div className="space-y-3">
          <Field label="Step" htmlFor="fault-step" required hint="Pick a step that has not completed yet.">
            <Select id="fault-step" value={faultStep} onChange={(event) => setFaultStep(event.target.value)}>
              <option value="">Choose a step…</option>
              {orderedSteps
                .filter((step) => !completed.has(step.key))
                .map((step) => (
                  <option key={step.key} value={step.key}>
                    {step.label} ({step.key})
                  </option>
                ))}
            </Select>
          </Field>
          <Alert tone="warning" title="This will deliberately fail the workflow">
            Compensation releases anything written by this attempt. The workflow stays failed until someone retries it
            — success is never reported for a compensated run.
          </Alert>
          {error ? <Alert tone="danger">{error}</Alert> : null}
        </div>
      </Modal>
    </>
  );
}
