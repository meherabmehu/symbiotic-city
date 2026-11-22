"use client";

/**
 * Repair task console — used by dispatchers and by engineers for their own
 * tasks. Transition buttons come from the API's allowed_transitions, so the UI
 * can never offer an illegal move.
 */

import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  ClipboardList,
  History,
  MapPin,
  Package,
  Play,
  UserCheck,
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
  PriorityChip,
  Spinner,
  StatusPill,
  Textarea,
} from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatDateTime, formatNumber, titleCase } from "@/lib/format";
import { useAsync } from "@/lib/hooks";
import type { RepairTask } from "@/lib/types";

const TRANSITION_LABEL: Record<string, string> = {
  accepted: "Accept task",
  rejected: "Reject task",
  in_progress: "Start work",
  completed: "Mark complete",
  verified: "Verify completion",
  cancelled: "Cancel task",
  pending: "Return to queue",
  assigned: "Confirm assignment",
};

export default function TaskDetailPage() {
  const params = useParams<{ id: string }>();
  const id = Number(params.id);
  const { user, can } = useAuth();
  const [refreshKey, setRefreshKey] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [action, setAction] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [hours, setHours] = useState<string>("");

  const task = useAsync<RepairTask>(() => api.get(`/tasks/${id}`), [id, refreshKey]);

  async function transition() {
    if (!action) return;
    setBusy(action);
    setError(null);
    try {
      await api.post(`/tasks/${id}/transition`, {
        status: action,
        note: note || `${TRANSITION_LABEL[action] ?? action} from task console.`,
        actual_hours: action === "completed" && hours ? Number(hours) : undefined,
        rejection_reason: action === "rejected" ? note || "Rejected by engineer" : undefined,
      });
      setNotice(`Task moved to ${action.replace(/_/g, " ")}.`);
      setAction(null);
      setNote("");
      setHours("");
      setRefreshKey((k) => k + 1);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  const data = task.data;

  if (task.loading && !data) {
    return <div className="grid place-items-center py-24"><Spinner label="Loading task…" /></div>;
  }

  if (!data) {
    return (
      <Alert tone="danger" title="Task unavailable">
        {task.error ?? "This task does not exist or is not assigned to you."}
        <div className="mt-3 flex gap-2">
          <Link href="/tasks" className="btn-secondary btn-sm">Dispatch board</Link>
          <Link href="/my-tasks" className="btn-ghost btn-sm">My tasks</Link>
        </div>
      </Alert>
    );
  }

  const allowed = (data.allowed_transitions ?? []).filter((target) => {
    // engineers only see their own execution moves; verification belongs to operators
    if (target === "verified") return can("task:verify");
    return true;
  });
  const isMine = data.assignee_id === user?.id;

  return (
    <>
      <div className="mb-4">
        <Link
          href={isMine ? "/my-tasks" : "/tasks"}
          className="inline-flex items-center gap-1.5 text-xs text-ink-400 hover:text-white"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> {isMine ? "My tasks" : "Dispatch board"}
        </Link>
      </div>

      <PageHeader
        eyebrow={`${data.code} · ${titleCase(data.status)}`}
        title={data.title}
        description={data.description || "No additional instructions were recorded for this task."}
        actions={
          allowed.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {allowed.map((target) => (
                <Button
                  key={target}
                  variant={target === "cancelled" || target === "rejected" ? "secondary" : "primary"}
                  onClick={() => { setError(null); setNote(""); setAction(target); }}
                >
                  {target === "completed" ? <CheckCircle2 className="h-4 w-4" /> : target === "in_progress" ? <Play className="h-4 w-4" /> : <UserCheck className="h-4 w-4" />}
                  {TRANSITION_LABEL[target] ?? titleCase(target)}
                </Button>
              ))}
            </div>
          ) : (
            <Badge>No actions available</Badge>
          )
        }
      >
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <StatusPill status={data.status} />
          <PriorityChip priority={data.priority} />
          {data.asset_code ? (
            <Link href={`/infrastructure/${data.asset_id}`} className="badge border border-accent/30 bg-accent/10 text-accent">
              <MapPin className="h-3 w-3" /> {data.asset_code}
            </Link>
          ) : null}
          {data.incident_code ? <Badge tone="warning">incident {data.incident_code}</Badge> : null}
          {isMine ? <Badge tone="success">assigned to you</Badge> : null}
        </div>
      </PageHeader>

      {error ? <Alert tone="danger" title="Action failed">{error}</Alert> : null}
      {notice ? <Alert tone="success" action={<Button variant="ghost" size="sm" onClick={() => setNotice(null)}>Dismiss</Button>}>{notice}</Alert> : null}

      <div className="grid gap-4 xl:grid-cols-[1fr_340px]">
        <div className="space-y-4">
          <Panel>
            <PanelHeader title="Work order" subtitle="Schedule and effort" icon={<ClipboardList className="h-4 w-4" />} />
            <dl className="grid gap-2 text-xs sm:grid-cols-2">
              {[
                ["Assignee", data.assignee_name ?? "unassigned"],
                ["Estimated hours", `${data.estimated_hours}h`],
                ["Actual hours", data.actual_hours ? `${data.actual_hours}h` : "—"],
                ["Due", data.due_at ? formatDateTime(data.due_at) : "no deadline"],
                ["Assigned", data.assigned_at ? formatDateTime(data.assigned_at) : "—"],
                ["Started", data.started_at ? formatDateTime(data.started_at) : "—"],
                ["Completed", data.completed_at ? formatDateTime(data.completed_at) : "—"],
                ["Verified", data.verified_at ? formatDateTime(data.verified_at) : "—"],
              ].map(([label, value]) => (
                <div key={label} className="flex justify-between rounded-lg bg-white/[0.03] px-3 py-2">
                  <dt className="text-ink-500">{label}</dt>
                  <dd className="text-ink-200">{value}</dd>
                </div>
              ))}
            </dl>
            {data.completion_notes ? (
              <div className="mt-3 rounded-xl border border-mint/20 bg-mint/[0.05] p-3">
                <p className="text-[10px] uppercase tracking-wider text-mint">Completion notes</p>
                <p className="mt-1 text-xs text-ink-200">{data.completion_notes}</p>
              </div>
            ) : null}
            {data.rejection_reason ? (
              <div className="mt-3 rounded-xl border border-coral/20 bg-coral/[0.05] p-3">
                <p className="text-[10px] uppercase tracking-wider text-coral">Rejection reason</p>
                <p className="mt-1 text-xs text-ink-200">{data.rejection_reason}</p>
              </div>
            ) : null}
          </Panel>

          <Panel>
            <PanelHeader title="Reserved resources" subtitle="Capacity held for this task" icon={<Package className="h-4 w-4" />} />
            {data.reservations.length ? (
              <ul className="space-y-2">
                {data.reservations.map((reservation) => (
                  <li key={reservation.id} className="flex items-center justify-between rounded-lg bg-white/[0.02] px-3 py-2 text-xs">
                    <span className="text-ink-200">
                      resource #{reservation.resource_id} · {formatNumber(reservation.quantity)} units
                    </span>
                    <StatusPill status={reservation.status} />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="py-4 text-center text-xs text-ink-500">No capacity is held for this task.</p>
            )}
          </Panel>

          <Panel>
            <PanelHeader title="History" subtitle="Who changed what and when" icon={<History className="h-4 w-4" />} />
            {data.history?.length ? (
              <ol className="space-y-2">
                {data.history.map((row) => (
                  <li key={row.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-white/[0.02] px-3 py-2 text-[11px]">
                    <span className="text-ink-300">
                      {row.from_status ? `${titleCase(row.from_status)} → ` : ""}
                      <span className="text-white">{titleCase(row.to_status)}</span>
                    </span>
                    <span className="text-ink-500">{row.note ?? ""}</span>
                    <span className="text-[10px] text-ink-600">{formatDateTime(row.changed_at)}</span>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="py-4 text-center text-xs text-ink-500">No history yet.</p>
            )}
          </Panel>
        </div>

        <div className="space-y-4">
          <Panel>
            <PanelHeader title="Lifecycle" />
            <ol className="space-y-2">
              {["pending", "assigned", "accepted", "in_progress", "completed", "verified"].map((step, index) => {
                const order = ["pending", "assigned", "accepted", "in_progress", "completed", "verified"];
                const currentIndex = order.indexOf(data.status);
                const done = currentIndex >= index;
                return (
                  <li key={step} className="flex items-center gap-2 text-[11px]">
                    <span className={`h-2 w-2 rounded-full ${done ? "bg-mint" : "bg-white/15"}`} />
                    <span className={done ? "text-ink-200" : "text-ink-500"}>{titleCase(step)}</span>
                    {data.status === step ? <Badge tone="accent">current</Badge> : null}
                  </li>
                );
              })}
            </ol>
            {data.status === "rejected" || data.status === "cancelled" ? (
              <Alert tone="warning" title={`Task ${data.status}`}>
                This task is no longer on the execution path.
              </Alert>
            ) : null}
          </Panel>

          <Panel>
            <PanelHeader title="Safety notes" icon={<AlertTriangle className="h-4 w-4" />} />
            <ul className="space-y-2 text-[11px] leading-relaxed text-ink-400">
              <li>Isolate upstream feeds before energising a replacement source.</li>
              <li>Log actual hours on completion — MTTR reporting depends on it.</li>
              <li>Verification is a separate role; do not self-verify work.</li>
            </ul>
          </Panel>
        </div>
      </div>

      <Modal
        open={Boolean(action)}
        onClose={() => setAction(null)}
        title={TRANSITION_LABEL[action ?? ""] ?? titleCase(action ?? "")}
        description="The API validates that this transition is legal for the task's current state and for your role."
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setAction(null)} disabled={Boolean(busy)}>Cancel</Button>
            <Button
              variant={action === "rejected" || action === "cancelled" ? "danger" : "primary"}
              onClick={transition}
              loading={busy === action}
            >
              Confirm
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <Field label="Note" htmlFor="task-note" hint="Stored in task history and the audit log.">
            <Textarea
              id="task-note"
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder={action === "rejected" ? "Reason for rejecting the dispatch…" : "Progress or completion detail…"}
            />
          </Field>
          {action === "completed" ? (
            <Field label="Actual hours" htmlFor="actual-hours" hint="Used for MTTR and throughput reporting.">
              <input
                id="actual-hours"
                type="number"
                min={0}
                step={0.1}
                value={hours}
                onChange={(event) => setHours(event.target.value)}
                className="input"
                placeholder={String(data.estimated_hours)}
              />
            </Field>
          ) : null}
          {action === "verified" ? (
            <Alert tone="info">
              Verification assumes the asset is restored. Confirm the asset status separately if it is still degraded.
            </Alert>
          ) : null}
          {error ? <Alert tone="danger">{error}</Alert> : null}
        </div>
      </Modal>
    </>
  );
}
