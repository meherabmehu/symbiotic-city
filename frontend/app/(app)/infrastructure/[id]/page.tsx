"use client";

/**
 * Screen 08 — Infrastructure Details.
 *
 * Shows the asset's operational record, dependency topology (inbound and
 * outbound), status history, open incidents and quick actions.
 */

import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Cpu,
  Gauge,
  History,
  Network,
  Thermometer,
  Wrench,
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
  ProgressBar,
  Select,
  Spinner,
  StatusPill,
  Textarea,
} from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatDateTime, formatNumber, percent, titleCase } from "@/lib/format";
import { useAsync } from "@/lib/hooks";
import type { AssetDetail } from "@/lib/types";

export default function AssetDetailPage() {
  const params = useParams<{ id: string }>();
  const id = Number(params.id);
  const { can } = useAuth();
  const [refreshKey, setRefreshKey] = useState(0);
  const [statusOpen, setStatusOpen] = useState(false);
  const [nextStatus, setNextStatus] = useState("operational");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const asset = useAsync<AssetDetail>(() => api.get(`/infrastructure/${id}`), [id, refreshKey]);

  async function changeStatus() {
    if (reason.trim().length < 3) {
      setError("A reason of at least 3 characters is required.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.post(`/infrastructure/${id}/status`, { status: nextStatus, reason });
      setNotice(`Status changed to ${nextStatus}.`);
      setStatusOpen(false);
      setReason("");
      setRefreshKey((k) => k + 1);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const data = asset.data;

  if (asset.loading && !data) {
    return (
      <div className="grid place-items-center py-24">
        <Spinner label="Loading asset…" />
      </div>
    );
  }

  if (!data) {
    return (
      <Alert tone="danger" title="Asset unavailable">
        {asset.error ?? "This asset does not exist or has been removed."}
        <div className="mt-3">
          <Link href="/infrastructure" className="btn-secondary btn-sm">Back to registry</Link>
        </div>
      </Alert>
    );
  }

  return (
    <>
      <div className="mb-4">
        <Link href="/infrastructure" className="inline-flex items-center gap-1.5 text-xs text-ink-400 hover:text-white">
          <ArrowLeft className="h-3.5 w-3.5" /> Infrastructure registry
        </Link>
      </div>

      <PageHeader
        eyebrow={`${data.code} · ${data.category_label}`}
        title={data.name}
        description={data.notes ?? "No operational notes recorded for this asset."}
        actions={
          <>
            <Link href={`/twin`} className="btn-secondary btn-sm">
              <Network className="h-3.5 w-3.5" /> View in twin
            </Link>
            {can("infrastructure:write") ? (
              <Button
                onClick={() => {
                  setNextStatus(data.status === "offline" ? "operational" : "offline");
                  setError(null);
                  setStatusOpen(true);
                }}
              >
                <Wrench className="h-4 w-4" aria-hidden /> Change status
              </Button>
            ) : null}
            {can("simulation:run") ? (
              <Link href={`/simulation?asset=${data.id}`} className="btn-primary btn-sm">
                <Cpu className="h-3.5 w-3.5" /> Simulate failure
              </Link>
            ) : null}
          </>
        }
      >
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <StatusPill status={data.status} />
          <Badge tone="accent">Priority {data.criticality}</Badge>
          <Badge>{data.zone?.name ?? "Unzoned"}</Badge>
          {data.is_archived ? <Badge tone="warning">Archived</Badge> : null}
          {data.active_incidents?.length ? (
            <Badge tone="danger">{data.active_incidents.length} open incident(s)</Badge>
          ) : (
            <Badge tone="success">No open incidents</Badge>
          )}
        </div>
      </PageHeader>

      {notice ? <Alert tone="success" action={<Button variant="ghost" size="sm" onClick={() => setNotice(null)}>Dismiss</Button>}>{notice}</Alert> : null}
      {asset.error ? <Alert tone="danger">{asset.error}</Alert> : null}

      <div className="grid gap-4 xl:grid-cols-[1fr_360px]">
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {[
              { label: "Capacity", value: `${formatNumber(data.capacity)} ${data.capacity_unit}`, icon: Gauge },
              { label: "Load", value: percent(data.load_percent, 0), icon: Thermometer },
              { label: "Built", value: data.built_year ?? "—", icon: History },
              { label: "Last inspection", value: data.last_inspection_at ? formatDateTime(data.last_inspection_at) : "—", icon: Activity },
            ].map((tile) => (
              <div key={tile.label} className="glass p-4">
                <div className="flex items-center justify-between text-ink-400">
                  <p className="text-[10px] font-semibold uppercase tracking-[0.16em]">{tile.label}</p>
                  <tile.icon className="h-3.5 w-3.5" />
                </div>
                <p className="mt-2 font-display text-lg font-semibold text-white">{tile.value}</p>
              </div>
            ))}
          </div>

          <Panel>
            <PanelHeader title="Load envelope" subtitle="Design capacity vs. current draw" icon={<Gauge className="h-4 w-4" />} />
            <ProgressBar
              value={data.load_percent}
              tone={data.load_percent > 85 ? "coral" : data.load_percent > 65 ? "amber" : "mint"}
              label="Current load"
            />
            <div className="mt-2 flex justify-between text-xs text-ink-400">
              <span>0%</span>
              <span className={data.load_percent > 85 ? "text-coral" : "text-ink-200"}>{percent(data.load_percent, 1)} of design</span>
              <span>100%</span>
            </div>
            <dl className="mt-4 grid gap-2 text-xs sm:grid-cols-2">
              <div className="flex justify-between rounded-lg bg-white/[0.03] px-3 py-2">
                <dt className="text-ink-500">Coordinates</dt>
                <dd className="text-ink-200">
                  {data.latitude.toFixed(4)}, {data.longitude.toFixed(4)}
                </dd>
              </div>
              <div className="flex justify-between rounded-lg bg-white/[0.03] px-3 py-2">
                <dt className="text-ink-500">Map position</dt>
                <dd className="text-ink-200">
                  ({data.map_x.toFixed(1)}, {data.map_y.toFixed(1)})
                </dd>
              </div>
              <div className="flex justify-between rounded-lg bg-white/[0.03] px-3 py-2">
                <dt className="text-ink-500">Registered</dt>
                <dd className="text-ink-200">{formatDateTime(data.created_at)}</dd>
              </div>
              <div className="flex justify-between rounded-lg bg-white/[0.03] px-3 py-2">
                <dt className="text-ink-500">Updated</dt>
                <dd className="text-ink-200">{formatDateTime(data.updated_at)}</dd>
              </div>
            </dl>
          </Panel>

          <div className="grid gap-4 lg:grid-cols-2">
            <Panel>
              <PanelHeader
                title="Depends on"
                subtitle={`${data.inbound.length} upstream suppliers`}
                icon={<ArrowRight className="h-4 w-4" />}
              />
              {data.inbound.length ? (
                <ul className="space-y-2">
                  {data.inbound.map((row) => (
                    <li key={row.id} className="rounded-xl border border-white/10 bg-white/[0.02] px-3 py-2">
                      <div className="flex items-center justify-between">
                        <Link href={`/infrastructure/${row.source_asset_id}`} className="text-xs font-medium text-white hover:text-accent">
                          {row.source_code} · {row.source_name}
                        </Link>
                        <Badge>{row.dependency_type}</Badge>
                      </div>
                      <p className="mt-1 text-[11px] text-ink-500">
                        impact {row.impact_weight.toFixed(2)} · redundancy {row.redundancy.toFixed(2)}
                        {row.description ? ` · ${row.description}` : ""}
                      </p>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="py-4 text-center text-xs text-ink-500">No upstream dependencies — this is a root supply node.</p>
              )}
            </Panel>

            <Panel>
              <PanelHeader
                title="Supports"
                subtitle={`${data.outbound.length} dependent assets`}
                icon={<ArrowLeft className="h-4 w-4" />}
              />
              {data.outbound.length ? (
                <ul className="space-y-2">
                  {data.outbound.map((row) => (
                    <li key={row.id} className="rounded-xl border border-white/10 bg-white/[0.02] px-3 py-2">
                      <div className="flex items-center justify-between">
                        <Link href={`/infrastructure/${row.target_asset_id}`} className="text-xs font-medium text-white hover:text-accent">
                          {row.target_code} · {row.target_name}
                        </Link>
                        <Badge>{row.dependency_type}</Badge>
                      </div>
                      <p className="mt-1 text-[11px] text-ink-500">
                        impact {row.impact_weight.toFixed(2)} · redundancy {row.redundancy.toFixed(2)}
                      </p>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="py-4 text-center text-xs text-ink-500">No dependent assets recorded.</p>
              )}
            </Panel>
          </div>

          <Panel>
            <PanelHeader title="Status history" subtitle="Every change with reason and timestamp" icon={<History className="h-4 w-4" />} />
            {data.history.length ? (
              <ol className="space-y-2">
                {data.history.map((row) => (
                  <li key={row.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-white/[0.02] px-3 py-2 text-xs">
                    <div className="flex items-center gap-2">
                      <span className="text-ink-400">{row.previous_status ? titleCase(row.previous_status) : "—"}</span>
                      <ArrowRight className="h-3 w-3 text-accent" />
                      <span className="font-medium text-white">{titleCase(row.new_status)}</span>
                    </div>
                    <span className="text-[11px] text-ink-500">{row.reason ?? "no reason recorded"}</span>
                    <span className="text-[10px] text-ink-600">{formatDateTime(row.changed_at)}</span>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="py-4 text-center text-xs text-ink-500">No status changes recorded yet.</p>
            )}
          </Panel>
        </div>

        <div className="space-y-4">
          <Panel>
            <PanelHeader title="Open incidents" subtitle="Linked to this asset" icon={<AlertTriangle className="h-4 w-4" />} />
            {data.active_incidents?.length ? (
              <ul className="space-y-2">
                {data.active_incidents.map((incident) => (
                  <li key={incident.id}>
                    <Link href={`/incidents/${incident.id}`} className="block rounded-xl border border-white/10 px-3 py-2 hover:border-coral/40">
                      <div className="flex items-center justify-between">
                        <span className="font-mono text-[10px] text-ink-500">{incident.code}</span>
                        <StatusPill status={incident.status} />
                      </div>
                      <p className="mt-1 text-xs text-white">{incident.title}</p>
                      <p className="text-[10px] text-ink-500">{incident.severity} severity</p>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="py-4 text-center text-xs text-ink-500">This asset is not involved in any open incident.</p>
            )}
          </Panel>

          <Panel>
            <PanelHeader title="Resilience notes" icon={<Network className="h-4 w-4" />} />
            <ul className="space-y-2 text-[11px] leading-relaxed text-ink-400">
              <li>
                <span className="text-ink-200">Criticality {data.criticality}</span> weights this asset in recovery
                optimisation: priority weights run from 60 (P1) to 2 (P5).
              </li>
              <li>
                Failure propagation walks downstream edges. Redundancy above 0.6 usually absorbs a single supplier loss.
              </li>
              <li>
                Changing status here does not alter incident state — resolve incidents through the incident workflow so
                verification rules apply.
              </li>
            </ul>
          </Panel>
        </div>
      </div>

      <Modal
        open={statusOpen}
        onClose={() => setStatusOpen(false)}
        title="Change operational status"
        description="Status changes are logged with the acting user and the stated reason."
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setStatusOpen(false)} disabled={busy}>Cancel</Button>
            <Button onClick={changeStatus} loading={busy}>Apply status</Button>
          </>
        }
      >
        <div className="space-y-3">
          <Field label="New status" htmlFor="status-select" required>
            <Select id="status-select" value={nextStatus} onChange={(event) => setNextStatus(event.target.value)}>
              {["operational", "degraded", "maintenance", "offline"].map((value) => (
                <option key={value} value={value}>{titleCase(value)}</option>
              ))}
            </Select>
          </Field>
          <Field label="Reason" htmlFor="status-reason" required hint="Minimum 3 characters. Stored in history and audit log.">
            <Textarea
              id="status-reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Offline for scheduled breaker maintenance until 18:00."
            />
          </Field>
          {error ? <Alert tone="danger">{error}</Alert> : null}
        </div>
      </Modal>
    </>
  );
}
