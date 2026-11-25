"use client";

/**
 * Screen 19 — System Audit Logs.
 *
 * Append-only record of every privileged action, filterable by actor, action and
 * outcome. The API requires `audit:read`; a 403 is displayed as-is.
 */

import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  Filter,
  RefreshCw,
  ScrollText,
  ShieldCheck,
  XCircle,
} from "lucide-react";
import {
  Alert,
  Badge,
  Button,
  DataTable,
  EmptyState,
  Modal,
  PageHeader,
  Pagination,
  Panel,
  PanelHeader,
  SearchInput,
  Select,
  Spinner,
  Tabs,
} from "@/components/ui";
import { api, errorMessage, qs } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatDateTime } from "@/lib/format";
import { useAsync, useDebounced } from "@/lib/hooks";
import type { AuditEntry, ListResponse, Meta } from "@/lib/types";

const PAGE_SIZE = 25;

export default function AuditPage() {
  const { can } = useAuth();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [action, setAction] = useState("");
  const [outcome, setOutcome] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  const [selected, setSelected] = useState<AuditEntry | null>(null);
  const debounced = useDebounced(search);

  useEffect(() => setPage(1), [debounced, action, outcome]);

  const entries = useAsync<{ rows: AuditEntry[]; meta: Meta }>(
    async (signal) => {
      const response: ListResponse<AuditEntry> = await api.list(
        `/audit-logs${qs({ page, page_size: PAGE_SIZE, search: debounced, action, outcome })}`,
        { signal },
      );
      return { rows: response.data, meta: response.meta };
    },
    [page, debounced, action, outcome, refreshKey],
  );

  const actions = useAsync<{ action: string; count: number }[]>(() => api.get("/audit-logs/actions"), [refreshKey]);

  const stats = useMemo(() => {
    const rows = entries.data?.rows ?? [];
    return {
      success: rows.filter((row) => row.outcome === "success").length,
      failure: rows.filter((row) => row.outcome !== "success").length,
      actors: new Set(rows.map((row) => row.actor_email)).size,
    };
  }, [entries.data]);

  function exportCsv() {
    const rows = entries.data?.rows ?? [];
    const header = ["created_at", "actor_email", "actor_role", "action", "resource_type", "resource_id", "outcome", "message", "ip_address"];
    const lines = rows.map((row) =>
      [
        row.created_at,
        row.actor_email,
        row.actor_role,
        row.action,
        row.resource_type,
        row.resource_id ?? "",
        row.outcome,
        `"${row.message.replace(/"/g, '""')}"`,
        row.ip_address ?? "",
      ].join(","),
    );
    const blob = new Blob([[header.join(","), ...lines].join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `audit-log-page-${page}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  if (!can("audit:read")) {
    return (
      <>
        <PageHeader eyebrow="Governance" title="System audit logs" />
        <Alert tone="danger" title="Administrator access required">
          Audit review requires the <code className="font-mono text-xs">audit:read</code> permission, held by Super
          Admins. The API rejects the request regardless of the interface.
        </Alert>
      </>
    );
  }

  return (
    <>
      <PageHeader
        eyebrow="Governance"
        title="System audit logs"
        description="Append-only record of authentication, infrastructure, incident, workflow, optimisation and administrative actions — including failures, which are logged just as faithfully as successes."
        actions={
          <>
            <Button variant="secondary" onClick={() => setRefreshKey((k) => k + 1)} loading={entries.loading}>
              <RefreshCw className="h-4 w-4" aria-hidden /> Refresh
            </Button>
            <Button variant="secondary" onClick={exportCsv} disabled={!entries.data?.rows.length}>
              <Download className="h-4 w-4" aria-hidden /> Export page
            </Button>
          </>
        }
      >
        <div className="mt-4 flex flex-wrap gap-2">
          <Badge tone="accent">{entries.data?.meta.total ?? 0} entries</Badge>
          <Badge tone="success">{stats.success} success</Badge>
          <Badge tone="danger">{stats.failure} failure</Badge>
          <Badge>{stats.actors} actors on this page</Badge>
        </div>
      </PageHeader>

      {entries.error ? <Alert tone="danger" title="Could not load the audit log">{entries.error}</Alert> : null}

      {/* minmax(0,1fr), not 1fr: a `1fr` track is minmax(auto,1fr), so the
          table column refuses to go below the table's min-width and pushes the
          grid, and the page, wider than the viewport. The table then has
          nothing to scroll inside. */}
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_290px]">
        <Panel className="min-w-0">
          <div className="mb-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <div className="lg:col-span-2">
              <SearchInput value={search} onChange={setSearch} placeholder="Search actor, action or message…" label="Search audit log" />
            </div>
            <Select value={action} onChange={(event) => setAction(event.target.value)} aria-label="Filter by action">
              <option value="">All actions</option>
              {(actions.data ?? []).map((row) => (
                <option key={row.action} value={row.action}>
                  {row.action} ({row.count})
                </option>
              ))}
            </Select>
            <Select value={outcome} onChange={(event) => setOutcome(event.target.value)} aria-label="Filter by outcome">
              <option value="">Any outcome</option>
              <option value="success">Success</option>
              <option value="failure">Failure</option>
              <option value="denied">Denied</option>
            </Select>
          </div>

          <DataTable
            rows={entries.data?.rows ?? []}
            loading={entries.loading}
            getKey={(row) => row.id}
            empty={<EmptyState title="No audit entries match" description="Widen the filters or perform an auditable action." icon={<ScrollText className="h-5 w-5" />} />}
            columns={[
              {
                key: "when",
                header: "When",
                render: (row) => <span className="whitespace-nowrap text-[11px] text-ink-400">{formatDateTime(row.created_at)}</span>,
              },
              {
                key: "actor",
                header: "Actor",
                render: (row) => (
                  <div>
                    <p className="text-[11px] text-ink-200">{row.actor_email}</p>
                    <p className="text-[10px] text-ink-500">{row.actor_role}</p>
                  </div>
                ),
              },
              {
                key: "action",
                header: "Action",
                render: (row) => <code className="font-mono text-[10px] text-accent">{row.action}</code>,
              },
              {
                key: "message",
                header: "Detail",
                render: (row) => (
                  <button className="block max-w-sm truncate text-left text-[11px] text-ink-300 hover:text-white" onClick={() => setSelected(row)}>
                    {row.message}
                  </button>
                ),
              },
              {
                key: "outcome",
                header: "Outcome",
                render: (row) => (
                  <span
                    className={`badge ${
                      row.outcome === "success"
                        ? "border border-mint/30 bg-mint/10 text-mint"
                        : "border border-coral/30 bg-coral/10 text-coral"
                    }`}
                  >
                    {row.outcome === "success" ? <CheckCircle2 className="h-3 w-3" /> : <XCircle className="h-3 w-3" />}
                    {row.outcome}
                  </span>
                ),
              },
            ]}
          />
          {entries.data?.meta ? <Pagination meta={entries.data.meta} onPage={setPage} /> : null}
        </Panel>

        <div className="space-y-4">
          <Panel>
            <PanelHeader title="Coverage" subtitle="Who writes here" icon={<ShieldCheck className="h-4 w-4" />} />
            <ul className="space-y-2 text-[11px] leading-relaxed text-ink-400">
              <li>Authentication: sign-in, sign-out, failed attempts, password changes.</li>
              <li>Infrastructure: create, update, status change, archive, dependency edits.</li>
              <li>Incidents and tasks: every validated transition.</li>
              <li>Optimisation: solves, approvals, rejections.</li>
              <li>Workflows: starts, retries and injected faults.</li>
              <li>Administration: user creation, role changes, password resets, settings.</li>
              <li>Reporting: every CSV export.</li>
            </ul>
          </Panel>

          <Panel>
            <PanelHeader title="Top actions" subtitle="Lifetime counts" icon={<Filter className="h-4 w-4" />} />
            {(actions.data ?? []).slice(0, 8).map((row) => (
              <div key={row.action} className="flex items-center justify-between py-1 text-[11px]">
                <button onClick={() => setAction(row.action)} className="truncate text-left text-ink-300 hover:text-accent">
                  {row.action}
                </button>
                <span className="text-ink-500">{row.count}</span>
              </div>
            ))}
          </Panel>

          <Panel>
            <PanelHeader title="Immutability" icon={<AlertTriangle className="h-4 w-4" />} />
            <p className="text-[11px] leading-relaxed text-ink-400">
              Rows are insert-only. There is no API to edit or delete an audit entry, and the metadata snapshot stores
              the before/after payload for every mutation.
            </p>
          </Panel>
        </div>
      </div>

      <Modal
        open={Boolean(selected)}
        onClose={() => setSelected(null)}
        title={selected?.action ?? "Audit entry"}
        description={selected ? `${selected.actor_email} · ${formatDateTime(selected.created_at)}` : undefined}
        size="md"
      >
        {selected ? (
          <div className="space-y-3">
            <dl className="grid gap-2 text-[11px] sm:grid-cols-2">
              {[
                ["Outcome", selected.outcome],
                ["Role", selected.actor_role],
                ["Resource", `${selected.resource_type}${selected.resource_id ? ` #${selected.resource_id}` : ""}`],
                ["IP address", selected.ip_address ?? "—"],
              ].map(([label, value]) => (
                <div key={label} className="flex justify-between rounded-lg bg-white/[0.03] px-3 py-2">
                  <dt className="text-ink-500">{label}</dt>
                  <dd className="text-ink-200">{value}</dd>
                </div>
              ))}
            </dl>
            <div>
              <p className="text-[10px] uppercase tracking-wider text-ink-500">Message</p>
              <p className="mt-1 text-sm text-ink-200">{selected.message}</p>
            </div>
            <div>
              <p className="text-[10px] uppercase tracking-wider text-ink-500">Metadata</p>
              <pre className="mt-1 max-h-64 overflow-auto rounded-lg border border-white/10 bg-navy-950/70 p-3 text-[10px] text-ink-300 scrollbar-slim">
                {JSON.stringify(selected.metadata, null, 2)}
              </pre>
            </div>
          </div>
        ) : null}
      </Modal>
    </>
  );
}
