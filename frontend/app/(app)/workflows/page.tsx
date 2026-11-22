"use client";

/**
 * Recovery workflow console (list + start).
 *
 * This screen exists so the A07 advanced challenge can be demonstrated from the
 * UI: start a recovery workflow for an incident, optionally injecting a fault at
 * a named step, then inspect rollback/compensation and retry.
 */

import Link from "next/link";
import { useState } from "react";
import {
  AlertTriangle,
  ArrowUpRight,
  Bug,
  CheckCircle2,
  Play,
  RefreshCw,
  ShieldCheck,
  Workflow as WorkflowIcon,
} from "lucide-react";
import {
  Alert,
  Badge,
  Button,
  EmptyState,
  Field,
  Input,
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
import { formatDateTime, timeAgo, titleCase } from "@/lib/format";
import { useAsync } from "@/lib/hooks";
import type { Incident, ListResponse, Workflow } from "@/lib/types";

interface StepDef {
  key: string;
  label: string;
  automatic: boolean;
}

export default function WorkflowsPage() {
  const { can } = useAuth();
  const [tab, setTab] = useState<"" | "running" | "awaiting_approval" | "awaiting_field" | "failed" | "completed">("");
  const [refreshKey, setRefreshKey] = useState(0);
  const [starting, setStarting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [faultStep, setFaultStep] = useState("");
  const [incidentId, setIncidentId] = useState<number | null>(null);
  const [usePlan, setUsePlan] = useState(false);
  const [planId, setPlanId] = useState("");
  const [useRun, setUseRun] = useState(false);
  const [runId, setRunId] = useState("");

  const workflows = useAsync<{ rows: Workflow[]; total: number }>(
    async (signal) => {
      const response: ListResponse<Workflow> = await api.list(
        `/workflows${qs({ page_size: 50, status: tab })}`,
        { signal },
      );
      return { rows: response.data, total: response.meta.total };
    },
    [tab, refreshKey],
  );

  const steps = useAsync<StepDef[]>(() => api.get("/workflows/steps"), []);
  const incidents = useAsync<Incident[]>(
    async () => (await api.list<Incident>("/incidents?page_size=40&include_closed=false")).data,
    [refreshKey],
  );

  async function start() {
    if (!incidentId) {
      setError("Choose the incident this workflow should drive.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const query = qs({
        incident_id: incidentId,
        plan_id: usePlan ? planId : undefined,
        simulation_run_id: useRun ? runId : undefined,
        fail_at_step: faultStep || undefined,
      });
      const created = await api.raw<{ data: Workflow }>(`/workflows/start${query}`, { method: "POST" });
      setStarting(false);
      if (faultStep) {
        setNotice(
          `Workflow ${created.data.code} failed at ${faultStep.replace(/_/g, " ")} as injected. Open it to inspect the rollback and retry.`,
        );
      } else {
        setNotice(`Workflow ${created.data.code} started.`);
      }
      setFaultStep("");
      setRefreshKey((k) => k + 1);
    } catch (err) {
      const details = (err as { details?: { workflow_id?: number; fault_injected?: string } }).details;
      if (details?.fault_injected && details.workflow_id) {
        setStarting(false);
        setNotice(
          `Injected fault at ${details.fault_injected.replace(/_/g, " ")}. Workflow #${details.workflow_id} is persisted in its failed state with compensation applied.`,
        );
        setFaultStep("");
        setRefreshKey((k) => k + 1);
      } else {
        setError(errorMessage(err));
      }
    } finally {
      setBusy(false);
    }
  }

  const rows = workflows.data?.rows ?? [];

  return (
    <>
      <PageHeader
        eyebrow="Orchestration"
        title="Recovery workflows"
        description="A ten-step recovery chain with compensating actions. Faults can be injected at any pending step to prove rollback, and retries are idempotent so no capacity is reserved twice."
        actions={
          <>
            <Button variant="secondary" onClick={() => setRefreshKey((k) => k + 1)} loading={workflows.loading}>
              <RefreshCw className="h-4 w-4" aria-hidden /> Refresh
            </Button>
            {can("workflow:manage") ? (
              <Button onClick={() => { setError(null); setStarting(true); }}>
                <Play className="h-4 w-4" aria-hidden /> Start workflow
              </Button>
            ) : null}
          </>
        }
      >
        <div className="mt-4 flex flex-wrap gap-2">
          <Badge tone="accent">{steps.data?.length ?? 10} steps</Badge>
          <Badge tone="success">{steps.data?.filter((step) => step.automatic).length ?? 4} automatic</Badge>
          <Badge>{rows.filter((row) => row.status === "failed").length} failed</Badge>
        </div>
      </PageHeader>

      {error ? <Alert tone="danger" action={<Button variant="ghost" size="sm" onClick={() => setError(null)}>Dismiss</Button>}>{error}</Alert> : null}
      {notice ? <Alert tone="success" action={<Button variant="ghost" size="sm" onClick={() => setNotice(null)}>Dismiss</Button>}>{notice}</Alert> : null}

      <Tabs
        value={tab}
        onChange={setTab}
        label="Workflow status filter"
        tabs={[
          { id: "", label: "All" },
          { id: "running", label: "Running" },
          { id: "awaiting_approval", label: "Awaiting approval" },
          { id: "awaiting_field", label: "Awaiting field" },
          { id: "failed", label: "Failed" },
          { id: "completed", label: "Completed" },
        ]}
      />

      {workflows.loading && !workflows.data ? (
        <div className="grid place-items-center py-20"><Spinner label="Loading workflows…" /></div>
      ) : null}

      <div className="mt-4 grid gap-4 xl:grid-cols-[1fr_320px]">
        <div className="space-y-3">
          {!workflows.loading && rows.length === 0 ? (
            <EmptyState
              title="No workflows in this view"
              description="Start a recovery workflow for a reported or verified incident, or filter to another status."
              icon={<WorkflowIcon className="h-5 w-5" />}
            />
          ) : null}

          {rows.map((workflow) => {
            const done = workflow.completed_steps?.length ?? 0;
            return (
              <Panel key={workflow.id}>
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-[10px] text-ink-500">{workflow.code}</span>
                      <StatusPill status={workflow.status} />
                      {workflow.retry_count > 0 ? <Badge tone="warning">{workflow.retry_count} retries</Badge> : null}
                      {workflow.failure_step ? <Badge tone="danger">failed @ {workflow.failure_step.replace(/_/g, " ")}</Badge> : null}
                    </div>
                    <Link href={`/workflows/${workflow.id}`} className="mt-1 block text-sm font-medium text-white hover:text-accent">
                      {workflow.title}
                    </Link>
                    <p className="mt-0.5 text-[11px] text-ink-500">
                      step {done}/{steps.data?.length ?? 10} · current: {titleCase(workflow.current_step)} · started{" "}
                      {timeAgo(workflow.started_at)}
                    </p>
                    <div className="mt-2 h-1.5 w-full max-w-sm overflow-hidden rounded-full bg-white/10">
                      <div
                        className="h-full rounded-full bg-accent"
                        style={{ width: `${(done / Math.max(1, steps.data?.length ?? 10)) * 100}%` }}
                      />
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {workflow.incident_id ? (
                      <Link href={`/incidents/${workflow.incident_id}`} className="btn-ghost btn-sm">
                        Incident
                      </Link>
                    ) : null}
                    <Link href={`/workflows/${workflow.id}`} className="btn-secondary btn-sm">
                      Open <ArrowUpRight className="h-3 w-3" />
                    </Link>
                  </div>
                </div>
              </Panel>
            );
          })}
        </div>

        <div className="space-y-4">
          <Panel>
            <PanelHeader title="Recovery chain" subtitle="Ten ordered steps" icon={<WorkflowIcon className="h-4 w-4" />} />
            <ol className="space-y-1.5">
              {(steps.data ?? []).map((step, index) => (
                <li key={step.key} className="flex items-center gap-2 text-[11px]">
                  <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full border border-white/10 text-[9px] text-ink-400">
                    {index + 1}
                  </span>
                  <span className="flex-1 text-ink-300">{step.label}</span>
                  {step.automatic ? <Badge tone="accent">auto</Badge> : <Badge>manual</Badge>}
                </li>
              ))}
            </ol>
          </Panel>

          <Panel>
            <PanelHeader title="Failure handling" icon={<ShieldCheck className="h-4 w-4" />} />
            <ul className="space-y-2 text-[11px] leading-relaxed text-ink-400">
              <li>
                <span className="text-ink-200">Compensation:</span> if a reservation step fails mid-way, every capacity
                hold created by the attempt is released before the workflow is marked failed.
              </li>
              <li>
                <span className="text-ink-200">No duplicate holds:</span> retries reuse the workflow row and reservation
                idempotency keys, so a retried attempt cannot double-book a generator.
              </li>
              <li>
                <span className="text-ink-200">Honest state:</span> a failed workflow stays failed and visible — the
                backend never reports success for a compensated run.
              </li>
            </ul>
          </Panel>

          <Panel>
            <PanelHeader title="Demo path" icon={<Bug className="h-4 w-4" />} />
            <p className="text-[11px] leading-relaxed text-ink-400">
              Use <span className="text-ink-200">Start workflow</span> with a fault at{" "}
              <code className="rounded bg-white/10 px-1 font-mono text-[10px]">resources_reserved</code> to trigger a
              real mid-transaction failure: the first reservation commits, the second fails, compensation releases the
              first. Then retry from the workflow console.
            </p>
          </Panel>
        </div>
      </div>

      <Modal
        open={starting}
        onClose={() => setStarting(false)}
        title="Start recovery workflow"
        description="The workflow advances automatically through the first four steps, then waits for a plan approval."
        footer={
          <>
            <Button variant="ghost" onClick={() => setStarting(false)} disabled={busy}>Cancel</Button>
            <Button onClick={start} loading={busy}>Start workflow</Button>
          </>
        }
      >
        {error ? <Alert tone="danger">{error}</Alert> : null}
        <div className="mt-3 space-y-3">
          <Field label="Incident" htmlFor="wf-incident" required hint="Only reported or verified incidents can start a workflow.">
            <Select
              id="wf-incident"
              value={incidentId ?? ""}
              onChange={(event) => setIncidentId(Number(event.target.value) || null)}
            >
              <option value="">Choose an incident…</option>
              {(incidents.data ?? []).map((incident) => (
                <option key={incident.id} value={incident.id}>
                  {incident.code} — {incident.title} ({incident.status})
                </option>
              ))}
            </Select>
          </Field>

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="flex items-center gap-2 text-xs text-ink-300">
                <input type="checkbox" className="h-3.5 w-3.5 accent-[#45d8f5]" checked={usePlan} onChange={(e) => setUsePlan(e.target.checked)} />
                Attach optimisation plan
              </label>
              {usePlan ? (
                <Input className="mt-1" value={planId} onChange={(e) => setPlanId(e.target.value)} placeholder="plan id" aria-label="Plan id" />
              ) : null}
            </div>
            <div>
              <label className="flex items-center gap-2 text-xs text-ink-300">
                <input type="checkbox" className="h-3.5 w-3.5 accent-[#45d8f5]" checked={useRun} onChange={(e) => setUseRun(e.target.checked)} />
                Attach simulation run
              </label>
              {useRun ? (
                <Input className="mt-1" value={runId} onChange={(e) => setRunId(e.target.value)} placeholder="run id" aria-label="Run id" />
              ) : null}
            </div>
          </div>

          <Field
            label="Inject fault at step"
            htmlFor="wf-fault"
            hint="Demonstration only: schedules a controlled failure at this step."
          >
            <Select id="wf-fault" value={faultStep} onChange={(event) => setFaultStep(event.target.value)}>
              <option value="">No fault — run normally</option>
              {(steps.data ?? []).map((step) => (
                <option key={step.key} value={step.key}>
                  {step.label} ({step.key})
                </option>
              ))}
            </Select>
          </Field>

          {faultStep ? (
            <Alert tone="warning" title="Controlled failure will be raised">
              The workflow will stop at <span className="font-mono text-xs">{faultStep}</span>, apply compensating
              actions for anything already written, and remain in a failed state until retried.
            </Alert>
          ) : (
            <Alert tone="info">
              <CheckCircle2 className="mr-1 inline h-3 w-3" /> A clean run stops at plan approval, then continues once
              the operator approves the recovery plan.
            </Alert>
          )}
          {incidents.data?.length === 0 ? (
            <Alert tone="warning">
              No open incidents. <Link href="/incidents" className="link">Report one</Link> or run a simulation with{" "}
              create-incident enabled.
            </Alert>
          ) : null}
        </div>
      </Modal>
    </>
  );
}
