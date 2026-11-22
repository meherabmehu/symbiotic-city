"use client";

/**
 * Screen 17 — Notifications.
 *
 * Notifications are per-user rows written by the backend (incident transitions,
 * task assignment, workflow failures, resource releases). Reading one is a real
 * POST that flips is_read server-side.
 */

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  AlertTriangle,
  Bell,
  BellOff,
  CheckCheck,
  CheckCircle2,
  Filter,
  Info,
  RefreshCw,
} from "lucide-react";
import {
  Alert,
  Button,
  EmptyState,
  PageHeader,
  Panel,
  PanelHeader,
  Select,
  Spinner,
  Tabs,
  Toggle,
} from "@/components/ui";
import { api, errorMessage, qs } from "@/lib/api";
import { formatDateTime, timeAgo, titleCase } from "@/lib/format";
import { useAsync } from "@/lib/hooks";
import type { ListResponse, Notification } from "@/lib/types";

const CATEGORIES = ["incident", "task", "workflow", "resource", "simulation", "system"];

export default function NotificationsPage() {
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [category, setCategory] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const feed = useAsync<{ rows: Notification[]; unread: number }>(
    async (signal) => {
      const response: ListResponse<Notification> = await api.list(
        `/notifications${qs({ page_size: 60, unread_only: unreadOnly || undefined, category })}`,
        { signal },
      );
      return { rows: response.data, unread: response.unread_count ?? 0 };
    },
    [unreadOnly, category, refreshKey],
  );

  useEffect(() => {
    if (feed.error) setError(feed.error);
  }, [feed.error]);

  async function markRead(id: number) {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/notifications/${id}/read`);
      setRefreshKey((k) => k + 1);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function markAll() {
    setBusy(true);
    setError(null);
    try {
      const result = await api.post<{ updated: number }>("/notifications/read-all");
      setNotice(`${result.updated} notification(s) marked as read.`);
      setRefreshKey((k) => k + 1);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const rows = feed.data?.rows ?? [];

  return (
    <>
      <PageHeader
        eyebrow="Inbox"
        title="Notifications"
        description="Operational signals addressed to you: incident state changes, dispatch, workflow failures and compensation results. Read state is stored server-side."
        actions={
          <>
            <Button variant="secondary" onClick={() => setRefreshKey((k) => k + 1)} loading={feed.loading}>
              <RefreshCw className="h-4 w-4" aria-hidden /> Refresh
            </Button>
            <Button onClick={markAll} loading={busy} disabled={(feed.data?.unread ?? 0) === 0}>
              <CheckCheck className="h-4 w-4" aria-hidden /> Mark all read
            </Button>
          </>
        }
      />

      {error ? <Alert tone="danger" action={<Button variant="ghost" size="sm" onClick={() => setError(null)}>Dismiss</Button>}>{error}</Alert> : null}
      {notice ? <Alert tone="success" action={<Button variant="ghost" size="sm" onClick={() => setNotice(null)}>Dismiss</Button>}>{notice}</Alert> : null}

      <div className="grid gap-4 xl:grid-cols-[1fr_300px]">
        <Panel>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <Tabs
              value={unreadOnly ? "unread" : "all"}
              onChange={(value) => setUnreadOnly(value === "unread")}
              label="Notification filter"
              tabs={[
                { id: "all", label: "All" },
                { id: "unread", label: "Unread", count: feed.data?.unread },
              ]}
            />
            <div className="flex items-center gap-2">
              <Filter className="h-3.5 w-3.5 text-ink-500" />
              <Select value={category} onChange={(event) => setCategory(event.target.value)} aria-label="Filter by category" className="py-1.5 text-xs">
                <option value="">All categories</option>
                {CATEGORIES.map((value) => (
                  <option key={value} value={value}>{titleCase(value)}</option>
                ))}
              </Select>
            </div>
          </div>

          {feed.loading && !feed.data ? (
            <div className="grid place-items-center py-16"><Spinner label="Loading notifications…" /></div>
          ) : null}

          {rows.length === 0 && !feed.loading ? (
            <EmptyState
              title={unreadOnly ? "You are all caught up" : "No notifications yet"}
              description={
                unreadOnly
                  ? "Every notification in this category has been read."
                  : "Operational events addressed to you — assignments, incident changes, workflow outcomes — will appear here."
              }
              icon={<BellOff className="h-5 w-5" />}
            />
          ) : null}

          <ul className="space-y-2">
            {rows.map((note) => (
              <li
                key={note.id}
                className={`rounded-xl border px-3 py-3 transition ${
                  note.is_read ? "border-white/10 bg-white/[0.02]" : "border-accent/25 bg-accent/[0.04]"
                }`}
              >
                <div className="flex items-start gap-3">
                  <span
                    className={`mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg border ${
                      note.severity === "critical" || note.severity === "high"
                        ? "border-coral/30 bg-coral/10 text-coral"
                        : note.severity === "medium"
                          ? "border-amber/30 bg-amber/10 text-amber"
                          : "border-accent/30 bg-accent/10 text-accent"
                    }`}
                  >
                    {note.severity === "critical" || note.severity === "high" ? (
                      <AlertTriangle className="h-4 w-4" />
                    ) : note.severity === "medium" ? (
                      <Info className="h-4 w-4" />
                    ) : (
                      <CheckCircle2 className="h-4 w-4" />
                    )}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className={`text-sm ${note.is_read ? "text-ink-200" : "font-semibold text-white"}`}>{note.title}</p>
                      <span className="badge border border-white/10 bg-white/5 text-[9px] uppercase tracking-wider text-ink-400">
                        {note.category}
                      </span>
                      {!note.is_read ? <span className="h-1.5 w-1.5 rounded-full bg-accent" aria-label="unread" /> : null}
                    </div>
                    <p className="mt-1 text-xs leading-relaxed text-ink-400">{note.body}</p>
                    <div className="mt-2 flex flex-wrap items-center gap-3 text-[10px] text-ink-500">
                      <span>{formatDateTime(note.created_at)}</span>
                      <span>({timeAgo(note.created_at)})</span>
                      {note.link ? (
                        <Link href={note.link} className="link">
                          Open record
                        </Link>
                      ) : null}
                      {!note.is_read ? (
                        <button onClick={() => markRead(note.id)} disabled={busy} className="text-accent hover:underline disabled:opacity-50">
                          Mark as read
                        </button>
                      ) : null}
                    </div>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </Panel>

        <div className="space-y-4">
          <Panel>
            <PanelHeader title="Delivery" subtitle="How notifications are produced" icon={<Bell className="h-4 w-4" />} />
            <ul className="space-y-2 text-[11px] leading-relaxed text-ink-400">
              <li>Incident transitions notify the assigned operator and duty admins.</li>
              <li>Task assignment notifies the engineer; acceptance notifies the control room.</li>
              <li>Workflow failures include the compensation summary.</li>
              <li>Reservation releases notify the requesting operator.</li>
            </ul>
            <p className="mt-3 rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-2 text-[10px] text-ink-500">
              In-app only by design: no paid messaging provider is used, and no external LLM is required anywhere in
              the platform.
            </p>
          </Panel>

          <Panel>
            <PanelHeader title="Quiet hours" subtitle="Preferences live on your profile" />
            <Toggle
              checked={false}
              onChange={() => setNotice("Quiet hours are configured in Profile & settings.")}
              label="Suppress non-critical alerts"
              description="Critical incident and workflow alerts are never suppressed."
            />
          </Panel>
        </div>
      </div>
    </>
  );
}
