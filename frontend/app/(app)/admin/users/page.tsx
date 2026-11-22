"use client";

/**
 * Screen 16 — User & Role Management (Super Admin only).
 *
 * The API enforces `user:manage` on every mutation; this screen renders the
 * controls only for callers who hold the permission and surfaces 403s verbatim.
 */

import { useEffect, useState } from "react";
import {
  AlertTriangle,
  KeyRound,
  Lock,
  Plus,
  RefreshCw,
  ShieldCheck,
  UserCog,
  UserPlus,
  Users,
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
  PanelHeader,
  SearchInput,
  Select,
  Tabs,
} from "@/components/ui";
import { api, errorMessage, qs } from "@/lib/api";
import { ROLE_LABELS, useAuth } from "@/lib/auth";
import { formatDateTime, initials, timeAgo } from "@/lib/format";
import { useAsync, useDebounced } from "@/lib/hooks";
import type { ListResponse, Meta, Role, User } from "@/lib/types";

interface RoleRow {
  id: number;
  key: string;
  name: string;
  description: string;
  is_system: boolean;
  user_count: number;
  permissions: string[];
}

interface PermissionRow {
  key: string;
  description: string;
}

const PAGE_SIZE = 10;

export default function UsersPage() {
  const { user: me, can } = useAuth();
  const [tab, setTab] = useState<"users" | "roles" | "permissions">("users");
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [roleFilter, setRoleFilter] = useState("");
  const [activeFilter, setActiveFilter] = useState("");
  const debounced = useDebounced(search);
  const [refreshKey, setRefreshKey] = useState(0);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<User | null>(null);
  const [resetting, setResetting] = useState<User | null>(null);
  const [deactivating, setDeactivating] = useState<User | null>(null);
  const [newPassword, setNewPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => setPage(1), [debounced, roleFilter, activeFilter]);

  const users = useAsync<{ rows: User[]; meta: Meta }>(
    async (signal) => {
      const response: ListResponse<User> = await api.list(
        `/users${qs({
          page,
          page_size: PAGE_SIZE,
          search: debounced,
          role: roleFilter,
          is_active: activeFilter === "" ? undefined : activeFilter,
          sort: "full_name",
        })}`,
        { signal },
      );
      return { rows: response.data, meta: response.meta };
    },
    [page, debounced, roleFilter, activeFilter, refreshKey],
  );

  const roles = useAsync<RoleRow[]>(() => api.get("/roles"), [refreshKey]);
  const permissions = useAsync<PermissionRow[]>(() => api.get("/permissions"), [refreshKey]);

  async function createUser(form: HTMLFormElement) {
    const data = new FormData(form);
    setBusy(true);
    setError(null);
    try {
      await api.post("/users", {
        full_name: String(data.get("full_name")),
        email: String(data.get("email")),
        password: String(data.get("password")),
        role: String(data.get("role")),
        job_title: String(data.get("job_title") || "") || null,
        phone: String(data.get("phone") || "") || null,
      });
      setCreating(false);
      setNotice("User created and notified in-app.");
      setRefreshKey((k) => k + 1);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function updateUser(form: HTMLFormElement) {
    if (!editing) return;
    const data = new FormData(form);
    setBusy(true);
    setError(null);
    try {
      await api.patch(`/users/${editing.id}`, {
        full_name: String(data.get("full_name")),
        role: String(data.get("role")),
        job_title: String(data.get("job_title") || "") || null,
      });
      setEditing(null);
      setNotice("User updated.");
      setRefreshKey((k) => k + 1);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function toggleActive(target: User) {
    setBusy(true);
    setError(null);
    try {
      await api.patch(`/users/${target.id}`, { is_active: !target.is_active });
      setNotice(`${target.full_name} ${target.is_active ? "deactivated" : "reactivated"}.`);
      setDeactivating(null);
      setRefreshKey((k) => k + 1);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function resetPassword() {
    if (!resetting) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.post<{ message: string }>(`/users/${resetting.id}/reset-password`, {
        new_password: newPassword,
      });
      setNotice(result.message);
      setResetting(null);
      setNewPassword("");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (!can("user:read")) {
    return (
      <>
        <PageHeader eyebrow="Governance" title="User & role management" />
        <Alert tone="danger" title="Administrator access required">
          This screen requires the <code className="font-mono text-xs">user:read</code> permission, which is held by
          Super Admins only. The server enforces this independently of what the interface shows.
        </Alert>
      </>
    );
  }

  return (
    <>
      <PageHeader
        eyebrow="Governance"
        title="User & role management"
        description="Accounts, role assignment and the permission matrix. The last active Super Admin cannot be deactivated or demoted, so the system can never lock itself out."
        actions={
          <>
            <Button variant="secondary" onClick={() => setRefreshKey((k) => k + 1)} loading={users.loading}>
              <RefreshCw className="h-4 w-4" aria-hidden /> Refresh
            </Button>
            {can("user:manage") ? (
              <Button onClick={() => { setError(null); setCreating(true); }}>
                <UserPlus className="h-4 w-4" aria-hidden /> Add user
              </Button>
            ) : null}
          </>
        }
      >
        <div className="mt-4 flex flex-wrap gap-2">
          <Badge tone="accent">{users.data?.meta.total ?? 0} accounts</Badge>
          {(roles.data ?? []).map((role) => (
            <Badge key={role.key}>
              {role.name}: {role.user_count}
            </Badge>
          ))}
        </div>
      </PageHeader>

      {error ? <Alert tone="danger" title="Action failed" action={<Button variant="ghost" size="sm" onClick={() => setError(null)}>Dismiss</Button>}>{error}</Alert> : null}
      {notice ? <Alert tone="success" action={<Button variant="ghost" size="sm" onClick={() => setNotice(null)}>Dismiss</Button>}>{notice}</Alert> : null}

      <Tabs
        value={tab}
        onChange={setTab}
        label="Administration sections"
        tabs={[
          { id: "users", label: "Users", count: users.data?.meta.total },
          { id: "roles", label: "Roles", count: roles.data?.length },
          { id: "permissions", label: "Permission matrix", count: permissions.data?.length },
        ]}
      />

      {tab === "users" ? (
        <Panel className="mt-4">
          <div className="mb-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <div className="lg:col-span-2">
              <SearchInput value={search} onChange={setSearch} placeholder="Search name or email…" label="Search users" />
            </div>
            <Select value={roleFilter} onChange={(event) => setRoleFilter(event.target.value)} aria-label="Filter by role">
              <option value="">All roles</option>
              {(roles.data ?? []).map((role) => (
                <option key={role.key} value={role.key}>{role.name}</option>
              ))}
            </Select>
            <Select value={activeFilter} onChange={(event) => setActiveFilter(event.target.value)} aria-label="Filter by status">
              <option value="">Any status</option>
              <option value="true">Active</option>
              <option value="false">Deactivated</option>
            </Select>
          </div>

          <DataTable
            rows={users.data?.rows ?? []}
            loading={users.loading}
            getKey={(row) => row.id}
            empty={<p className="py-10 text-center text-sm text-ink-400">No accounts match those filters.</p>}
            columns={[
              {
                key: "user",
                header: "Account",
                render: (row) => (
                  <div className="flex items-center gap-2">
                    <span
                      className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-[10px] font-bold text-navy-950"
                      style={{ backgroundColor: row.avatar_color }}
                      aria-hidden
                    >
                      {initials(row.full_name)}
                    </span>
                    <div>
                      <p className="text-xs font-medium text-white">
                        {row.full_name}
                        {row.id === me?.id ? <span className="ml-1 text-[10px] text-accent">(you)</span> : null}
                      </p>
                      <p className="text-[10px] text-ink-500">{row.email}</p>
                    </div>
                  </div>
                ),
              },
              {
                key: "role",
                header: "Role",
                render: (row) => (
                  <div className="flex flex-wrap gap-1">
                    {row.roles.map((role) => (
                      <Badge key={role.key} tone="accent">{role.name}</Badge>
                    ))}
                  </div>
                ),
              },
              {
                key: "status",
                header: "Status",
                render: (row) => (
                  <span className={row.is_active ? "text-xs text-mint" : "text-xs text-coral"}>
                    {row.is_active ? "active" : "deactivated"}
                  </span>
                ),
              },
              {
                key: "login",
                header: "Last sign-in",
                render: (row) => <span className="text-[11px] text-ink-500">{row.last_login_at ? timeAgo(row.last_login_at) : "never"}</span>,
              },
              {
                key: "created",
                header: "Created",
                render: (row) => <span className="text-[11px] text-ink-500">{formatDateTime(row.created_at)}</span>,
              },
              {
                key: "actions",
                header: "",
                className: "text-right",
                render: (row) =>
                  can("user:manage") ? (
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" size="sm" onClick={() => { setError(null); setEditing(row); }} aria-label={`Edit ${row.email}`}>
                        <UserCog className="h-3.5 w-3.5" />
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => { setError(null); setResetting(row); }} aria-label={`Reset password for ${row.email}`}>
                        <KeyRound className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setDeactivating(row)}
                        aria-label={`${row.is_active ? "Deactivate" : "Reactivate"} ${row.email}`}
                      >
                        <Lock className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  ) : null,
              },
            ]}
          />
          {users.data?.meta ? <Pagination meta={users.data.meta} onPage={setPage} /> : null}
        </Panel>
      ) : null}

      {tab === "roles" ? (
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          {(roles.data ?? []).map((role) => (
            <Panel key={role.id}>
              <PanelHeader
                title={ROLE_LABELS[role.key as Role] ?? role.name}
                subtitle={`${role.permissions.length} permissions · ${role.user_count} user(s)`}
                icon={<ShieldCheck className="h-4 w-4" />}
              />
              <p className="text-xs leading-relaxed text-ink-400">{role.description}</p>
              <ul className="mt-3 flex flex-wrap gap-1">
                {role.permissions.map((permission) => (
                  <li key={permission} className="rounded bg-white/5 px-1.5 py-0.5 font-mono text-[9px] text-ink-300">
                    {permission}
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-[10px] text-ink-500">
                {role.is_system ? "System role — permissions are fixed in code." : "Custom role."}
              </p>
            </Panel>
          ))}
        </div>
      ) : null}

      {tab === "permissions" ? (
        <Panel className="mt-4">
          <PanelHeader title="Permission catalogue" subtitle="Every guard the API evaluates" icon={<AlertTriangle className="h-4 w-4" />} />
          <DataTable
            rows={permissions.data ?? []}
            loading={permissions.loading}
            getKey={(row) => row.key}
            empty={<p className="py-8 text-center text-sm text-ink-400">No permissions loaded.</p>}
            columns={[
              { key: "key", header: "Permission", render: (row) => <code className="font-mono text-[11px] text-accent">{row.key}</code> },
              { key: "description", header: "Grants", render: (row) => <span className="text-xs text-ink-300">{row.description}</span> },
              {
                key: "roles",
                header: "Held by",
                render: (row) => (
                  <div className="flex flex-wrap gap-1">
                    {(roles.data ?? [])
                      .filter((role) => role.permissions.includes(row.key))
                      .map((role) => (
                        <Badge key={role.key}>{role.name}</Badge>
                      ))}
                  </div>
                ),
              },
            ]}
          />
        </Panel>
      ) : null}

      <Modal
        open={creating}
        onClose={() => setCreating(false)}
        title="Add a user"
        description="The account is created active, with the role you choose. Super Admin can only be granted here."
        footer={
          <>
            <Button variant="ghost" onClick={() => setCreating(false)} disabled={busy}>Cancel</Button>
            <Button type="submit" form="create-user" loading={busy}>Create user</Button>
          </>
        }
      >
        {error ? <Alert tone="danger">{error}</Alert> : null}
        <form
          id="create-user"
          className="mt-3 grid gap-3 sm:grid-cols-2"
          onSubmit={(event) => { event.preventDefault(); void createUser(event.currentTarget); }}
        >
          <Field label="Full name" htmlFor="new-name" required>
            <Input id="new-name" name="full_name" required minLength={2} maxLength={120} />
          </Field>
          <Field label="Email" htmlFor="new-email" required>
            <Input id="new-email" name="email" type="email" required />
          </Field>
          <Field label="Temporary password" htmlFor="new-password" hint="8+ chars, letters and numbers." required>
            <Input id="new-password" name="password" type="text" required minLength={8} />
          </Field>
          <Field label="Role" htmlFor="new-role" required>
            <Select id="new-role" name="role" defaultValue="city_operator" required>
              {(roles.data ?? []).map((role) => (
                <option key={role.key} value={role.key}>{role.name}</option>
              ))}
            </Select>
          </Field>
          <Field label="Job title" htmlFor="new-title">
            <Input id="new-title" name="job_title" maxLength={120} />
          </Field>
          <Field label="Phone" htmlFor="new-phone">
            <Input id="new-phone" name="phone" maxLength={40} />
          </Field>
        </form>
      </Modal>

      <Modal
        open={Boolean(editing)}
        onClose={() => setEditing(null)}
        title={`Edit ${editing?.full_name ?? ""}`}
        description="Role changes take effect on the user's next request; their session permissions are re-evaluated server-side."
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setEditing(null)} disabled={busy}>Cancel</Button>
            <Button type="submit" form="edit-user" loading={busy}>Save changes</Button>
          </>
        }
      >
        {error ? <Alert tone="danger">{error}</Alert> : null}
        {editing ? (
          <form
            id="edit-user"
            className="mt-3 space-y-3"
            onSubmit={(event) => { event.preventDefault(); void updateUser(event.currentTarget); }}
          >
            <Field label="Full name" htmlFor="edit-name" required>
              <Input id="edit-name" name="full_name" defaultValue={editing.full_name} required />
            </Field>
            <Field label="Email" htmlFor="edit-email">
              <Input id="edit-email" value={editing.email} readOnly disabled />
            </Field>
            <Field label="Role" htmlFor="edit-role" required>
              <Select id="edit-role" name="role" defaultValue={editing.roles[0]?.key ?? "city_operator"}>
                {(roles.data ?? []).map((role) => (
                  <option key={role.key} value={role.key}>{role.name}</option>
                ))}
              </Select>
            </Field>
            <Field label="Job title" htmlFor="edit-title">
              <Input id="edit-title" name="job_title" defaultValue={editing.job_title ?? ""} />
            </Field>
            {editing.id === me?.id ? (
              <Alert tone="warning">You are editing your own account. The last Super Admin cannot be demoted.</Alert>
            ) : null}
          </form>
        ) : null}
      </Modal>

      <Modal
        open={Boolean(resetting)}
        onClose={() => { setResetting(null); setNewPassword(""); }}
        title={`Reset password for ${resetting?.full_name ?? ""}`}
        description="All their sessions are signed out immediately. Share the new password through a secure channel."
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => { setResetting(null); setNewPassword(""); }} disabled={busy}>Cancel</Button>
            <Button onClick={resetPassword} loading={busy} disabled={newPassword.length < 8}>Reset password</Button>
          </>
        }
      >
        <Field label="New password" htmlFor="reset-pwd" required hint="Minimum 8 characters with letters and numbers.">
          <Input id="reset-pwd" type="text" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} />
        </Field>
        {error ? <Alert tone="danger">{error}</Alert> : null}
      </Modal>

      <ConfirmDialog
        open={Boolean(deactivating)}
        title={`${deactivating?.is_active ? "Deactivate" : "Reactivate"} ${deactivating?.full_name ?? ""}?`}
        message={
          deactivating?.is_active
            ? "Deactivation blocks sign-in and revokes their sessions, but preserves their audit history. The last active Super Admin cannot be deactivated."
            : "The account will be able to sign in again with its existing password."
        }
        confirmLabel={deactivating?.is_active ? "Deactivate" : "Reactivate"}
        destructive={deactivating?.is_active}
        loading={busy}
        onCancel={() => setDeactivating(null)}
        onConfirm={() => deactivating && toggleActive(deactivating)}
      />
    </>
  );
}
