"use client";

/**
 * Plan detail + approval. Approval is the transactional step that reserves
 * capacity and starts the recovery workflow, so the UI explains the consequence
 * before calling POST /api/optimization/plans/{id}/approve.
 */

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowUpRight,
  Ban,
  CheckCircle2,
  CircleSlash,
  Cpu,
  Gauge,
  ListChecks,
  Workflow,
} from "lucide-react";
import {
  Alert,
  Badge,
  Button,
  ConfirmDialog,
  DataTable,
  Field,
  Modal,
  Panel,
  PanelHeader,
  PageHeader,
  ProgressBar,
  Spinner,
  StatusPill,
  Textarea,
} from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { ExplainableRecoveryCard } from "@/components/ai/explainable-recovery-card";
import { useAuth } from "@/lib/auth";
import { formatDateTime, formatNumber, percent } from "@/lib/format";
import { useAsync } from "@/lib/hooks";
import type { OptimizationPlan } from "@/lib/types";

export default function PlanDetailPage() {
  const params = useParams<{ id: string }>();
  const id = Number(params.id);
  const router = useRouter();
  const { can } = useAuth();
  const [refreshKey, setRefreshKey] = useState(0);
  const [approveOpen, setApproveOpen] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [compensated, setCompensated] = useState<{
    workflowId: number;
    failureStep: string;
    message: string;
  } | null>(null);

  const plan = useAsync<OptimizationPlan>(() => api.get(`/optimization/plans/${id}`), [id, refreshKey]);

  async function approve() {
    setBusy(true);
    setError(null);
    try {
      const updated = await api.post<OptimizationPlan>(`/optimization/plans/${id}/approve`, {
        approve: true,
        note: note || "Approved from the plan console.",
      });
      setNotice(
        `Plan approved. ${updated.assignments.length} assignments reserved; repair tasks are being dispatched by the recovery workflow.`,
      );
      setApproveOpen(false);
      setNote("");
      setRefreshKey((k) => k + 1);
    } catch (err) {
      const detail = (err as { details?: { workflow_id?: number; failure_step?: string } }).details;
      if (detail?.workflow_id) {
        // Approval was persisted, but the reservation step failed and was
        // compensated. Say exactly that instead of reporting a blanket failure.
        setNotice(null);
        setCompensated({
          workflowId: detail.workflow_id,
          failureStep: detail.failure_step ?? "resources_reserved",
          message: errorMessage(err),
        });
        setApproveOpen(false);
        setNote("");
        setRefreshKey((k) => k + 1);
      } else {
        setError(errorMessage(err));
        setApproveOpen(false);
      }
    } finally {
      setBusy(false);
    }
  }

  async function reject() {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/optimization/plans/${id}/approve`, {
        approve: false,
        note: note || "Rejected by operator.",
      });
      setNotice("Plan rejected. No capacity was reserved.");
      setRejectOpen(false);
      setRefreshKey((k) => k + 1);
    } catch (err) {
      setError(errorMessage(err));
      setRejectOpen(false);
    } finally {
      setBusy(false);
    }
  }

  if (plan.loading && !plan.data) {
    return <div className="grid place-items-center py-24"><Spinner label="Loading plan…" /></div>;
  }

  if (!plan.data) {
    return (
      <Alert tone="danger" title="Plan not found">
        {plan.error ?? "This plan does not exist."}
        <div className="mt-3">
          <Link href="/optimization" className="btn-secondary btn-sm">Back to optimisation</Link>
        </div>
      </Alert>
    );
  }

  const data = plan.data;
  const infeasible = data.solution_status === "infeasible";
  const canApprove = can("optimization:approve") && data.status === "proposed" && !infeasible;
  const unserved = data.explanation?.unserved ?? [];

  return (
    <>
      <div className="mb-4">
        <Link href="/optimization" className="inline-flex items-center gap-1.5 text-xs text-ink-400 hover:text-white">
          <ArrowLeft className="h-3.5 w-3.5" /> Optimisation
        </Link>
      </div>

      <PageHeader
        eyebrow={`${data.code} · ${data.request?.title ?? "Recovery plan"}`}
        title={infeasible ? "Infeasible allocation" : `${data.covered_demand} of ${data.total_demand} demands covered`}
        description={
          infeasible
            ? "The solver proved no assignment satisfies the constraints. Nothing can be approved."
            : "All-or-nothing allocation with priority weighting. Approval reserves capacity transactionally and starts the field dispatch workflow."
        }
        actions={
          <>
            {data.status === "proposed" && can("optimization:approve") ? (
              <>
                <Button variant="secondary" onClick={() => { setNote(""); setRejectOpen(true); }}>
                  <CircleSlash className="h-4 w-4" aria-hidden /> Reject
                </Button>
                <Button onClick={() => { setNote(""); setApproveOpen(true); }} disabled={infeasible}>
                  <CheckCircle2 className="h-4 w-4" aria-hidden /> Approve plan
                </Button>
              </>
            ) : null}
            {data.workflow_id ? (
              <Link href={`/workflows/${data.workflow_id}`} className="btn-primary btn-sm">
                <Workflow className="h-3.5 w-3.5" /> Workflow
              </Link>
            ) : null}
          </>
        }
      >
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <StatusPill status={data.solution_status} />
          <StatusPill status={data.status} />
          <Badge>objective {formatNumber(data.objective_value)}</Badge>
          <Badge>{data.solver_wall_ms} ms solve</Badge>
          {data.approved_at ? <Badge tone="success">approved {formatDateTime(data.approved_at)}</Badge> : null}
        </div>
      </PageHeader>

      {error ? <Alert tone="danger" title="Action failed">{error}</Alert> : null}
      {notice ? <Alert tone="success" title="Done">{notice}</Alert> : null}

      <div className="mt-4">
        <ExplainableRecoveryCard planId={data.id} />
      </div>
      {compensated ? (
        <Alert
          tone="danger"
          title={`Approval recorded, but the ${compensated.failureStep.replace(/_/g, " ")} step failed`}
          action={
            <Link href={`/workflows/${compensated.workflowId}`} className="btn-secondary btn-sm">
              Inspect workflow <ArrowUpRight className="h-3 w-3" />
            </Link>
          }
        >
          <p>{compensated.message}</p>
          <p className="mt-1 text-xs text-ink-400">
            The plan stays approved, the failed step was rolled back with its savepoint, and compensation recorded what
            was released. Retry from the workflow console when the underlying cause is cleared.
          </p>
        </Alert>
      ) : null}

      {infeasible ? (
        <Alert tone="danger" title="Why this plan cannot be approved">
          {data.infeasibility_reason ??
            "The requested coverage floor cannot be met with the available resource pool."}
        </Alert>
      ) : null}

      <div className="grid gap-4 xl:grid-cols-[1fr_360px]">
        <div className="space-y-4">
          <Panel>
            <PanelHeader title="Coverage" subtitle={`${percent(data.coverage_percent, 1)} of requested demand`} icon={<Gauge className="h-4 w-4" />} />
            <ProgressBar
              value={data.coverage_percent}
              tone={infeasible ? "coral" : data.coverage_percent > 85 ? "mint" : "amber"}
              label="Demand coverage"
            />
            <div className="mt-3 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
              {[
                ["Demands", data.total_demand],
                ["Covered", data.covered_demand],
                ["Assignments", data.assignments.length],
                ["Unserved", unserved.length],
              ].map(([label, value]) => (
                <div key={String(label)} className="rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-2">
                  <p className="text-[10px] uppercase tracking-wider text-ink-500">{label}</p>
                  <p className="mt-0.5 font-display text-base font-semibold text-white">{value}</p>
                </div>
              ))}
            </div>
          </Panel>

          <Panel>
            <PanelHeader title="Assignments" subtitle="Resource → asset with rationale" icon={<ListChecks className="h-4 w-4" />} />
            <DataTable
              rows={data.assignments}
              getKey={(row) => row.id}
              empty={<p className="py-6 text-center text-xs text-ink-500">No assignments — the solver returned no allocation.</p>}
              columns={[
                {
                  key: "asset",
                  header: "Target asset",
                  render: (row) => (
                    <div>
                      <p className="text-xs font-medium text-white">{row.asset_code ?? row.asset_id} · {row.asset_name ?? ""}</p>
                      <p className="text-[10px] text-ink-500">{row.asset_category ?? ""}</p>
                    </div>
                  ),
                },
                {
                  key: "resource",
                  header: "Resource",
                  render: (row) => <span className="text-xs text-ink-200">{row.resource_code ?? row.resource_id}</span>,
                },
                {
                  key: "quantity",
                  header: "Quantity",
                  render: (row) => <span className="text-xs text-ink-300">{formatNumber(row.quantity)} kVA</span>,
                },
                {
                  key: "rationale",
                  header: "Rationale",
                  render: (row) => <span className="block max-w-sm text-[11px] text-ink-500">{row.rationale}</span>,
                },
                {
                  key: "task",
                  header: "Repair task",
                  render: (row) =>
                    row.repair_task_id ? (
                      <Link href={`/tasks/${row.repair_task_id}`} className="link text-[11px]">
                        #{row.repair_task_id}
                      </Link>
                    ) : (
                      <span className="text-[10px] text-ink-600">pending dispatch</span>
                    ),
                },
              ]}
            />
          </Panel>

          {unserved.length ? (
            <Panel>
              <PanelHeader title="Unserved demands" subtitle="Reported with reasons — not silently dropped" icon={<AlertTriangle className="h-4 w-4" />} />
              <ul className="space-y-2">
                {unserved.map((row) => (
                  <li key={row.asset_id} className="rounded-xl border border-coral/25 bg-coral/[0.06] px-3 py-2">
                    <div className="flex items-center justify-between">
                      <p className="text-xs font-medium text-white">
                        {row.asset_code} · {row.asset_name}
                      </p>
                      <Badge tone="danger">P{row.priority}</Badge>
                    </div>
                    <p className="mt-1 text-[11px] text-ink-400">{row.reason}</p>
                    <p className="mt-0.5 text-[10px] text-ink-500">Requirement: {formatNumber(row.need)} kVA</p>
                  </li>
                ))}
              </ul>
            </Panel>
          ) : null}

          <Panel>
            <PanelHeader title="Solver reasoning" subtitle="Step-by-step explanation from the engine" icon={<Cpu className="h-4 w-4" />} />
            <ol className="space-y-2">
              {(data.explanation?.steps ?? []).map((step, index) => (
                <li key={`${index}-${step.slice(0, 12)}`} className="flex gap-2 text-[11px] leading-relaxed text-ink-400">
                  <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full border border-white/10 text-[10px] text-ink-300">
                    {index + 1}
                  </span>
                  {step}
                </li>
              ))}
            </ol>
            {data.explanation?.relaxation ? (
              <Alert tone="warning" title="Relaxation applied">
                {data.explanation.relaxation}
              </Alert>
            ) : null}
          </Panel>
        </div>

        <div className="space-y-4">
          <Panel>
            <PanelHeader title="Resource usage" subtitle="Allocated vs. available" icon={<Gauge className="h-4 w-4" />} />
            {data.explanation?.resource_usage && Object.keys(data.explanation.resource_usage).length ? (
              <ul className="space-y-2.5">
                {Object.entries(data.explanation.resource_usage).map(([key, usage]) => (
                  <li key={key}>
                    <div className="mb-1 flex justify-between text-[11px]">
                      <span className="text-ink-300">{usage.code}</span>
                      <span className="text-ink-500">
                        {formatNumber(usage.allocated)}/{formatNumber(usage.available)}
                      </span>
                    </div>
                    <ProgressBar
                      value={usage.utilisation_percent}
                      tone={usage.utilisation_percent > 95 ? "coral" : usage.utilisation_percent > 70 ? "amber" : "mint"}
                      label={`${usage.code} utilisation`}
                    />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="py-4 text-center text-xs text-ink-500">No generator capacity allocated.</p>
            )}
          </Panel>

          <Panel>
            <PanelHeader title="Approval consequence" />
            <ul className="space-y-2 text-[11px] leading-relaxed text-ink-400">
              <li className="flex gap-2">
                <CheckCircle2 className="mt-0.5 h-3 w-3 shrink-0 text-mint" />
                Reserves each generator quantity inside one transaction.
              </li>
              <li className="flex gap-2">
                <CheckCircle2 className="mt-0.5 h-3 w-3 shrink-0 text-mint" />
                Creates repair tasks per served asset and assigns them to field engineers.
              </li>
              <li className="flex gap-2">
                <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0 text-amber" />
                If any reservation fails, the whole approval rolls back — no partial capacity is held.
              </li>
              <li className="flex gap-2">
                <Ban className="mt-0.5 h-3 w-3 shrink-0 text-coral" />
                Infeasible plans are refused with 409 by the API, regardless of the UI state.
              </li>
            </ul>
          </Panel>

          {data.request ? (
            <Panel>
              <PanelHeader title="Request" />
              <dl className="space-y-1.5 text-xs">
                <div className="flex justify-between">
                  <dt className="text-ink-500">Code</dt>
                  <dd className="font-mono text-[11px] text-ink-200">{data.request.code}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-ink-500">Objective</dt>
                  <dd className="text-ink-200">{data.request.objective.replace(/_/g, " ")}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-ink-500">Status</dt>
                  <dd><StatusPill status={data.request.status} /></dd>
                </div>
              </dl>
            </Panel>
          ) : null}
        </div>
      </div>

      <Modal
        open={approveOpen}
        onClose={() => setApproveOpen(false)}
        title="Approve recovery plan"
        description="Approval reserves capacity now. This is the point of no return for the reservation step."
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setApproveOpen(false)} disabled={busy}>Cancel</Button>
            <Button onClick={approve} loading={busy}>Approve & reserve</Button>
          </>
        }
      >
        <Field label="Approval note" htmlFor="approve-note" hint="Recorded in the audit log and workflow event ledger.">
          <Textarea
            id="approve-note"
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder="Approved: hospital and water pump first; commercial deferred."
          />
        </Field>
      </Modal>

      <ConfirmDialog
        open={rejectOpen}
        title="Reject this plan?"
        message="Rejecting stores the reason and reserves nothing. You can solve again with different constraints."
        confirmLabel="Reject plan"
        destructive
        loading={busy}
        onCancel={() => setRejectOpen(false)}
        onConfirm={reject}
      >
        <Field label="Reason" htmlFor="reject-note">
          <Textarea id="reject-note" value={note} onChange={(event) => setNote(event.target.value)} />
        </Field>
      </ConfirmDialog>
    </>
  );
}
