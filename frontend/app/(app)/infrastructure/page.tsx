"use client";

/**
 * Screen 07 — Infrastructure Management.
 *
 * Server-side search/filter/sort/pagination against GET /api/infrastructure.
 * Create, edit, status change, dependencies and archive all call real
 * endpoints; the write controls only render for roles that hold the
 * infrastructure permissions (the API enforces them regardless).
 */

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  Archive,
  Building2,
  ChevronUp,
  CircuitBoard,
  Download,
  Link2,
  Network,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import {
  Alert,
  Badge,
  Button,
  ConfirmDialog,
  DataTable,
  Field,
  Input,
  Modal,
  PageHeader,
  Pagination,
  Panel,
  SearchInput,
  Select,
  StatusPill,
  Tabs,
  Textarea,
} from "@/components/ui";
import { api, errorMessage, qs } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatNumber, titleCase } from "@/lib/format";
import { useAsync, useDebounced } from "@/lib/hooks";
import type { Asset, DependencyRow, ItemResponse, ListResponse, Meta, Zone } from "@/lib/types";

const PAGE_SIZE = 10;

export default function InfrastructurePage() {
  const { can } = useAuth();
  const [tab, setTab] = useState<"assets" | "dependencies">("assets");
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("");
  const [status, setStatus] = useState("");
  const [zoneId, setZoneId] = useState("");
  const [sort, setSort] = useState("name");
  const [direction, setDirection] = useState<"asc" | "desc">("asc");
  const debounced = useDebounced(search);

  const [showCreate, setShowCreate] = useState(false);
  const [editing, setEditing] = useState<Asset | null>(null);
  const [archiving, setArchiving] = useState<Asset | null>(null);
  const [linking, setLinking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const categoriesQuery = useAsync<{ key: string; label: string }[]>(
    () => api.get("/infrastructure/categories"),
    [],
  );
  const zonesQuery = useAsync<Zone[]>(() => api.get("/zones"), []);

  const assetsQuery = useAsync<{ rows: Asset[]; meta: Meta }>(
    async (signal) => {
      const response: ListResponse<Asset> = await api.list(
        `/infrastructure${qs({
          page,
          page_size: PAGE_SIZE,
          search: debounced,
          category,
          status,
          zone_id: zoneId,
          sort,
          direction,
        })}`,
        { signal },
      );
      return { rows: response.data, meta: response.meta };
    },
    [page, debounced, category, status, zoneId, sort, direction, refreshKey],
  );

  useEffect(() => {
    setPage(1);
  }, [debounced, category, status, zoneId]);

  const dependenciesQuery = useAsync<DependencyRow[]>(
    () => api.get("/dependencies"),
    [refreshKey],
  );

  const refreshAll = () => setRefreshKey((key) => key + 1);

  const rows = assetsQuery.data?.rows ?? [];
  const meta = assetsQuery.data?.meta;

  const summary = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const asset of rows) counts[asset.status] = (counts[asset.status] ?? 0) + 1;
    return counts;
  }, [rows]);

  async function submitCreate(form: HTMLFormElement) {
    const data = new FormData(form);
    setBusy(true);
    setFormError(null);
    try {
      const payload = buildAssetPayload(data);
      await api.post("/infrastructure", payload);
      setShowCreate(false);
      setNotice(`${payload.code} registered.`);
      refreshAll();
    } catch (err) {
      setFormError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function submitEdit(form: HTMLFormElement, asset: Asset) {
    const data = new FormData(form);
    setBusy(true);
    setFormError(null);
    try {
      const payload = buildAssetPayload(data);
      delete (payload as Record<string, unknown>).code;
      await api.patch(`/infrastructure/${asset.id}`, payload);
      setEditing(null);
      setNotice(`${asset.code} updated.`);
      refreshAll();
    } catch (err) {
      setFormError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function confirmArchive() {
    if (!archiving) return;
    setBusy(true);
    try {
      const result = await api.del<{ message: string }>(`/infrastructure/${archiving.id}`);
      setNotice(result.message);
      setArchiving(null);
      refreshAll();
    } catch (err) {
      setFormError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function submitDependency(form: HTMLFormElement) {
    const data = new FormData(form);
    setBusy(true);
    setFormError(null);
    try {
      await api.post("/dependencies", {
        source_asset_id: Number(data.get("source_asset_id")),
        target_asset_id: Number(data.get("target_asset_id")),
        dependency_type: String(data.get("dependency_type")),
        impact_weight: Number(data.get("impact_weight")),
        redundancy: Number(data.get("redundancy")),
        description: String(data.get("description") || "") || null,
      });
      setLinking(false);
      setNotice("Dependency created.");
      refreshAll();
    } catch (err) {
      setFormError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function removeDependency(row: DependencyRow) {
    if (!window.confirm(`Remove ${row.source_code} → ${row.target_code}?`)) return;
    try {
      await api.del(`/dependencies/${row.id}`);
      setNotice("Dependency removed.");
      refreshAll();
    } catch (err) {
      setFormError(errorMessage(err));
    }
  }

  function exportCsv() {
    const header = ["code", "name", "category", "status", "criticality", "zone", "capacity", "load_percent"];
    const lines = rows.map((asset) =>
      [
        asset.code,
        `"${asset.name.replace(/"/g, '""')}"`,
        asset.category,
        asset.status,
        asset.criticality,
        asset.zone?.name ?? "",
        asset.capacity,
        asset.load_percent,
      ].join(","),
    );
    const blob = new Blob([[header.join(","), ...lines].join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `infrastructure-page-${page}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
    setNotice("Current page exported as CSV.");
  }

  const allAssets = useAsync<Asset[]>(async () => {
    const response = await api.list<Asset>("/infrastructure?page_size=100&sort=code");
    return response.data;
  }, [refreshKey]);

  return (
    <>
      <PageHeader
        eyebrow="Asset registry"
        title="Infrastructure"
        description="Every physical asset in Aurora Vale with its zone, criticality, capacity and dependency links. Changes are audited and propagate into the twin and the cascade model."
        actions={
          <>
            <Button variant="secondary" onClick={exportCsv} disabled={!rows.length}>
              <Download className="h-4 w-4" aria-hidden /> Export page
            </Button>
            {can("infrastructure:write") ? (
              <Button onClick={() => { setFormError(null); setShowCreate(true); }}>
                <Plus className="h-4 w-4" aria-hidden /> Register asset
              </Button>
            ) : null}
          </>
        }
      />

      {notice ? (
        <Alert tone="success" action={<Button variant="ghost" size="sm" onClick={() => setNotice(null)}>Dismiss</Button>}>
          {notice}
        </Alert>
      ) : null}
      {formError && !showCreate && !editing && !linking ? (
        <Alert tone="danger" title="Action failed">
          {formError}
        </Alert>
      ) : null}
      {assetsQuery.error ? (
        <Alert tone="danger" title="Could not load assets">
          {assetsQuery.error}
        </Alert>
      ) : null}

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <Tabs
          value={tab}
          onChange={setTab}
          tabs={[
            { id: "assets", label: "Assets", count: meta?.total },
            { id: "dependencies", label: "Dependencies", count: dependenciesQuery.data?.length },
          ]}
          label="Infrastructure views"
        />
        <div className="flex flex-wrap gap-2">
          {Object.entries(summary).map(([key, count]) => (
            <Badge key={key} tone={key === "offline" ? "danger" : key === "degraded" ? "warning" : "neutral"}>
              {count} {key}
            </Badge>
          ))}
        </div>
      </div>

      {tab === "assets" ? (
        <Panel>
          <div className="mb-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
            <div className="lg:col-span-2">
              <SearchInput
                value={search}
                onChange={setSearch}
                placeholder="Search code, name or notes…"
                label="Search assets"
              />
            </div>
            <Select value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Filter by category">
              <option value="">All categories</option>
              {(categoriesQuery.data ?? []).map((option) => (
                <option key={option.key} value={option.key}>
                  {option.label}
                </option>
              ))}
            </Select>
            <Select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Filter by status">
              <option value="">All statuses</option>
              {["operational", "degraded", "offline", "maintenance"].map((value) => (
                <option key={value} value={value}>
                  {titleCase(value)}
                </option>
              ))}
            </Select>
            <Select value={zoneId} onChange={(e) => setZoneId(e.target.value)} aria-label="Filter by zone">
              <option value="">All zones</option>
              {(zonesQuery.data ?? []).map((zone) => (
                <option key={zone.id} value={zone.id}>
                  {zone.name}
                </option>
              ))}
            </Select>
          </div>

          <DataTable
            rows={rows}
            loading={assetsQuery.loading}
            getKey={(asset) => asset.id}
            empty={
              <div className="rounded-xl border border-dashed border-white/10 px-4 py-12 text-center">
                <p className="text-sm font-medium text-white">No assets match those filters</p>
                <p className="mt-1 text-xs text-ink-400">Clear the search or register a new asset.</p>
              </div>
            }
            columns={[
              {
                key: "code",
                header: "Asset",
                render: (asset) => (
                  <div>
                    <Link href={`/infrastructure/${asset.id}`} className="text-sm font-medium text-white hover:text-accent">
                      {asset.name}
                    </Link>
                    <p className="font-mono text-[10px] text-ink-500">
                      {asset.code} · {asset.category_label}
                    </p>
                  </div>
                ),
              },
              {
                key: "zone",
                header: "Zone",
                render: (asset) => <span className="text-xs text-ink-300">{asset.zone?.name ?? "—"}</span>,
              },
              {
                key: "status",
                header: "Status",
                render: (asset) => <StatusPill status={asset.status} />,
              },
              {
                key: "criticality",
                header: (
                  <button
                    className="inline-flex items-center gap-1 text-[11px] uppercase tracking-wider hover:text-white"
                    onClick={() => {
                      setSort("criticality");
                      setDirection(direction === "asc" ? "desc" : "asc");
                    }}
                  >
                    Priority <ChevronUp className={`h-3 w-3 ${direction === "desc" ? "rotate-180" : ""}`} />
                  </button>
                ),
                render: (asset) => (
                  <span className="text-xs text-ink-200">
                    P{asset.criticality} · {formatNumber(asset.capacity)} {asset.capacity_unit}
                  </span>
                ),
              },
              {
                key: "load",
                header: "Load",
                render: (asset) => (
                  <span
                    className={
                      asset.load_percent > 85 ? "text-xs text-coral" : asset.load_percent > 65 ? "text-xs text-amber" : "text-xs text-ink-200"
                    }
                  >
                    {asset.load_percent.toFixed(0)}%
                  </span>
                ),
              },
              {
                key: "links",
                header: "Links",
                render: (asset) => (
                  <span className="inline-flex items-center gap-1 text-[11px] text-ink-400">
                    <Network className="h-3 w-3" /> {asset.inbound_dependencies ?? 0} in / {asset.outbound_dependencies ?? 0} out
                  </span>
                ),
              },
              {
                key: "actions",
                header: "",
                className: "text-right",
                render: (asset) => (
                  <div className="flex justify-end gap-1">
                    <Link href={`/infrastructure/${asset.id}`} className="btn-ghost btn-sm" aria-label={`View ${asset.code}`}>
                      <Building2 className="h-3.5 w-3.5" />
                    </Link>
                    {can("infrastructure:write") ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={`Edit ${asset.code}`}
                        onClick={() => { setFormError(null); setEditing(asset); }}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                    ) : null}
                    {can("infrastructure:delete") ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={`Archive ${asset.code}`}
                        onClick={() => setArchiving(asset)}
                      >
                        <Archive className="h-3.5 w-3.5" />
                      </Button>
                    ) : null}
                  </div>
                ),
              },
            ]}
          />
          {meta ? <Pagination meta={meta} onPage={setPage} /> : null}
        </Panel>
      ) : (
        <Panel>
          <div className="mb-3 flex items-center justify-between">
            <p className="text-xs text-ink-400">
              Edges point from supplier to dependent. Weight controls how much of a supplier failure transfers;
              redundancy reduces the effective impact.
            </p>
            {can("infrastructure:write") ? (
              <Button variant="secondary" size="sm" onClick={() => { setFormError(null); setLinking(true); }}>
                <Link2 className="h-3.5 w-3.5" /> Add link
              </Button>
            ) : null}
          </div>
          <DataTable
            rows={dependenciesQuery.data ?? []}
            loading={dependenciesQuery.loading}
            getKey={(row) => row.id}
            empty={<p className="py-10 text-center text-sm text-ink-400">No dependencies recorded.</p>}
            columns={[
              {
                key: "edge",
                header: "Link",
                render: (row) => (
                  <div className="flex items-center gap-2 text-xs">
                    <span className="font-mono text-ink-200">{row.source_code}</span>
                    <CircuitBoard className="h-3 w-3 text-accent" />
                    <span className="font-mono text-ink-200">{row.target_code}</span>
                  </div>
                ),
              },
              { key: "type", header: "Type", render: (row) => <Badge>{row.dependency_type}</Badge> },
              {
                key: "weight",
                header: "Weight / redundancy",
                render: (row) => (
                  <span className="text-xs text-ink-300">
                    {row.impact_weight.toFixed(2)} / {row.redundancy.toFixed(2)}
                  </span>
                ),
              },
              {
                key: "note",
                header: "Notes",
                render: (row) => <span className="text-[11px] text-ink-500">{row.description ?? "—"}</span>,
              },
              {
                key: "actions",
                header: "",
                className: "text-right",
                render: (row) =>
                  can("infrastructure:write") ? (
                    <Button variant="ghost" size="sm" onClick={() => removeDependency(row)} aria-label="Remove dependency">
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  ) : null,
              },
            ]}
          />
        </Panel>
      )}

      <Modal
        open={showCreate}
        onClose={() => setShowCreate(false)}
        title="Register infrastructure asset"
        description="Code must be unique and uppercase alphanumeric."
        footer={
          <>
            <Button variant="ghost" onClick={() => setShowCreate(false)} disabled={busy}>Cancel</Button>
            <Button type="submit" form="create-asset" loading={busy}>Register asset</Button>
          </>
        }
      >
        {formError ? <Alert tone="danger">{formError}</Alert> : null}
        <form
          id="create-asset"
          className="mt-3 grid gap-3 sm:grid-cols-2"
          onSubmit={(event) => {
            event.preventDefault();
            void submitCreate(event.currentTarget);
          }}
        >
          <Field label="Asset code" htmlFor="create-code" required>
            <Input id="create-code" name="code" required placeholder="PS-06" pattern="[A-Za-z0-9][A-Za-z0-9\-_]{1,29}" />
          </Field>
          <Field label="Name" htmlFor="create-name" required>
            <Input id="create-name" name="name" required placeholder="Northgate Substation" />
          </Field>
          <Field label="Category" htmlFor="create-category" required>
            <Select id="create-category" name="category" required defaultValue="substation">
              {(categoriesQuery.data ?? []).map((option) => (
                <option key={option.key} value={option.key}>{option.label}</option>
              ))}
            </Select>
          </Field>
          <Field label="Zone" htmlFor="create-zone">
            <Select id="create-zone" name="zone_id" defaultValue="">
              <option value="">Unzoned</option>
              {(zonesQuery.data ?? []).map((zone) => (
                <option key={zone.id} value={zone.id}>{zone.name}</option>
              ))}
            </Select>
          </Field>
          <Field label="Criticality" htmlFor="create-criticality" required>
            <Select id="create-criticality" name="criticality" defaultValue="3">
              {[1, 2, 3, 4, 5].map((value) => (
                <option key={value} value={value}>Priority {value}{value === 1 ? " — critical" : ""}</option>
              ))}
            </Select>
          </Field>
          <Field label="Status" htmlFor="create-status" required>
            <Select id="create-status" name="status" defaultValue="operational">
              {["operational", "degraded", "maintenance", "offline"].map((value) => (
                <option key={value} value={value}>{titleCase(value)}</option>
              ))}
            </Select>
          </Field>
          <Field label="Capacity" htmlFor="create-capacity" required>
            <Input id="create-capacity" name="capacity" type="number" min={0} step="0.1" defaultValue={100} required />
          </Field>
          <Field label="Capacity unit" htmlFor="create-unit" required>
            <Input id="create-unit" name="capacity_unit" defaultValue="MVA" required />
          </Field>
          <Field label="Load %" htmlFor="create-load" required>
            <Input id="create-load" name="load_percent" type="number" min={0} max={100} step="0.1" defaultValue={50} required />
          </Field>
          <Field label="Built year" htmlFor="create-built">
            <Input id="create-built" name="built_year" type="number" min={1900} max={2100} placeholder="2011" />
          </Field>
          <Field label="Latitude" htmlFor="create-lat" required>
            <Input id="create-lat" name="latitude" type="number" step="0.0001" defaultValue={23.8103} required />
          </Field>
          <Field label="Longitude" htmlFor="create-lng" required>
            <Input id="create-lng" name="longitude" type="number" step="0.0001" defaultValue={90.4125} required />
          </Field>
          <Field label="Map X (0–100)" htmlFor="create-x" required>
            <Input id="create-x" name="map_x" type="number" min={0} max={100} step="0.1" defaultValue={50} required />
          </Field>
          <Field label="Map Y (0–100)" htmlFor="create-y" required>
            <Input id="create-y" name="map_y" type="number" min={0} max={100} step="0.1" defaultValue={50} required />
          </Field>
          <div className="sm:col-span-2">
            <Field label="Notes" htmlFor="create-notes">
              <Textarea id="create-notes" name="notes" maxLength={2000} placeholder="Commissioning notes, constraints, maintenance windows…" />
            </Field>
          </div>
        </form>
      </Modal>

      <Modal
        open={Boolean(editing)}
        onClose={() => setEditing(null)}
        title={`Edit ${editing?.code ?? ""}`}
        description="Code is immutable once registered. Status changes are recorded in asset history."
        footer={
          <>
            <Button variant="ghost" onClick={() => setEditing(null)} disabled={busy}>Cancel</Button>
            <Button type="submit" form="edit-asset" loading={busy}>Save changes</Button>
          </>
        }
      >
        {formError ? <Alert tone="danger">{formError}</Alert> : null}
        {editing ? (
          <form
            id="edit-asset"
            className="mt-3 grid gap-3 sm:grid-cols-2"
            onSubmit={(event) => {
              event.preventDefault();
              void submitEdit(event.currentTarget, editing);
            }}
          >
            <Field label="Asset code" htmlFor="edit-code">
              <Input id="edit-code" name="code" value={editing.code} readOnly disabled />
            </Field>
            <Field label="Name" htmlFor="edit-name" required>
              <Input id="edit-name" name="name" defaultValue={editing.name} required />
            </Field>
            <Field label="Category" htmlFor="edit-category">
              <Select id="edit-category" name="category" defaultValue={editing.category}>
                {(categoriesQuery.data ?? []).map((option) => (
                  <option key={option.key} value={option.key}>{option.label}</option>
                ))}
              </Select>
            </Field>
            <Field label="Zone" htmlFor="edit-zone">
              <Select id="edit-zone" name="zone_id" defaultValue={editing.zone_id ?? ""}>
                <option value="">Unzoned</option>
                {(zonesQuery.data ?? []).map((zone) => (
                  <option key={zone.id} value={zone.id}>{zone.name}</option>
                ))}
              </Select>
            </Field>
            <Field label="Criticality" htmlFor="edit-criticality">
              <Select id="edit-criticality" name="criticality" defaultValue={editing.criticality}>
                {[1, 2, 3, 4, 5].map((value) => (
                  <option key={value} value={value}>Priority {value}</option>
                ))}
              </Select>
            </Field>
            <Field label="Status" htmlFor="edit-status">
              <Select id="edit-status" name="status" defaultValue={editing.status}>
                {["operational", "degraded", "maintenance", "offline"].map((value) => (
                  <option key={value} value={value}>{titleCase(value)}</option>
                ))}
              </Select>
            </Field>
            <Field label="Capacity" htmlFor="edit-capacity">
              <Input id="edit-capacity" name="capacity" type="number" min={0} step="0.1" defaultValue={editing.capacity} />
            </Field>
            <Field label="Capacity unit" htmlFor="edit-unit">
              <Input id="edit-unit" name="capacity_unit" defaultValue={editing.capacity_unit} />
            </Field>
            <Field label="Load %" htmlFor="edit-load">
              <Input id="edit-load" name="load_percent" type="number" min={0} max={100} step="0.1" defaultValue={editing.load_percent} />
            </Field>
            <Field label="Built year" htmlFor="edit-built">
              <Input id="edit-built" name="built_year" type="number" min={1900} max={2100} defaultValue={editing.built_year ?? ""} />
            </Field>
            <Field label="Map X" htmlFor="edit-x">
              <Input id="edit-x" name="map_x" type="number" min={0} max={100} step="0.1" defaultValue={editing.map_x} />
            </Field>
            <Field label="Map Y" htmlFor="edit-y">
              <Input id="edit-y" name="map_y" type="number" min={0} max={100} step="0.1" defaultValue={editing.map_y} />
            </Field>
            <div className="sm:col-span-2">
              <Field label="Notes" htmlFor="edit-notes">
                <Textarea id="edit-notes" name="notes" defaultValue={editing.notes ?? ""} maxLength={2000} />
              </Field>
            </div>
          </form>
        ) : null}
      </Modal>

      <Modal
        open={linking}
        onClose={() => setLinking(false)}
        title="Create dependency"
        description="A supplier may not depend on itself and cycles are rejected by the API."
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setLinking(false)} disabled={busy}>Cancel</Button>
            <Button type="submit" form="create-dependency" loading={busy}>Create link</Button>
          </>
        }
      >
        {formError ? <Alert tone="danger">{formError}</Alert> : null}
        <form
          id="create-dependency"
          className="mt-3 space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            void submitDependency(event.currentTarget);
          }}
        >
          <Field label="Source (supplier)" htmlFor="dep-source" required>
            <Select id="dep-source" name="source_asset_id" required>
              {(allAssets.data ?? []).map((asset) => (
                <option key={asset.id} value={asset.id}>{asset.code} — {asset.name}</option>
              ))}
            </Select>
          </Field>
          <Field label="Target (dependent)" htmlFor="dep-target" required>
            <Select id="dep-target" name="target_asset_id" required>
              {(allAssets.data ?? []).map((asset) => (
                <option key={asset.id} value={asset.id}>{asset.code} — {asset.name}</option>
              ))}
            </Select>
          </Field>
          <Field label="Dependency type" htmlFor="dep-type" required>
            <Select id="dep-type" name="dependency_type" defaultValue="power">
              {["power", "water", "telecom", "logistics", "staffing"].map((value) => (
                <option key={value} value={value}>{titleCase(value)}</option>
              ))}
            </Select>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Impact weight" htmlFor="dep-weight" hint="0–1" required>
              <Input id="dep-weight" name="impact_weight" type="number" min={0} max={1} step="0.05" defaultValue={0.8} required />
            </Field>
            <Field label="Redundancy" htmlFor="dep-redundancy" hint="0–1" required>
              <Input id="dep-redundancy" name="redundancy" type="number" min={0} max={1} step="0.05" defaultValue={0.2} required />
            </Field>
          </div>
          <Field label="Description" htmlFor="dep-description">
            <Textarea id="dep-description" name="description" maxLength={300} placeholder="Dual feed from Northgate via feeder 3." />
          </Field>
        </form>
      </Modal>

      <ConfirmDialog
        open={Boolean(archiving)}
        title={`Archive ${archiving?.code ?? "asset"}?`}
        message="Archiving preserves all history and dependency links for audit, but removes the asset from operational lists and the twin."
        confirmLabel="Archive asset"
        destructive
        loading={busy}
        onCancel={() => setArchiving(null)}
        onConfirm={confirmArchive}
      />
    </>
  );
}

function buildAssetPayload(data: FormData): Record<string, unknown> {
  const numeric = ["capacity", "load_percent", "latitude", "longitude", "map_x", "map_y"];
  const optionalNumeric = ["built_year", "zone_id"];
  const payload: Record<string, unknown> = {};
  for (const [key, value] of data.entries()) {
    if (value === "") {
      payload[key] = key === "notes" || key === "zone_id" || key === "built_year" ? null : undefined;
      continue;
    }
    if (numeric.includes(key) || optionalNumeric.includes(key) || key === "criticality") {
      payload[key] = Number(value);
    } else {
      payload[key] = String(value);
    }
  }
  return payload;
}

export type { ItemResponse };
