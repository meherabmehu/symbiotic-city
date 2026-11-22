"use client";

/**
 * Screen 14 — Repair Dispatch (task board).
 *
 * Kanban-style columns by status with assignment controls. Assignment and
 * transitions call the API, which enforces role rules and object-level access.
 */

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  ArrowUpRight,
  CalendarClock,
  ClipboardList,
  RefreshCw,
  UserCheck,
  UserPlus,
  Users,
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
  SearchInput,
  Select,
  Spinner,
  StatusPill,
  Tabs,
} from "@/components/ui";
import { api, errorMessage, qs } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatDateTime, timeAgo } from "@/lib/format";
import { useAsync, useDebounced } from "@/lib/hooks";
import type { ListResponse, RepairTask } from "@/lib/types";

interface Engineer {
  id: number;
  full_name: string;
  email: string;
  job_title: string | null;
  is_active: boolean;
}

const COLUMNS: { status: string; label: string; tone: string }[] = [
  { status: "pending", label: "Unassigned", tone: "border-white/10" },
  { status: "assigned", label: "Awaiting acceptance", tone: "border-amber/30" },
  { status: "accepted", label: "Accepted", tone: "border-accent/30" },
  { status: "in_progress", label: "In progress", tone: "border-sky-400/30" },
  { status: "completed", label: "Awaiting verification", tone: "border-mint/30" },
  { status: "verified", label: "Verified", tone: "border-mint/50" },
];

