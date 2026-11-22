"use client";

/**
 * Incident detail — state machine controls, affected assets, linked workflow,
 * repair tasks and the incident event ledger.
 */

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  Cpu,
  GitBranch,
  ListChecks,
  RotateCcw,
  Workflow as WorkflowIcon,
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
  SeverityBadge,
  Spinner,
  StatusPill,
  Textarea,
} from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatDateTime, formatNumber, timeAgo, titleCase } from "@/lib/format";
import { useAsync } from "@/lib/hooks";
import type { Incident, RepairTask, Workflow } from "@/lib/types";

export default function IncidentDetailPage() {
  const params = useParams<{ id: string }>();
  const id = Number(params.id);
  const router = useRouter();
  const { can } = useAuth();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [transitioning, setTransitioning] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [resolutionNotes, setResolutionNotes] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);

  const incident = useAsync<Incident>(() => api.get(`/incidents/${id}`), [id, refreshKey]);
  const tasks = useAsync<RepairTask[]>(
    async () => (await api.list<RepairTask>(`/tasks?incident_id=${id}&page_size=60`)).data,
    [id, refreshKey],
  );
  const workflow = useAsync<Workflow | null>(async () => {
    const current = incident.data;
    if (!current?.workflow_id) return null;
    return api.get<Workflow>(`/workflows/${current.workflow_id}`);
  }, [incident.data?.workflow_id, refreshKey]);

  useEffect(() => {
    if (incident.error) setError(incident.error);
  }, [incident.error]);

  async function doTransition(target: string) {
    setBusy(target);
    setError(null);
    try {
      await api.post(`/incidents/${id}/transition`, {
        status: target,
        note: note || `Transitioned to ${target.replace(/_/g, " ")} via console.`,
        resolution_notes: target === "resolved" ? resolutionNotes || null : undefined,
      });
      setNotice(`Incident moved to ${target.replace(/_/g, " ")}.`);
      setTransitioning(null);
      setNote("");
      setResolutionNotes("");
      setRefreshKey((k) => k + 1);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  async function reopen() {
    setBusy("reopen");
    setError(null);
    try {
      await api.post(`/incidents/${id}/reopen`);
      setNotice("Incident reopened for verification.");
      setRefreshKey((k) => k + 1);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  const data = incident.data;

  if (incident.loading && !data) {
    return (
      <div className="grid place-items-center py-24">
        <Spinner label="Loading incident…" />
      </div>
    );
  }

  if (!data) {
    return (
      <Alert tone="danger" title="Incident not found">
        {error ?? "The requested incident does not exist or you do not have access to it."}
        <div className="mt-3">
          <Link href="/incidents" className="btn-secondary btn-sm">Back to incidents</Link>
        </div>
      </Alert>
    );
  }

  const allowed = data.allowed_transitions ?? [];

  return (
    <>
      <div className="mb-4">
        <Link href="/incidents" className="inline-flex items-center gap-1.5 text-xs text-ink-400 hover:text-white">
          <ArrowLeft className="h-3.5 w-3.5" /> All incidents
        </Link>
      </div>

      <PageHeader
        eyebrow={`${data.code} · ${titleCase(data.category)}`}
        title={data.title}
        description={data.description || "No description was recorded for this incident."}
        actions={
          <>
            {data.status === "resolved" && can("incident:write") ? (
              <Button variant="secondary" onClick={reopen} loading={busy === "reopen"}>
                <RotateCcw className="h-4 w-4" aria-hidden /> Reopen
              </Button>
            ) : null}
            {allowed.length > 0 && can("incident:read") ? (
              <Button onClick={() => setTransitioning(allowed[0])}>
                <CheckCircle2 className="h-4 w-4" aria-hidden /> Advance status
              </Button>
            ) : null}
          </>
        }
      >
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <SeverityBadge severity={data.severity} />
          <StatusPill status={data.status} />
          <Badge>{formatNumber(data.affected_population)} residents</Badge>
          <Badge>Reported {timeAgo(data.reported_at)}</Badge>
          {data.primary_asset_code ? <Badge tone="accent">{data.primary_asset_code}</Badge> : null}
        </div>
      </PageHeader>

      {error ? <Alert tone="danger" title="Action failed">{error}</Alert> : null}
      {notice ? <Alert tone="success" action={<Button variant="ghost" size="sm" onClick={() => setNotice(null)}>Dismiss</Button>}>{notice}</Alert> : null}

      <div className="grid gap-4 xl:grid-cols-[1fr_360px]">
        <div className="space-y-4">
          <Panel>
            <PanelHeader
              title="Lifecycle"
              subtitle="Validated state machine — only legal transitions are offered"
              icon={<GitBranch className="h-4 w-4" />}
            />
            <ol className="relative space-y-3 border-l border-white/10 pl-5">
              {["reported", "verified", "planning", "approved", "in_progress", "resolved"].map((step) => {
                const order = ["reported", "verified", "planning", "approved", "in_progress", "resolved"];
                const currentIndex = order.indexOf(data.status);
                const index = order.indexOf(step);
                const done = currentIndex >= index && data.status !== "cancelled";
                const current = data.status === step;
                return (
                  <li key={step} className="relative">
                    <span
                      className={`absolute -left-[26px] top-1 grid h-3.5 w-3.5 place-items-center rounded-full border ${
                        current
                          ? "border-accent bg-accent"
                          : done
                            ? "border-mint bg-mint"
                            : "border-white/20 bg-navy-900"
                      }`}
                      aria-hidden
                    />
                    <p className={current ? "text-sm font-semibold text-white" : done ? "text-sm text-ink-200" : "text-sm text-ink-500"}>
                      {titleCase(step)}
                    </p>
                    {current ? <p className="text-[11px] text-accent">Current state</p> : null}
                  </li>
                );
              })}
              {data.status === "cancelled" ? (
                <li className="text-sm text-coral">Cancelled — no further transitions are permitted.</li>
              ) : null}
            </ol>

            {allowed.length > 0 ? (
              <div className="mt-4 rounded-xl border border-white/10 bg-white/[0.03] p-3">
                <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-500">
                  Allowed next states
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {allowed.map((target) => (
                    <Button
                      key={target}
                      variant={target === "cancelled" ? "danger" : "secondary"}
                      size="sm"
                      onClick={() => { setError(null); setTransitioning(target); }}
                    >
                      {titleCase(target)}
                    </Button>
                  ))}
                </div>
              </div>
            ) : null}
          </Panel>

          <Panel>
            <PanelHeader
              title="Repair tasks"
              subtitle={`${tasks.data?.length ?? 0} tasks · ${data.open_task_count} still open`}
              icon={<ListChecks className="h-4 w-4" />}
              action={<Link href="/tasks" className="btn-ghost btn-sm">Dispatch board</Link>}
            />
            {tasks.data?.length ? (
              <ul className="space-y-2">
                {tasks.data.map((task) => (
                  <li key={task.id}>
                    <Link
                      href={`/tasks/${task.id}`}
                      className="flex items-center justify-between gap-3 rounded-xl border border-white/10 bg-white/[0.02] px-3 py-2 transition hover:border-accent/30"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm text-white">{task.title}</p>
                        <p className="text-[11px] text-ink-500">
                          {task.code} · {task.asset_code ?? "asset"} · {task.assignee_name ?? "unassigned"} · P{task.priority}
                        </p>
                      </div>
                      <StatusPill status={task.status} />
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="py-6 text-center text-sm text-ink-400">
                No repair tasks yet. Approving a recovery plan creates and assigns them automatically.
              </p>
            )}
          </Panel>

          <Panel>
            <PanelHeader title="Event ledger" subtitle="Immutable record of everything that happened" icon={<AlertTriangle className="h-4 w-4" />} />
            {data.events?.length ? (
              <ul className="space-y-2">
                {data.events.map((event) => (
                  <li key={event.id} className="rounded-xl border border-white/10 bg-white/[0.02] px-3 py-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[11px] uppercase tracking-wider text-accent">{titleCase(event.event_type)}</span>
                      <span className="text-[10px] text-ink-500">{formatDateTime(event.created_at)}</span>
                    </div>
                    <p className="mt-1 text-xs text-ink-300">{event.message}</p>
                    {event.from_status ? (
                      <p className="mt-0.5 text-[10px] text-ink-500">
                        {event.from_status} → {event.to_status}
                      </p>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="py-4 text-center text-xs text-ink-500">No events recorded.</p>
            )}
          </Panel>
        </div>

        <div className="space-y-4">
          <Panel>
            <PanelHeader title="Linked records" icon={<WorkflowIcon className="h-4 w-4" />} />
            <dl className="space-y-2 text-xs">
              <div className="flex items-center justify-between">
                <dt className="text-ink-500">Primary asset</dt>
                <dd>
                  {data.primary_asset_id ? (
                    <Link href={`/infrastructure/${data.primary_asset_id}`} className="link">
                      {data.primary_asset_code ?? `#${data.primary_asset_id}`}
                    </Link>
                  ) : (
                    "—"
                  )}
                </dd>
              </div>
              <div className="flex items-center justify-between">
                <dt className="text-ink-500">Simulation</dt>
                <dd>
                  {data.simulation_run_id ? (
                    <Link href={`/simulations/${data.simulation_run_id}`} className="link inline-flex items-center gap-1">
                      <Cpu className="h-3 w-3" /> run #{data.simulation_run_id}
                    </Link>
                  ) : (
                    "not linked"
                  )}
                </dd>
              </div>
              <div className="flex items-center justify-between">
                <dt className="text-ink-500">Optimisation plan</dt>
                <dd>
                  {data.optimization_plan_id ? (
                    <Link href={`/optimization/plans/${data.optimization_plan_id}`} className="link">
                      plan #{data.optimization_plan_id}
                    </Link>
                  ) : (
                    "not linked"
                  )}
                </dd>
              </div>
              <div className="flex items-center justify-between">
                <dt className="text-ink-500">Workflow</dt>
                <dd>
                  {data.workflow_id ? (
                    <Link href={`/workflows/${data.workflow_id}`} className="link">
                      #{data.workflow_id}
                    </Link>
                  ) : (
                    "not started"
                  )}
                </dd>
              </div>
              <div className="flex items-center justify-between">
                <dt className="text-ink-500">Reported</dt>
                <dd className="text-ink-200">{formatDateTime(data.reported_at)}</dd>
              </div>
              {data.resolved_at ? (
                <div className="flex items-center justify-between">
                  <dt className="text-ink-500">Resolved</dt>
                  <dd className="text-mint">{formatDateTime(data.resolved_at)}</dd>
                </div>
              ) : null}
            </dl>
            {data.resolution_notes ? (
              <div className="mt-3 rounded-xl border border-mint/20 bg-mint/[0.05] p-3">
                <p className="text-[10px] uppercase tracking-wider text-mint">Resolution notes</p>
                <p className="mt-1 text-xs text-ink-200">{data.resolution_notes}</p>
              </div>
            ) : null}
          </Panel>

          {workflow.data ? (
            <Panel>
              <PanelHeader title="Recovery workflow" subtitle={workflow.data.title} icon={<WorkflowIcon className="h-4 w-4" />} />
              <div className="flex items-center justify-between">
                <StatusPill status={workflow.data.status} />
                <span className="text-[11px] text-ink-400">step: {titleCase(workflow.data.current_step)}</span>
              </div>
              <ol className="mt-3 space-y-1.5">
                {(workflow.data.steps ?? []).map((step) => (
                  <li key={step.key} className="flex items-center gap-2 text-[11px]">
                    <span
                      className={`h-2 w-2 rounded-full ${
                        step.status === "done"
                          ? "bg-mint"
                          : step.status === "failed"
                            ? "bg-coral"
                            : step.status === "current"
                              ? "bg-accent"
                              : "bg-white/15"
                      }`}
                    />
                    <span className={step.status === "pending" ? "text-ink-500" : "text-ink-200"}>{step.label}</span>
                  </li>
                ))}
              </ol>
              <Link href={`/workflows/${workflow.data.id}`} className="btn-secondary btn-sm mt-3 w-full">
                Open workflow console
              </Link>
            </Panel>
          ) : null}

          {data.affected_assets?.length ? (
            <Panel>
              <PanelHeader title="Affected assets" subtitle={`${data.affected_assets.length} impacted`} />
              <ul className="space-y-1.5">
                {data.affected_assets.map((row) => (
                  <li key={row.id} className="flex items-center justify-between text-[11px]">
                    <Link href={`/infrastructure/${row.asset_id}`} className="text-ink-300 hover:text-accent">
                      asset #{row.asset_id}
                    </Link>
                    <StatusPill status={row.impact_level} />
                  </li>
                ))}
              </ul>
            </Panel>
          ) : null}
        </div>
      </div>

      <Modal
        open={Boolean(transitioning)}
        onClose={() => setTransitioning(null)}
        title={`Move incident to ${titleCase(transitioning ?? "")}`}
        description="The backend re-validates this transition and records it in the event ledger and audit log."
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setTransitioning(null)} disabled={Boolean(busy)}>Cancel</Button>
            <Button
              variant={transitioning === "cancelled" ? "danger" : "primary"}
              loading={busy === transitioning}
              onClick={() => transitioning && doTransition(transitioning)}
            >
              Confirm transition
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <Field label="Note" htmlFor="transition-note" hint="Required context for the audit trail.">
            <Textarea
              id="transition-note"
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder="Verified with field crew at 14:20; feeder 3 isolation confirmed."
            />
          </Field>
          {transitioning === "resolved" ? (
            <Field label="Resolution notes" htmlFor="resolution-notes" hint="Stored on the incident record.">
              <Textarea
                id="resolution-notes"
                value={resolutionNotes}
                onChange={(event) => setResolutionNotes(event.target.value)}
                placeholder="All assets restored to operational; post-incident review scheduled."
              />
            </Field>
          ) : null}
          {transitioning === "resolved" ? (
            <Alert tone="info">
              Resolution is rejected by the API unless every linked repair task is verified. Unverified tasks:{" "}
              {data.open_task_count}.
            </Alert>
          ) : null}
          {error ? <Alert tone="danger">{error}</Alert> : null}
        </div>
      </Modal>
    </>
  );
}
