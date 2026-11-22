"use client";

/**
 * Screen 20 — My Assigned Tasks (field engineer workspace).
 *
 * The API hard-scopes this to the caller's own queue (GET /api/tasks/my-queue)
 * and refuses it to non-engineers, so the screen surfaces that error honestly
 * rather than faking an empty queue.
 */

import Link from "next/link";
import { useState } from "react";
import {
  AlertTriangle,
  CalendarClock,
  CheckCircle2,
  Clock,
  ClipboardList,
  MapPin,
  Play,
  RefreshCw,
  ShieldAlert,
} from "lucide-react";
import {
  Alert,
  Badge,
  Button,
  EmptyState,
  Field,
  Modal,
  PageHeader,
  Panel,
  PanelHeader,
  PriorityChip,
  Spinner,
  StatusPill,
  Tabs,
  Textarea,
} from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatDateTime, timeAgo, titleCase } from "@/lib/format";
import { useAsync } from "@/lib/hooks";
import type { RepairTask } from "@/lib/types";

interface QueueSummary {
  counts?: {
    pending_acceptance?: number;
    in_progress?: number;
    completed?: number;
    verified?: number;
  };
  total?: number;
  [key: string]: unknown;
}

interface QueueResponse {
  summary: QueueSummary;
  tasks: RepairTask[];
}