export default function DispatchPage() {
  const { can } = useAuth();
  const [view, setView] = useState<"board" | "list">("board");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  const [assigning, setAssigning] = useState<RepairTask | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const debounced = useDebounced(search);

  const tasks = useAsync<{ rows: RepairTask[]; total: number }>(
    async (signal) => {
      const response: ListResponse<RepairTask> = await api.list(
        `/tasks${qs({ page_size: 100, search: debounced, status, sort: "created_at", direction: "desc" })}`,
        { signal },
      );
      return { rows: response.data, total: response.meta.total };
    },
    [debounced, status, refreshKey],
  );

  const engineers = useAsync<Engineer[]>(() => api.get("/tasks/engineers"), [refreshKey]);
  const unassigned = useAsync<RepairTask[]>(
    async () => (await api.list<RepairTask>("/tasks?unassigned=true&only_open=true&page_size=50")).data,
    [refreshKey],
  );

  useEffect(() => {
    if (tasks.error) setError(tasks.error);
  }, [tasks.error]);

  const grouped = useMemo(() => {
    const map = new Map<string, RepairTask[]>();
    for (const task of tasks.data?.rows ?? []) {
      const list = map.get(task.status) ?? [];
      list.push(task);
      map.set(task.status, list);
    }
    return map;
  }, [tasks.data]);

  const counts = useMemo(() => {
    const map: Record<string, number> = {};
    for (const task of tasks.data?.rows ?? []) map[task.status] = (map[task.status] ?? 0) + 1;
    return map;
  }, [tasks.data]);

  async function assign(form: HTMLFormElement) {
    if (!assigning) return;
    const data = new FormData(form);
    setBusy(true);
    setError(null);
    try {
      await api.post(`/tasks/${assigning.id}/assign`, {
        assignee_id: Number(data.get("assignee_id")),
        note: String(data.get("note") || "") || null,
      });
      setNotice(`${assigning.code} assigned.`);
      setAssigning(null);
      setRefreshKey((k) => k + 1);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader
        eyebrow="Field dispatch"
        title="Repair tasks"
        description="Every recovery plan becomes a set of dispatchable tasks. Engineers accept, work and complete; operators verify. Object-level checks stop one engineer acting on another's task."
        actions={
          <>
            <Button variant="secondary" onClick={() => setRefreshKey((k) => k + 1)} loading={tasks.loading}>
              <RefreshCw className="h-4 w-4" aria-hidden /> Refresh
            </Button>
            <Badge tone="warning">{unassigned.data?.length ?? 0} unassigned</Badge>
          </>
        }
      />

      {error ? <Alert tone="danger" action={<Button variant="ghost" size="sm" onClick={() => setError(null)}>Dismiss</Button>}>{error}</Alert> : null}
      {notice ? <Alert tone="success" action={<Button variant="ghost" size="sm" onClick={() => setNotice(null)}>Dismiss</Button>}>{notice}</Alert> : null}

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Tabs
          value={view}
          onChange={setView}
          label="Dispatch view"
          tabs={[
            { id: "board", label: "Board" },
            { id: "list", label: "List", count: tasks.data?.total },
          ]}
        />
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <div className="w-56">
            <SearchInput value={search} onChange={setSearch} placeholder="Search tasks…" label="Search tasks" />
          </div>
          <Select value={status} onChange={(event) => setStatus(event.target.value)} aria-label="Filter status" className="max-w-[190px]">
            <option value="">All statuses</option>
            {["pending", "assigned", "accepted", "in_progress", "completed", "verified", "rejected", "cancelled"].map((value) => (
              <option key={value} value={value}>{value.replace(/_/g, " ")}</option>
            ))}
          </Select>
        </div>
      </div>

      {tasks.loading && !tasks.data ? (
        <div className="grid place-items-center py-20"><Spinner label="Loading dispatch board…" /></div>
      ) : null}

      {view === "board" && tasks.data ? (
        <div className="grid gap-3 lg:grid-cols-3 2xl:grid-cols-6">
          {COLUMNS.map((column) => {
            const items = grouped.get(column.status) ?? [];
            return (
              <section key={column.status} className={`glass-tight flex min-h-[280px] flex-col border ${column.tone} p-3`}>
                <div className="mb-2 flex items-center justify-between">
                  <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-300">{column.label}</h2>
                  <span className="rounded-full bg-white/10 px-1.5 py-0.5 text-[10px] text-ink-200">{items.length}</span>
                </div>
                <ul className="flex-1 space-y-2">
                  {items.length === 0 ? (
                    <li className="rounded-lg border border-dashed border-white/10 px-2 py-6 text-center text-[10px] text-ink-600">
                      empty
                    </li>
                  ) : (
                    items.map((task) => (
                      <li key={task.id} className="rounded-xl border border-white/10 bg-navy-950/70 p-2.5">
                        <div className="flex items-start justify-between gap-1">
                          <Link href={`/tasks/${task.id}`} className="text-[11px] font-medium leading-snug text-white hover:text-accent">
                            {task.title}
                          </Link>
                          <PriorityChip priority={task.priority} />
                        </div>
                        <p className="mt-1 font-mono text-[9px] text-ink-500">{task.code}</p>
                        <p className="mt-1 text-[10px] text-ink-400">
                          {task.asset_code ?? "asset"} · {task.assignee_name ?? "unassigned"}
                        </p>
                        {task.due_at ? (
                          <p className="mt-1 flex items-center gap-1 text-[9px] text-ink-500">
                            <CalendarClock className="h-2.5 w-2.5" /> due {formatDateTime(task.due_at)}
                          </p>
                        ) : null}
                        <div className="mt-2 flex items-center justify-between">
                          <Link href={`/tasks/${task.id}`} className="text-[10px] text-accent hover:underline">
                            open <ArrowUpRight className="inline h-2.5 w-2.5" />
                          </Link>
                          {task.status === "pending" && can("task:write") ? (
                            <button
                              className="text-[10px] text-ink-300 hover:text-white"
                              onClick={() => { setError(null); setAssigning(task); }}
                            >
                              assign
                            </button>
                          ) : null}
                        </div>
                      </li>
                    ))
                  )}
                </ul>
              </section>
            );
          })}
        </div>
      ) : null}

      {view === "list" && tasks.data ? (
        <Panel>
          <PanelHeader
            title="All tasks"
            subtitle={`${tasks.data.total} tasks matching the filters`}
            icon={<ClipboardList className="h-4 w-4" />}
          />
          {tasks.data.rows.length ? (
            <div className="table-shell">
              <table className="data-table">
                <thead>
                  <tr>
                    <th scope="col">Task</th>
                    <th scope="col">Asset</th>
                    <th scope="col">Assignee</th>
                    <th scope="col">Priority</th>
                    <th scope="col">Status</th>
                    <th scope="col">Created</th>
                    <th scope="col" />
                  </tr>
                </thead>
                <tbody>
                  {tasks.data.rows.map((task) => (
                    <tr key={task.id}>
                      <td>
                        <Link href={`/tasks/${task.id}`} className="text-xs font-medium text-white hover:text-accent">
                          {task.title}
                        </Link>
                        <p className="font-mono text-[10px] text-ink-500">{task.code}</p>
                      </td>
                      <td className="text-xs text-ink-300">{task.asset_code ?? "—"}</td>
                      <td className="text-xs text-ink-300">{task.assignee_name ?? "unassigned"}</td>
                      <td><PriorityChip priority={task.priority} /></td>
                      <td><StatusPill status={task.status} /></td>
                      <td className="text-[11px] text-ink-500">{timeAgo(task.created_at)}</td>
                      <td className="text-right">
                        {task.status === "pending" && can("task:write") ? (
                          <Button variant="ghost" size="sm" onClick={() => setAssigning(task)}>
                            <UserPlus className="h-3.5 w-3.5" /> Assign
                          </Button>
                        ) : (
                          <Link href={`/tasks/${task.id}`} className="btn-ghost btn-sm">Open</Link>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState title="No tasks match" description="Tasks appear once a recovery plan is approved." icon={<ClipboardList className="h-5 w-5" />} />
          )}
        </Panel>
      ) : null}

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Panel>
          <PanelHeader title="Engineer roster" subtitle="Available field engineers" icon={<Users className="h-4 w-4" />} />
          {engineers.data?.length ? (
            <ul className="space-y-2">
              {engineers.data.map((engineer) => {
                const load = (tasks.data?.rows ?? []).filter(
                  (task) => task.assignee_id === engineer.id && !["verified", "cancelled"].includes(task.status),
                ).length;
                return (
                  <li key={engineer.id} className="flex items-center justify-between rounded-lg bg-white/[0.02] px-3 py-2">
                    <div>
                      <p className="text-xs font-medium text-white">{engineer.full_name}</p>
                      <p className="text-[10px] text-ink-500">{engineer.job_title ?? "Field engineer"} · {engineer.email}</p>
                    </div>
                    <Badge tone={load > 3 ? "warning" : "success"}>{load} open</Badge>
                  </li>
                );
              })}
            </ul>
          ) : (
            <EmptyState title="No engineers registered" />
          )}
        </Panel>

        <Panel>
          <PanelHeader title="Unassigned queue" subtitle="Awaiting dispatch" icon={<UserCheck className="h-4 w-4" />} />
          {unassigned.data?.length ? (
            <ul className="space-y-2">
              {unassigned.data.slice(0, 6).map((task) => (
                <li key={task.id} className="flex items-center justify-between rounded-lg bg-white/[0.02] px-3 py-2">
                  <div className="min-w-0">
                    <p className="truncate text-xs text-white">{task.title}</p>
                    <p className="text-[10px] text-ink-500">{task.code} · {task.asset_code ?? "asset"}</p>
                  </div>
                  {can("task:write") ? (
                    <Button variant="secondary" size="sm" onClick={() => setAssigning(task)}>Assign</Button>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState title="Queue clear" description="Every open task has an owner." />
          )}
        </Panel>
      </div>

      <Modal
        open={Boolean(assigning)}
        onClose={() => setAssigning(null)}
        title={`Assign ${assigning?.code ?? ""}`}
        description="The engineer is notified immediately and must accept before starting work."
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setAssigning(null)} disabled={busy}>Cancel</Button>
            <Button type="submit" form="assign-form" loading={busy}>Assign task</Button>
          </>
        }
      >
        {error ? <Alert tone="danger">{error}</Alert> : null}
        <form
          id="assign-form"
          className="mt-3 space-y-3"
          onSubmit={(event) => { event.preventDefault(); void assign(event.currentTarget); }}
        >
          <Field label="Engineer" htmlFor="assignee" required>
            <Select id="assignee" name="assignee_id" required defaultValue={assigning?.assignee_id ?? ""}>
              <option value="">Choose an engineer…</option>
              {(engineers.data ?? []).map((engineer) => (
                <option key={engineer.id} value={engineer.id}>{engineer.full_name}</option>
              ))}
            </Select>
          </Field>
          <Field label="Dispatch note" htmlFor="assign-note">
            <textarea id="assign-note" name="note" className="input min-h-[70px]" maxLength={400} placeholder="Take the 500 kVA unit; site access via north gate." />
          </Field>
        </form>
      </Modal>
    </>
  );
}
