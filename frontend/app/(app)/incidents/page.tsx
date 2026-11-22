"use client";

/**
 * Screen 13 — Incident Management (list + reporting).
 *
 * Status changes go through POST /api/incidents/{id}/transition so the backend
 * can validate the state machine; the UI only ever offers the transitions the
 * API reports as allowed.
 */

import Link from "next/link";
import { useEffect, useState } from "react";
import { AlertTriangle, ArrowUpRight, Plus, RefreshCw, Siren } from "lucide-react";
import {
  Alert,
  Badge,
  Button,
  DataTable,
  Field,
  Input,
  Modal,
  PageHeader,
  Pagination,
  Panel,
  SearchInput,
  Select,
  SeverityBadge,
  StatusPill,
  Tabs,
  Textarea,
} from "@/components/ui";
import { api, errorMessage, qs } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatNumber, timeAgo, titleCase } from "@/lib/format";
import { useAsync, useDebounced } from "@/lib/hooks";
import type { Asset, Incident, ListResponse, Meta } from "@/lib/types";

const PAGE_SIZE = 8;

export default function IncidentsPage() {
  const { can } = useAuth();
  const [status, setStatus] = useState("");
  const [severity, setSeverity] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const debounced = useDebounced(search);
  const [refreshKey, setRefreshKey] = useState(0);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => setPage(1), [status, severity, debounced]);

  const query = useAsync<{ rows: Incident[]; meta: Meta }>(
    async (signal) => {
      const response: ListResponse<Incident> = await api.list(
        `/incidents${qs({ page, page_size: PAGE_SIZE, status, severity, search: debounced, sort: "reported_at", direction: "desc" })}`,
        { signal },
      );
      return { rows: response.data, meta: response.meta };
    },
    [page, status, severity, debounced, refreshKey],
  );

  const summary = useAsync<{ counts: Record<string, number>; active: number; total: number }>(
    () => api.get("/incidents/summary"),
    [refreshKey],
  );

  const assets = useAsync<Asset[]>(async () => (await api.list<Asset>("/infrastructure?page_size=100&sort=code")).data, []);

  async function createIncident(form: HTMLFormElement) {
    const data = new FormData(form);
    setBusy(true);
    setFormError(null);
    try {
      const payload = {
        title: String(data.get("title")),
        description: String(data.get("description") || ""),
        category: String(data.get("category")),
        severity: String(data.get("severity")),
        primary_asset_id: Number(data.get("primary_asset_id")),
        affected_asset_ids: Array.from(data.getAll("affected_asset_ids")).map(Number),
      };
      const incident = await api.post<Incident>("/incidents", payload);
      setCreating(false);
      setNotice(`${incident.code} reported.`);
      setRefreshKey((k) => k + 1);
    } catch (err) {
      setFormError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const counts = summary.data?.counts;

  return (
    <>
      <PageHeader
        eyebrow="Incident command"
        title="Incident management"
        description="Every disruption is tracked from report to verified resolution. Transitions are validated server-side: an incident cannot skip verification, and resolution requires every repair task to be verified."
        actions={
          <>
            <Button variant="secondary" onClick={() => setRefreshKey((k) => k + 1)} loading={query.loading}>
              <RefreshCw className="h-4 w-4" aria-hidden /> Refresh
            </Button>
            {can("incident:write") ? (
              <Button onClick={() => { setFormError(null); setCreating(true); }}>
                <Plus className="h-4 w-4" aria-hidden /> Report incident
              </Button>
            ) : null}
          </>
        }
      >
        <div className="mt-4 flex flex-wrap gap-2">
          <Badge tone="danger">{counts?.critical ? `${counts.critical} critical` : "0 critical"}</Badge>
          <Badge tone="warning">{summary.data?.active ?? 0} active</Badge>
          <Badge>{summary.data?.total ?? 0} total lifetime</Badge>
          <Badge tone="success">{counts?.resolved ?? 0} resolved</Badge>
        </div>
      </PageHeader>

      {notice ? <Alert tone="success" action={<Button variant="ghost" size="sm" onClick={() => setNotice(null)}>Dismiss</Button>}>{notice}</Alert> : null}
      {query.error ? <Alert tone="danger" title="Could not load incidents">{query.error}</Alert> : null}

      <Panel>
        <div className="mb-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <div className="lg:col-span-2">
            <SearchInput value={search} onChange={setSearch} placeholder="Search code, title or description…" label="Search incidents" />
          </div>
          <Select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Filter by status">
            <option value="">All statuses</option>
            {["reported", "verified", "planning", "approved", "in_progress", "resolved", "cancelled"].map((value) => (
              <option key={value} value={value}>{titleCase(value)}</option>
            ))}
          </Select>
          <Select value={severity} onChange={(e) => setSeverity(e.target.value)} aria-label="Filter by severity">
            <option value="">All severities</option>
            {["critical", "high", "medium", "low"].map((value) => (
              <option key={value} value={value}>{titleCase(value)}</option>
            ))}
          </Select>
        </div>

        <Tabs
          value={status}
          onChange={setStatus}
          label="Incident status filter"
          tabs={[
            { id: "", label: "All" },
            { id: "reported", label: "Reported", count: counts?.reported },
            { id: "verified", label: "Verified", count: counts?.verified },
            { id: "planning", label: "Planning", count: counts?.planning },
            { id: "approved", label: "Approved", count: counts?.approved },
            { id: "in_progress", label: "In progress", count: counts?.in_progress },
            { id: "resolved", label: "Resolved", count: counts?.resolved },
          ]}
        />

        <div className="mt-4">
          <DataTable
            rows={query.data?.rows ?? []}
            loading={query.loading}
            getKey={(row) => row.id}
            empty={
              <div className="rounded-xl border border-dashed border-white/10 px-4 py-12 text-center">
                <Siren className="mx-auto h-6 w-6 text-ink-500" />
                <p className="mt-2 text-sm font-medium text-white">No incidents match this view</p>
                <p className="mt-1 text-xs text-ink-400">Report a new incident or widen the filters.</p>
              </div>
            }
            columns={[
              {
                key: "incident",
                header: "Incident",
                render: (row) => (
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-[10px] text-ink-500">{row.code}</span>
                      <SeverityBadge severity={row.severity} />
                    </div>
                    <Link href={`/incidents/${row.id}`} className="text-sm font-medium text-white hover:text-accent">
                      {row.title}
                    </Link>
                    <p className="mt-0.5 text-[11px] text-ink-500">
                      {row.primary_asset_code ?? "—"} · {titleCase(row.category)}
                    </p>
                  </div>
                ),
              },
              { key: "status", header: "Status", render: (row) => <StatusPill status={row.status} /> },
              {
                key: "population",
                header: "Affected",
                render: (row) => (
                  <span className="text-xs text-ink-300">{formatNumber(row.affected_population)} residents</span>
                ),
              },
              {
                key: "tasks",
                header: "Tasks",
                render: (row) => (
                  <span className="text-xs text-ink-300">
                    {row.open_task_count}/{row.task_count} open
                  </span>
                ),
              },
              {
                key: "reported",
                header: "Reported",
                render: (row) => <span className="text-[11px] text-ink-400">{timeAgo(row.reported_at)}</span>,
              },
              {
                key: "actions",
                header: "",
                className: "text-right",
                render: (row) => (
                  <Link href={`/incidents/${row.id}`} className="btn-ghost btn-sm" aria-label={`Open ${row.code}`}>
                    <ArrowUpRight className="h-3.5 w-3.5" />
                  </Link>
                ),
              },
            ]}
          />
          {query.data?.meta ? <Pagination meta={query.data.meta} onPage={setPage} /> : null}
        </div>
      </Panel>

      <Modal
        open={creating}
        onClose={() => setCreating(false)}
        title="Report an incident"
        description="Reporting is step one of the recovery workflow. Verify the incident before planning."
        footer={
          <>
            <Button variant="ghost" onClick={() => setCreating(false)} disabled={busy}>Cancel</Button>
            <Button type="submit" form="create-incident" loading={busy}>Report incident</Button>
          </>
        }
      >
        {formError ? <Alert tone="danger">{formError}</Alert> : null}
        <form
          id="create-incident"
          className="mt-3 space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            void createIncident(event.currentTarget);
          }}
        >
          <Field label="Title" htmlFor="inc-title" required>
            <Input id="inc-title" name="title" required minLength={4} maxLength={180} placeholder="Substation 12 trip — Meridian East" />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Primary asset" htmlFor="inc-asset" required>
              <Select id="inc-asset" name="primary_asset_id" required>
                {(assets.data ?? []).map((asset) => (
                  <option key={asset.id} value={asset.id}>{asset.code} — {asset.name}</option>
                ))}
              </Select>
            </Field>
            <Field label="Category" htmlFor="inc-category" required>
              <Select id="inc-category" name="category" defaultValue="power_outage">
                {["power_outage", "water_contamination", "flooding", "telecom_outage", "structural", "fire"].map((value) => (
                  <option key={value} value={value}>{titleCase(value)}</option>
                ))}
              </Select>
            </Field>
            <Field label="Severity" htmlFor="inc-severity" required>
              <Select id="inc-severity" name="severity" defaultValue="high">
                {["critical", "high", "medium", "low"].map((value) => (
                  <option key={value} value={value}>{titleCase(value)}</option>
                ))}
              </Select>
            </Field>
            <Field label="Also affected assets" htmlFor="inc-affected" hint="Multi-select with Ctrl / Cmd">
              <select
                id="inc-affected"
                name="affected_asset_ids"
                multiple
                className="input h-24 py-2 text-xs"
                aria-label="Additional affected assets"
              >
                {(assets.data ?? []).map((asset) => (
                  <option key={asset.id} value={asset.id}>{asset.code} — {asset.name}</option>
                ))}
              </select>
            </Field>
          </div>
          <Field label="Description" htmlFor="inc-description">
            <Textarea id="inc-description" name="description" maxLength={4000} placeholder="Observed symptoms, telemetry, operator notes…" />
          </Field>
          <Alert tone="info">
            The report creates an incident in <strong>reported</strong> state and notifies duty operators.
          </Alert>
        </form>
      </Modal>
    </>
  );
}