export default function MyTasksPage() {
  const { user, can, hasRole } = useAuth();
  const [refreshKey, setRefreshKey] = useState(0);
  const [tab, setTab] = useState<"active" | "history">("active");
  const [actionTask, setActionTask] = useState<{ task: RepairTask; action: string } | null>(null);
  const [note, setNote] = useState("");
  const [hours, setHours] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const queue = useAsync<QueueResponse>(() => api.get("/tasks/my-queue"), [refreshKey]);

  const active = (queue.data?.tasks ?? []).filter((task) =>
    ["assigned", "accepted", "in_progress", "completed"].includes(task.status),
  );
  const history = (queue.data?.tasks ?? []).filter((task) =>
    ["verified", "cancelled", "rejected"].includes(task.status),
  );

  async function transition() {
    if (!actionTask) return;
    setBusy(true);
    setError(null);
    try {
      await api.post(`/tasks/${actionTask.task.id}/transition`, {
        status: actionTask.action,
        note: note || `${titleCase(actionTask.action)} from field workspace.`,
        actual_hours: actionTask.action === "completed" && hours ? Number(hours) : undefined,
        rejection_reason: actionTask.action === "rejected" ? note || "Rejected by engineer" : undefined,
      });
      setNotice(`${actionTask.task.code} moved to ${actionTask.action.replace(/_/g, " ")}.`);
      setActionTask(null);
      setNote("");
      setHours("");
      setRefreshKey((k) => k + 1);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const summary = queue.data?.summary ?? {};
  const counts = summary.counts ?? {};
  const pendingAcceptance = counts.pending_acceptance ?? 0;
  const inProgress = counts.in_progress ?? 0;
  const awaitingVerification = counts.completed ?? 0;
  const verifiedCount = counts.verified ?? 0;
  const overdue = (queue.data?.tasks ?? []).filter(
    (task) => task.due_at && new Date(task.due_at).getTime() < Date.now() && task.status !== "verified",
  ).length;
  const allowedToSee = hasRole("field_engineer") || can("task:execute");

  if (!allowedToSee) {
    return (
      <>
        <PageHeader eyebrow="Field workspace" title="My assigned tasks" />
        <Alert tone="warning" title="This workspace is for field engineers">
          Your role does not hold the <code className="font-mono text-xs">task:execute</code> permission, so the
          server refuses to return a personal queue. Ask an administrator to assign you the Field Engineer role, or
          use the{" "}
          <Link href="/tasks" className="link">
            dispatch board
          </Link>{" "}
          instead.
        </Alert>
      </>
    );
  }

  return (
    <>
      <PageHeader
        eyebrow={`Field workspace · ${user?.full_name ?? ""}`}
        title="My assigned tasks"
        description="Accept dispatched work, record progress and close out with actual hours. Verification stays with the control room."
        actions={
          <>
            <Button variant="secondary" onClick={() => setRefreshKey((k) => k + 1)} loading={queue.loading}>
              <RefreshCw className="h-4 w-4" aria-hidden /> Refresh
            </Button>
            {overdue > 0 ? <Badge tone="danger">{overdue} overdue</Badge> : null}
          </>
        }
      />

      {error ? <Alert tone="danger" action={<Button variant="ghost" size="sm" onClick={() => setError(null)}>Dismiss</Button>}>{error}</Alert> : null}
      {notice ? <Alert tone="success" action={<Button variant="ghost" size="sm" onClick={() => setNotice(null)}>Dismiss</Button>}>{notice}</Alert> : null}
      {queue.error ? <Alert tone="danger" title="Queue unavailable">{queue.error}</Alert> : null}

      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {[
          { label: "Awaiting acceptance", value: pendingAcceptance, icon: ClipboardList, tone: "text-accent" },
          { label: "In progress", value: inProgress, icon: Clock, tone: "text-amber" },
          { label: "Awaiting verification", value: awaitingVerification, icon: CheckCircle2, tone: "text-mint" },
          { label: "Verified", value: verifiedCount, icon: ShieldAlert, tone: "text-ink-300" },
        ].map((tile) => (
          <div key={tile.label} className="glass p-4">
            <div className="flex items-center justify-between">
              <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-ink-500">{tile.label}</p>
              <tile.icon className={`h-4 w-4 ${tile.tone}`} />
            </div>
            <p className="mt-1 font-display text-2xl font-semibold text-white">{tile.value}</p>
          </div>
        ))}
      </div>

      <Tabs
        value={tab}
        onChange={setTab}
        label="My task views"
        tabs={[
          { id: "active", label: "Active", count: active.length },
          { id: "history", label: "Completed history", count: history.length },
        ]}
      />

      {queue.loading && !queue.data ? (
        <div className="grid place-items-center py-20"><Spinner label="Loading your queue…" /></div>
      ) : null}

      <div className="mt-4 space-y-3">
        {(tab === "active" ? active : history).length === 0 && !queue.loading ? (
          <EmptyState
            title={tab === "active" ? "No active assignments" : "No completed tasks yet"}
            description={
              tab === "active"
                ? "When an operations plan is approved, your dispatch appears here with the asset and required resources."
                : "Verified tasks you worked on will be listed here for your record."
            }
            icon={<ClipboardList className="h-5 w-5" />}
          />
        ) : null}

        {(tab === "active" ? active : history).map((task) => {
          const allowed = task.allowed_transitions ?? [];
          const overdue = task.due_at ? new Date(task.due_at).getTime() < Date.now() && task.status !== "completed" : false;
          return (
            <Panel key={task.id} className={overdue ? "border-coral/40" : undefined}>
              <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-[10px] text-ink-500">{task.code}</span>
                    <StatusPill status={task.status} />
                    <PriorityChip priority={task.priority} />
                    {overdue ? <Badge tone="danger">overdue</Badge> : null}
                  </div>
                  <Link href={`/tasks/${task.id}`} className="mt-1 block text-base font-medium text-white hover:text-accent">
                    {task.title}
                  </Link>
                  <p className="mt-0.5 line-clamp-2 text-xs text-ink-400">{task.description || "No work instructions recorded."}</p>
                  <div className="mt-2 flex flex-wrap items-center gap-3 text-[11px] text-ink-500">
                    <span className="inline-flex items-center gap-1">
                      <MapPin className="h-3 w-3" /> {task.asset_code ?? "asset"}
                    </span>
                    {task.due_at ? (
                      <span className={`inline-flex items-center gap-1 ${overdue ? "text-coral" : ""}`}>
                        <CalendarClock className="h-3 w-3" /> due {formatDateTime(task.due_at)}
                      </span>
                    ) : null}
                    <span>est. {task.estimated_hours}h</span>
                    {task.actual_hours ? <span>actual {task.actual_hours}h</span> : null}
                    <span>created {timeAgo(task.created_at)}</span>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {task.reservations
                      .filter((reservation) => reservation.status === "active")
                      .map((reservation) => (
                        <Badge key={reservation.id} tone="accent">
                          {reservation.quantity} units held
                        </Badge>
                      ))}
                  </div>
                </div>

                <div className="flex flex-wrap gap-2 lg:justify-end">
                  {allowed.length ? (
                    allowed.map((target) => (
                      <Button
                        key={target}
                        variant={target === "rejected" ? "secondary" : target === "completed" ? "primary" : "secondary"}
                        size="sm"
                        onClick={() => { setError(null); setNote(""); setActionTask({ task, action: target }); }}
                      >
                        {target === "accepted" ? <CheckCircle2 className="h-3.5 w-3.5" /> : target === "in_progress" ? <Play className="h-3.5 w-3.5" /> : null}
                        {target === "accepted" ? "Accept" : target === "in_progress" ? "Start" : target === "completed" ? "Complete" : titleCase(target)}
                      </Button>
                    ))
                  ) : (
                    <Link href={`/tasks/${task.id}`} className="btn-ghost btn-sm">Details</Link>
                  )}
                </div>
              </div>
            </Panel>
          );
        })}
      </div>

      {active.some((task) => task.status === "completed") ? (
        <Alert tone="info" title="Work awaiting control-room verification">
          Completed tasks are verified by an operator. They are not marked resolved until verification, which is what
          the incident resolution guard checks.
        </Alert>
      ) : null}

      {active.some((task) => task.status === "in_progress") ? (
        <div className="mt-3 flex items-start gap-2 rounded-xl border border-amber/25 bg-amber/[0.05] p-3 text-[11px] text-amber">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          You have work in progress. If you leave site before completion, set the task back to accepted with a note so
          dispatch can reassign it.
        </div>
      ) : null}

      <Modal
        open={Boolean(actionTask)}
        onClose={() => setActionTask(null)}
        title={`${titleCase(actionTask?.action ?? "")} — ${actionTask?.task.code ?? ""}`}
        description="This change is validated by the server and recorded against your account."
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setActionTask(null)} disabled={busy}>Cancel</Button>
            <Button
              variant={actionTask?.action === "rejected" ? "danger" : "primary"}
              onClick={transition}
              loading={busy}
            >
              Confirm
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <Field label="Note" htmlFor="field-note">
            <Textarea
              id="field-note"
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder={actionTask?.action === "rejected" ? "Reason you cannot take this task…" : "Site observations, parts used, blockers…"}
            />
          </Field>
          {actionTask?.action === "completed" ? (
            <Field label="Actual hours" htmlFor="field-hours" required hint="Required for MTTR reporting.">
              <input
                id="field-hours"
                type="number"
                min={0}
                step={0.1}
                value={hours}
                onChange={(event) => setHours(event.target.value)}
                className="input"
                placeholder={String(actionTask.task.estimated_hours)}
              />
            </Field>
          ) : null}
          {error ? <Alert tone="danger">{error}</Alert> : null}
        </div>
      </Modal>
    </>
  );
}
