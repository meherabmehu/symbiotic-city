"use client";

/**
 * System Settings (Super Admin).
 *
 * Values are persisted through PATCH /api/settings/{key} and validated by type
 * on the server; the UI mirrors those types but never trusts itself.
 */

import { useEffect, useState } from "react";
import {
  CheckCircle2,
  Database,
  Gauge,
  RefreshCw,
  Save,
  Server,
  Settings as SettingsIcon,
  ShieldCheck,
  Sliders,
} from "lucide-react";
import {
  Alert,
  Badge,
  Button,
  Field,
  Input,
  PageHeader,
  Panel,
  PanelHeader,
  Select,
  Spinner,
  Tabs,
} from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatDateTime, titleCase } from "@/lib/format";
import { useAsync } from "@/lib/hooks";

interface SettingRow {
  id: number;
  key: string;
  value: string;
  label: string;
  description: string | null;
  section: string;
  value_type: string;
  updated_at: string;
}

interface Health {
  status: string;
  database: string;
  environment: string;
  counts: Record<string, number>;
  server_time: string;
  version: string;
}

export default function SettingsPage() {
  const { can } = useAuth();
  const [tab, setTab] = useState<string>("");
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [refreshKey, setRefreshKey] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const settings = useAsync<SettingRow[]>(() => api.get("/settings"), [refreshKey]);
  const health = useAsync<Health>(() => api.get("/system/health"), [refreshKey]);

  useEffect(() => {
    if (!settings.data) return;
    setDraft(Object.fromEntries(settings.data.map((row) => [row.key, row.value])));
    if (tab === "" && settings.data.length) setTab(settings.data[0].section);
  }, [settings.data, tab]);

  const sections = Array.from(new Set((settings.data ?? []).map((row) => row.section)));
  const rows = (settings.data ?? []).filter((row) => row.section === tab);

  async function save(row: SettingRow) {
    const value = draft[row.key];
    if (value === undefined || value === row.value) {
      setNotice("No change to save for this setting.");
      return;
    }
    setBusy(row.key);
    setError(null);
    try {
      await api.raw(`/settings/${encodeURIComponent(row.key)}?value=${encodeURIComponent(value)}`, {
        method: "PATCH",
      });
      setNotice(`${row.label} updated to “${value}”.`);
      setRefreshKey((k) => k + 1);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  if (!can("settings:manage")) {
    return (
      <>
        <PageHeader eyebrow="Governance" title="System settings" />
        <Alert tone="danger" title="Administrator access required">
          These settings require <code className="font-mono text-xs">settings:manage</code>. Operational behaviour that
          depends on them (cascade thresholds, reservation policy, retention) is still read from the database for every
          request.
        </Alert>
      </>
    );
  }

  return (
    <>
      <PageHeader
        eyebrow="Governance"
        title="System settings"
        description="Runtime configuration persisted in the database and audited on every change. Number and boolean values are validated server-side."
        actions={
          <Button variant="secondary" onClick={() => setRefreshKey((k) => k + 1)} loading={settings.loading}>
            <RefreshCw className="h-4 w-4" aria-hidden /> Refresh
          </Button>
        }
      />

      {error ? <Alert tone="danger" action={<Button variant="ghost" size="sm" onClick={() => setError(null)}>Dismiss</Button>}>{error}</Alert> : null}
      {notice ? <Alert tone="success" action={<Button variant="ghost" size="sm" onClick={() => setNotice(null)}>Dismiss</Button>}>{notice}</Alert> : null}

      <div className="grid gap-4 xl:grid-cols-[1fr_320px]">
        <div>
          {settings.loading && !settings.data ? (
            <div className="grid place-items-center py-20"><Spinner label="Loading settings…" /></div>
          ) : null}

          {sections.length ? (
            <Tabs value={tab} onChange={setTab} label="Setting sections" tabs={sections.map((section) => ({ id: section, label: titleCase(section) }))} />
          ) : null}

          <div className="mt-4 space-y-3">
            {rows.map((row) => {
              const changed = draft[row.key] !== row.value;
              return (
                <Panel key={row.key}>
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="text-sm font-medium text-white">{row.label}</p>
                        <Badge>{row.value_type}</Badge>
                        {changed ? <Badge tone="warning">unsaved</Badge> : null}
                      </div>
                      <p className="text-[10px] text-ink-500">{row.key}</p>
                      {row.description ? <p className="mt-1 text-[11px] text-ink-400">{row.description}</p> : null}
                      <p className="mt-1 text-[10px] text-ink-600">last changed {formatDateTime(row.updated_at)}</p>
                    </div>
                    <div className="flex items-end gap-2">
                      <div className="w-full sm:w-56">
                        {row.value_type === "boolean" ? (
                          <Select
                            value={draft[row.key] ?? row.value}
                            onChange={(event) => setDraft((prev) => ({ ...prev, [row.key]: event.target.value }))}
                            aria-label={row.label}
                          >
                            <option value="true">true</option>
                            <option value="false">false</option>
                          </Select>
                        ) : (
                          <Input
                            type={row.value_type === "number" ? "number" : "text"}
                            value={draft[row.key] ?? row.value}
                            onChange={(event) => setDraft((prev) => ({ ...prev, [row.key]: event.target.value }))}
                            aria-label={row.label}
                          />
                        )}
                      </div>
                      <Button
                        variant={changed ? "primary" : "secondary"}
                        size="sm"
                        onClick={() => save(row)}
                        loading={busy === row.key}
                        disabled={!changed}
                      >
                        <Save className="h-3.5 w-3.5" /> Save
                      </Button>
                    </div>
                  </div>
                </Panel>
              );
            })}
            {!settings.loading && rows.length === 0 ? (
              <Alert tone="info">No settings in this section.</Alert>
            ) : null}
          </div>
        </div>

        <div className="space-y-4">
          <Panel>
            <PanelHeader title="System health" subtitle="Live check against the database" icon={<Server className="h-4 w-4" />} />
            {health.data ? (
              <>
                <div className="flex items-center justify-between">
                  <span className="text-xs text-ink-400">Status</span>
                  <Badge tone={health.data.status === "ok" ? "success" : "danger"}>
                    <CheckCircle2 className="h-3 w-3" /> {health.data.status}
                  </Badge>
                </div>
                <dl className="mt-3 space-y-1.5 text-[11px]">
                  <div className="flex justify-between">
                    <dt className="text-ink-500">Database</dt>
                    <dd className="text-ink-200">{health.data.database}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-ink-500">Environment</dt>
                    <dd className="text-ink-200">{health.data.environment}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-ink-500">Version</dt>
                    <dd className="text-ink-200">{health.data.version}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-ink-500">Server time</dt>
                    <dd className="text-ink-200">{formatDateTime(health.data.server_time)}</dd>
                  </div>
                </dl>
                <div className="mt-3 grid grid-cols-2 gap-2">
                  {Object.entries(health.data.counts).map(([key, value]) => (
                    <div key={key} className="rounded-lg border border-white/10 bg-white/[0.03] px-2 py-1.5">
                      <p className="text-[9px] uppercase tracking-wider text-ink-500">{key}</p>
                      <p className="font-display text-sm font-semibold text-white">{value}</p>
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <Spinner label="Checking…" />
            )}
          </Panel>

          <Panel>
            <PanelHeader title="Scope of these settings" icon={<Sliders className="h-4 w-4" />} />
            <ul className="space-y-2 text-[11px] leading-relaxed text-ink-400">
              <li>Values are read from the database at request time, not cached at boot.</li>
              <li>Seeded defaults are documented in the backend seed module.</li>
              <li>Every change writes an audit entry with previous and new value.</li>
              <li>Simulation and solver behaviour is additionally pinned by explicit request parameters, so a setting change cannot silently alter a stored result.</li>
            </ul>
          </Panel>

          <Panel>
            <PanelHeader title="Data & retention" icon={<Database className="h-4 w-4" />} />
            <p className="text-[11px] leading-relaxed text-ink-400">
              Aurora Vale is synthetic. Reseeding is a deliberate operator action (see README) — it is never triggered
              by application traffic.
            </p>
            <p className="mt-2 flex items-center gap-1 text-[10px] text-ink-500">
              <ShieldCheck className="h-3 w-3" /> No external telemetry or third-party analytics.
            </p>
          </Panel>

          <Panel>
            <PanelHeader title="Tuning hints" icon={<Gauge className="h-4 w-4" />} />
            <p className="text-[11px] leading-relaxed text-ink-400">
              Cascade threshold and max depth also exist as explicit per-run parameters in the failure lab. Changing
              them here alters defaults for new requests; existing stored runs keep the parameters they were executed
              with.
            </p>
            <p className="mt-2 flex items-center gap-1 text-[10px] text-ink-500">
              <SettingsIcon className="h-3 w-3" /> Prefer lab-level parameters while demonstrating.
            </p>
          </Panel>
        </div>
      </div>
    </>
  );
}
