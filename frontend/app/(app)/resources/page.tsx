"use client";

/**
 * Screen 12 — Resource Management.
 *
 * Inventory with live reservation accounting. Reservations are transactional:
 * the API refuses to over-book, and releases are recorded with a reason.
 */

import { useState } from "react";
import {
  AlertTriangle,
  Boxes,
  CheckCircle2,
  Gauge,
  Lock,
  PackageOpen,
  Plus,
  Truck,
  Unlock,
} from "lucide-react";
import {
  Alert,
  Badge,
  Button,
  ConfirmDialog,
  DataTable,
  EmptyState,
  Field,
  Input,
  Modal,
  PageHeader,
  Panel,
  PanelHeader,
  ProgressBar,
  SearchInput,
  Select,
  StatusPill,
  Tabs,
  Textarea,
} from "@/components/ui";
import { api, errorMessage, qs } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatDateTime, formatNumber, percent, titleCase } from "@/lib/format";
import { useAsync, useDebounced } from "@/lib/hooks";
import type { ListResponse, Reservation, Resource } from "@/lib/types";

export default function ResourcesPage() {
  const { can } = useAuth();
  const [tab, setTab] = useState<"inventory" | "reservations">("inventory");
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("");
  const debounced = useDebounced(search);
  const [refreshKey, setRefreshKey] = useState(0);
  const [creating, setCreating] = useState(false);
  const [reserving, setReserving] = useState<Resource | null>(null);
  const [releasing, setReleasing] = useState<Reservation | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const resources = useAsync<Resource[]>(
    async (signal) =>
      (
        await api.list<Resource>(
          `/resources${qs({ page_size: 100, search: debounced, category, sort: "code" })}`,
          { signal },
        )
      ).data,
    [debounced, category, refreshKey],
  );

  const categories = useAsync<{ key: string; label: string }[]>(() => api.get("/resources/categories"), []);
  const utilisation = useAsync<
    { category: string; label: string; count: number; capacity: number; reserved: number; available: number; utilisation_percent: number }[]
  >(() => api.get("/resources/utilisation"), [refreshKey]);
  const reservations = useAsync<Reservation[]>(() => api.get("/resources/reservations"), [refreshKey]);

  const totals = (resources.data ?? []).reduce(
    (acc, resource) => {
      acc.capacity += resource.capacity;
      acc.reserved += resource.reserved_quantity;
      acc.available += resource.available_quantity;
      return acc;
    },
    { capacity: 0, reserved: 0, available: 0 },
  );

  async function createResource(form: HTMLFormElement) {
    const data = new FormData(form);
    setBusy(true);
    setError(null);
    try {
      await api.post("/resources", {
        code: String(data.get("code")).toUpperCase(),
        name: String(data.get("name")),
        category: String(data.get("category")),
        capacity: Number(data.get("capacity")),
        capacity_unit: String(data.get("capacity_unit")),
        status: String(data.get("status")),
        hourly_cost: Number(data.get("hourly_cost")),
        mobilisation_minutes: Number(data.get("mobilisation_minutes")),
        notes: String(data.get("notes") || "") || null,
      });
      setCreating(false);
      setNotice("Resource registered.");
      setRefreshKey((k) => k + 1);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function reserveCapacity(form: HTMLFormElement) {
    if (!reserving) return;
    const data = new FormData(form);
    setBusy(true);
    setError(null);
    try {
      await api.post(`/resources/${reserving.id}/reserve`, {
        quantity: Number(data.get("quantity")),
        idempotency_key: `ui-reserve-${reserving.id}-${Date.now()}`,
      });
      setNotice(`Reserved ${formatNumber(Number(data.get("quantity")))} ${reserving.capacity_unit} of ${reserving.code}.`);
      setReserving(null);
      setRefreshKey((k) => k + 1);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function release() {
    if (!releasing) return;
    setBusy(true);
    setError(null);
    try {
      await api.post(`/resources/reservations/${releasing.id}/release`, {
        reason: "Released from resource console",
      });
      setNotice("Reservation released. Capacity is available again.");
      setReleasing(null);
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
        eyebrow="Resource pool"
        title="Resource management"
        description="Generators, water tankers, pumps, crews and telecom units. Reservations are transactional and idempotent: the same request key never books capacity twice."
        actions={
          can("resource:write") ? (
            <Button onClick={() => { setError(null); setCreating(true); }}>
              <Plus className="h-4 w-4" aria-hidden /> Register resource
            </Button>
          ) : null
        }
      >
        <div className="mt-4 flex flex-wrap gap-2">
          <Badge tone="accent">{formatNumber(totals.capacity)} total capacity</Badge>
          <Badge tone="warning">{formatNumber(totals.reserved)} reserved</Badge>
          <Badge tone="success">{formatNumber(totals.available)} available</Badge>
        </div>
      </PageHeader>

      {error ? <Alert tone="danger" title="Action failed" action={<Button variant="ghost" size="sm" onClick={() => setError(null)}>Dismiss</Button>}>{error}</Alert> : null}
      {notice ? <Alert tone="success" action={<Button variant="ghost" size="sm" onClick={() => setNotice(null)}>Dismiss</Button>}>{notice}</Alert> : null}

      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {(utilisation.data ?? []).slice(0, 4).map((row) => (
          <div key={row.category} className="glass p-4">
            <div className="flex items-center justify-between">
              <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-ink-500">{row.label}</p>
              <Gauge className="h-3.5 w-3.5 text-ink-500" />
            </div>
            <p className="mt-1 font-display text-xl font-semibold text-white">
              {row.available}
              <span className="text-xs font-normal text-ink-400"> / {row.capacity}</span>
            </p>
            <div className="mt-2">
              <ProgressBar
                value={row.utilisation_percent}
                tone={row.utilisation_percent > 85 ? "coral" : row.utilisation_percent > 60 ? "amber" : "mint"}
                label={`${row.label} utilisation`}
              />
            </div>
            <p className="mt-1 text-[10px] text-ink-500">{percent(row.utilisation_percent, 0)} reserved</p>
          </div>
        ))}
      </div>

      <Tabs
        value={tab}
        onChange={setTab}
        label="Resource sections"
        tabs={[
          { id: "inventory", label: "Inventory", count: resources.data?.length },
          { id: "reservations", label: "Reservations", count: reservations.data?.length },
        ]}
      />

      {tab === "inventory" ? (
        <Panel className="mt-4">
          <div className="mb-3 flex flex-wrap gap-2">
            <div className="min-w-[220px] flex-1">
              <SearchInput value={search} onChange={setSearch} placeholder="Search code or name…" label="Search resources" />
            </div>
            <Select value={category} onChange={(event) => setCategory(event.target.value)} aria-label="Filter by category" className="max-w-[200px]">
              <option value="">All categories</option>
              {(categories.data ?? []).map((option) => (
                <option key={option.key} value={option.key}>{option.label}</option>
              ))}
            </Select>
          </div>

          <DataTable
            rows={resources.data ?? []}
            loading={resources.loading}
            getKey={(resource) => resource.id}
            empty={<EmptyState title="No resources match" description="Adjust the filters or register a new resource." icon={<Boxes className="h-5 w-5" />} />}
            columns={[
              {
                key: "resource",
                header: "Resource",
                render: (resource) => (
                  <div>
                    <p className="text-sm font-medium text-white">{resource.name}</p>
                    <p className="font-mono text-[10px] text-ink-500">{resource.code} · {titleCase(resource.category)}</p>
                  </div>
                ),
              },
              { key: "status", header: "Status", render: (resource) => <StatusPill status={resource.status} /> },
              {
                key: "capacity",
                header: "Capacity",
                render: (resource) => (
                  <div className="min-w-[140px]">
                    <p className="text-xs text-ink-200">
                      {formatNumber(resource.available_quantity)} / {formatNumber(resource.capacity)} {resource.capacity_unit}
                    </p>
                    <div className="mt-1">
                      <ProgressBar
                        value={(resource.reserved_quantity / Math.max(1, resource.capacity)) * 100}
                        tone={resource.available_quantity <= 0 ? "coral" : "amber"}
                        label={`${resource.code} reserved`}
                      />
                    </div>
                    <p className="mt-0.5 text-[10px] text-ink-500">{formatNumber(resource.reserved_quantity)} reserved</p>
                  </div>
                ),
              },
              {
                key: "cost",
                header: "Cost / mobilisation",
                render: (resource) => (
                  <span className="text-[11px] text-ink-400">
                    ${resource.hourly_cost}/h · {resource.mobilisation_minutes} min
                  </span>
                ),
              },
              {
                key: "actions",
                header: "",
                className: "text-right",
                render: (resource) =>
                  can("resource:write") ? (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => { setError(null); setReserving(resource); }}
                      disabled={resource.available_quantity <= 0}
                    >
                      <Lock className="h-3.5 w-3.5" /> Reserve
                    </Button>
                  ) : (
                    <Badge>read only</Badge>
                  ),
              },
            ]}
          />
        </Panel>
      ) : (
        <Panel className="mt-4">
          <PanelHeader title="Reservation ledger" subtitle="Every hold against a plan, task or workflow" icon={<Truck className="h-4 w-4" />} />
          <DataTable
            rows={reservations.data ?? []}
            loading={reservations.loading}
            getKey={(row) => row.id}
            empty={<EmptyState title="No reservations yet" description="Approving a plan or reserving manually creates the first entry." icon={<PackageOpen className="h-5 w-5" />} />}
            columns={[
              {
                key: "resource",
                header: "Resource",
                render: (row) => {
                  const resource = (resources.data ?? []).find((item) => item.id === row.resource_id);
                  return (
                    <span className="text-xs text-ink-200">
                      {resource ? `${resource.code} · ${resource.name}` : `resource #${row.resource_id}`}
                    </span>
                  );
                },
              },
              { key: "quantity", header: "Quantity", render: (row) => <span className="text-xs text-ink-300">{formatNumber(row.quantity)}</span> },
              {
                key: "link",
                header: "Held for",
                render: (row) => (
                  <span className="text-[11px] text-ink-400">
                    {row.plan_id ? `plan #${row.plan_id}` : row.repair_task_id ? `task #${row.repair_task_id}` : row.workflow_id ? `workflow #${row.workflow_id}` : "manual hold"}
                  </span>
                ),
              },
              { key: "status", header: "Status", render: (row) => <StatusPill status={row.status} /> },
              {
                key: "when",
                header: "Reserved",
                render: (row) => <span className="text-[11px] text-ink-500">{formatDateTime(row.reserved_at)}</span>,
              },
              {
                key: "actions",
                header: "",
                className: "text-right",
                render: (row) =>
                  row.status === "active" && can("resource:write") ? (
                    <Button variant="ghost" size="sm" onClick={() => setReleasing(row)} aria-label="Release reservation">
                      <Unlock className="h-3.5 w-3.5" /> Release
                    </Button>
                  ) : null,
              },
            ]}
          />
        </Panel>
      )}

      <Modal
        open={creating}
        onClose={() => setCreating(false)}
        title="Register resource"
        description="Capacity is the total pool; reservations draw it down."
        footer={
          <>
            <Button variant="ghost" onClick={() => setCreating(false)} disabled={busy}>Cancel</Button>
            <Button type="submit" form="create-resource" loading={busy}>Register</Button>
          </>
        }
      >
        {error ? <Alert tone="danger">{error}</Alert> : null}
        <form
          id="create-resource"
          className="mt-3 grid gap-3 sm:grid-cols-2"
          onSubmit={(event) => { event.preventDefault(); void createResource(event.currentTarget); }}
        >
          <Field label="Code" htmlFor="res-code" required>
            <Input id="res-code" name="code" required placeholder="GEN-07" />
          </Field>
          <Field label="Name" htmlFor="res-name" required>
            <Input id="res-name" name="name" required placeholder="Mobile generator 500 kVA" />
          </Field>
          <Field label="Category" htmlFor="res-category" required>
            <Select id="res-category" name="category" required>
              {(categories.data ?? []).map((option) => (
                <option key={option.key} value={option.key}>{option.label}</option>
              ))}
            </Select>
          </Field>
          <Field label="Status" htmlFor="res-status" required>
            <Select id="res-status" name="status" defaultValue="available">
              {["available", "maintenance", "unavailable"].map((value) => (
                <option key={value} value={value}>{titleCase(value)}</option>
              ))}
            </Select>
          </Field>
          <Field label="Capacity" htmlFor="res-capacity" required>
            <Input id="res-capacity" name="capacity" type="number" min={0.1} step="0.1" defaultValue={100} required />
          </Field>
          <Field label="Unit" htmlFor="res-unit" required>
            <Input id="res-unit" name="capacity_unit" defaultValue="kVA" required />
          </Field>
          <Field label="Hourly cost (USD)" htmlFor="res-cost">
            <Input id="res-cost" name="hourly_cost" type="number" min={0} defaultValue={180} />
          </Field>
          <Field label="Mobilisation (minutes)" htmlFor="res-mob">
            <Input id="res-mob" name="mobilisation_minutes" type="number" min={0} max={1440} defaultValue={30} />
          </Field>
          <div className="sm:col-span-2">
            <Field label="Notes" htmlFor="res-notes">
              <Textarea id="res-notes" name="notes" maxLength={1000} placeholder="Fuel contract, depot, maintenance window…" />
            </Field>
          </div>
        </form>
      </Modal>

      <Modal
        open={Boolean(reserving)}
        onClose={() => setReserving(null)}
        title={`Reserve ${reserving?.code ?? ""}`}
        description={
          reserving
            ? `${formatNumber(reserving.available_quantity)} ${reserving.capacity_unit} available of ${formatNumber(reserving.capacity)} ${reserving.capacity_unit}.`
            : undefined
        }
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setReserving(null)} disabled={busy}>Cancel</Button>
            <Button type="submit" form="reserve-form" loading={busy}>Hold capacity</Button>
          </>
        }
      >
        {error ? <Alert tone="danger">{error}</Alert> : null}
        <form
          id="reserve-form"
          className="mt-3 space-y-3"
          onSubmit={(event) => { event.preventDefault(); void reserveCapacity(event.currentTarget); }}
        >
          <Field label="Quantity" htmlFor="reserve-qty" required hint="Requests above the available quantity are rejected by the API.">
            <Input
              id="reserve-qty"
              name="quantity"
              type="number"
              min={0.1}
              max={reserving?.available_quantity ?? 1}
              step="0.1"
              defaultValue={reserving?.available_quantity ?? 1}
              required
            />
          </Field>
          <Alert tone="info">
            <CheckCircle2 className="mr-1 inline h-3 w-3" /> Reservations are idempotent and recorded in the audit log.
          </Alert>
        </form>
      </Modal>

      <ConfirmDialog
        open={Boolean(releasing)}
        title="Release this reservation?"
        message="The held capacity becomes available immediately and the release is recorded with a reason."
        confirmLabel="Release capacity"
        loading={busy}
        onCancel={() => setReleasing(null)}
        onConfirm={release}
      >
        <div className="mt-3 flex items-center gap-2 text-xs text-ink-400">
          <AlertTriangle className="h-3.5 w-3.5 text-amber" />
          Only release holds that are no longer needed operationally.
        </div>
      </ConfirmDialog>
    </>
  );
}
