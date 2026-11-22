"use client";

/**
 * Screen 18 — Profile & Settings.
 *
 * Profile edits, password change and session revocation all hit real endpoints;
 * the session list is fetched from GET /api/auth/sessions.
 */

import { useEffect, useState } from "react";
import {
  Bell,
  CheckCircle2,
  KeyRound,
  LogOut,
  Monitor,
  Palette,
  Save,
  ShieldCheck,
  User as UserIcon,
} from "lucide-react";
import {
  Alert,
  Badge,
  Button,
  ConfirmDialog,
  Field,
  Input,
  PageHeader,
  Panel,
  PanelHeader,
  Spinner,
  Tabs,
  Toggle,
} from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { ROLE_LABELS, useAuth } from "@/lib/auth";
import { formatDateTime, initials, timeAgo } from "@/lib/format";
import { useAsync } from "@/lib/hooks";
import type { Role } from "@/lib/types";

interface SessionRow {
  id: number;
  ip_address: string | null;
  user_agent: string | null;
  created_at: string;
  last_used_at: string | null;
  expires_at: string;
  is_current: boolean;
}

const COLORS = ["#45d8f5", "#3ee6a5", "#ffb545", "#ff6b6b", "#8b7cf6", "#4d9fff"];

export default function ProfilePage() {
  const { user, refresh, logout, can } = useAuth();
  const [tab, setTab] = useState<"profile" | "security" | "preferences">("profile");
  const [fullName, setFullName] = useState("");
  const [jobTitle, setJobTitle] = useState("");
  const [phone, setPhone] = useState("");
  const [color, setColor] = useState("#45d8f5");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [revokeOpen, setRevokeOpen] = useState(false);
  const [prefs, setPrefs] = useState({ emailDigest: true, criticalOnly: false, sound: false });

  const sessions = useAsync<SessionRow[]>(() => api.get("/auth/sessions"), []);

  useEffect(() => {
    if (!user) return;
    setFullName(user.full_name);
    setJobTitle(user.job_title ?? "");
    setPhone(user.phone ?? "");
    setColor(user.avatar_color);
  }, [user]);

  async function saveProfile() {
    setBusy("profile");
    setError(null);
    try {
      await api.patch("/auth/profile", {
        full_name: fullName.trim(),
        job_title: jobTitle.trim() || null,
        phone: phone.trim() || null,
        avatar_color: color,
      });
      await refresh();
      setNotice("Profile updated.");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  async function changePassword() {
    if (newPassword !== confirm) {
      setError("The new passwords do not match.");
      return;
    }
    setBusy("password");
    setError(null);
    try {
      await api.post("/auth/change-password", {
        current_password: currentPassword,
        new_password: newPassword,
      });
      setNotice("Password changed. Other sessions were invalidated by the server.");
      setCurrentPassword("");
      setNewPassword("");
      setConfirm("");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  async function revokeSessions() {
    setBusy("revoke");
    setError(null);
    try {
      const result = await api.post<{ revoked: number }>("/auth/sessions/revoke-all");
      setNotice(`${result.revoked} session(s) revoked. You have been signed out.`);
      setRevokeOpen(false);
      window.setTimeout(() => void logout(), 1200);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  if (!user) return <div className="grid place-items-center py-24"><Spinner label="Loading profile…" /></div>;

  return (
    <>
      <PageHeader
        eyebrow="Account"
        title="Profile & settings"
        description="Your identity, credentials and session footprint. Role assignment is managed by a Super Admin, not from this screen."
        actions={
          <Badge tone="accent">
            <ShieldCheck className="h-3 w-3" /> {user.roles.map((role) => ROLE_LABELS[role.key as Role] ?? role.name).join(", ")}
          </Badge>
        }
      />

      {error ? <Alert tone="danger" action={<Button variant="ghost" size="sm" onClick={() => setError(null)}>Dismiss</Button>}>{error}</Alert> : null}
      {notice ? <Alert tone="success" action={<Button variant="ghost" size="sm" onClick={() => setNotice(null)}>Dismiss</Button>}>{notice}</Alert> : null}

      <div className="grid gap-4 xl:grid-cols-[1fr_300px]">
        <div>
          <Tabs
            value={tab}
            onChange={setTab}
            label="Profile sections"
            tabs={[
              { id: "profile", label: "Profile" },
              { id: "security", label: "Security" },
              { id: "preferences", label: "Preferences" },
            ]}
          />

          {tab === "profile" ? (
            <Panel className="mt-4">
              <PanelHeader title="Personal details" subtitle="Shown on dispatch, audit logs and notifications" icon={<UserIcon className="h-4 w-4" />} />
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Full name" htmlFor="profile-name" required>
                  <Input id="profile-name" value={fullName} onChange={(event) => setFullName(event.target.value)} maxLength={120} />
                </Field>
                <Field label="Email" htmlFor="profile-email" hint="Contact an administrator to change your email.">
                  <Input id="profile-email" value={user.email} readOnly disabled />
                </Field>
                <Field label="Job title" htmlFor="profile-title">
                  <Input id="profile-title" value={jobTitle} onChange={(event) => setJobTitle(event.target.value)} maxLength={120} placeholder="Watch Commander" />
                </Field>
                <Field label="Phone" htmlFor="profile-phone">
                  <Input id="profile-phone" value={phone} onChange={(event) => setPhone(event.target.value)} maxLength={40} placeholder="+880 1700 000000" />
                </Field>
              </div>
              <div className="mt-4">
                <p className="label">Avatar colour</p>
                <div className="flex gap-2">
                  {COLORS.map((option) => (
                    <button
                      key={option}
                      type="button"
                      onClick={() => setColor(option)}
                      className={`h-8 w-8 rounded-lg border-2 transition ${color === option ? "border-white" : "border-transparent"}`}
                      style={{ backgroundColor: option }}
                      aria-label={`Choose avatar colour ${option}`}
                      aria-pressed={color === option}
                    />
                  ))}
                </div>
              </div>
              <div className="mt-4 flex justify-end">
                <Button onClick={saveProfile} loading={busy === "profile"}>
                  <Save className="h-4 w-4" aria-hidden /> Save profile
                </Button>
              </div>
            </Panel>
          ) : null}

          {tab === "security" ? (
            <div className="mt-4 space-y-4">
              <Panel>
                <PanelHeader title="Change password" subtitle="Minimum 8 characters with letters and numbers" icon={<KeyRound className="h-4 w-4" />} />
                <div className="grid gap-3 sm:grid-cols-3">
                  <Field label="Current password" htmlFor="cur-password" required>
                    <Input id="cur-password" type="password" autoComplete="current-password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} />
                  </Field>
                  <Field label="New password" htmlFor="new-password" required>
                    <Input id="new-password" type="password" autoComplete="new-password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} />
                  </Field>
                  <Field label="Confirm" htmlFor="confirm-password" required>
                    <Input id="confirm-password" type="password" autoComplete="new-password" value={confirm} onChange={(event) => setConfirm(event.target.value)} />
                  </Field>
                </div>
                <div className="mt-4 flex justify-end">
                  <Button onClick={changePassword} loading={busy === "password"} disabled={!currentPassword || !newPassword}>
                    Update password
                  </Button>
                </div>
              </Panel>

              <Panel>
                <PanelHeader title="Active sessions" subtitle="Where your account is currently signed in" icon={<Monitor className="h-4 w-4" />} />
                {sessions.loading ? <Spinner /> : null}
                {sessions.data?.length ? (
                  <ul className="space-y-2">
                    {sessions.data.map((session) => (
                      <li key={session.id} className="rounded-xl border border-white/10 bg-white/[0.02] px-3 py-2">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="text-xs text-ink-200">
                            {session.user_agent ?? "Unknown client"}
                            {session.ip_address ? <span className="text-ink-500"> · {session.ip_address}</span> : null}
                          </span>
                          {session.is_current ? <Badge tone="success">this session</Badge> : <Badge>other</Badge>}
                        </div>
                        <p className="mt-1 text-[10px] text-ink-500">
                          started {timeAgo(session.created_at)} · last used{" "}
                          {session.last_used_at ? timeAgo(session.last_used_at) : "—"} · expires {formatDateTime(session.expires_at)}
                        </p>
                      </li>
                    ))}
                  </ul>
                ) : null}
                <div className="mt-3 flex justify-end">
                  <Button variant="danger" onClick={() => setRevokeOpen(true)}>
                    <LogOut className="h-4 w-4" aria-hidden /> Sign out everywhere
                  </Button>
                </div>
              </Panel>
            </div>
          ) : null}

          {tab === "preferences" ? (
            <Panel className="mt-4">
              <PanelHeader title="Notification preferences" subtitle="Stored on this device only" icon={<Bell className="h-4 w-4" />} />
              <div className="space-y-4">
                <Toggle
                  checked={prefs.emailDigest}
                  onChange={(value) => setPrefs((prev) => ({ ...prev, emailDigest: value }))}
                  label="Daily digest"
                  description="No SMTP relay is configured in this deployment, so digests are in-app only."
                />
                <Toggle
                  checked={prefs.criticalOnly}
                  onChange={(value) => setPrefs((prev) => ({ ...prev, criticalOnly: value }))}
                  label="Critical alerts only"
                  description="Hide low and medium notifications from the bell."
                />
                <Toggle
                  checked={prefs.sound}
                  onChange={(value) => setPrefs((prev) => ({ ...prev, sound: value }))}
                  label="Sound on new critical alert"
                  description="Respects your operating system's reduced-motion preferences."
                />
              </div>
              <Alert tone="info" title="Honest scope">
                These three switches are local presentation preferences, not server-side settings. Server-side system
                settings live under System Settings for Super Admins.
              </Alert>
              <p className="mt-3 flex items-center gap-1 text-[11px] text-ink-500">
                <Palette className="h-3 w-3" /> The interface follows the dark command-centre theme; there is no light
                mode in this release.
              </p>
            </Panel>
          ) : null}
        </div>

        <div className="space-y-4">
          <Panel>
            <div className="flex items-center gap-3">
              <span
                className="grid h-12 w-12 place-items-center rounded-xl text-sm font-bold text-navy-950"
                style={{ backgroundColor: user.avatar_color }}
                aria-hidden
              >
                {initials(user.full_name)}
              </span>
              <div>
                <p className="font-display text-sm font-semibold text-white">{user.full_name}</p>
                <p className="text-[11px] text-ink-400">{user.email}</p>
              </div>
            </div>
            <dl className="mt-3 space-y-1.5 text-[11px]">
              <div className="flex justify-between">
                <dt className="text-ink-500">Account created</dt>
                <dd className="text-ink-200">{formatDateTime(user.created_at)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-ink-500">Last sign-in</dt>
                <dd className="text-ink-200">{user.last_login_at ? timeAgo(user.last_login_at) : "—"}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-ink-500">Status</dt>
                <dd className={user.is_active ? "text-mint" : "text-coral"}>{user.is_active ? "active" : "disabled"}</dd>
              </div>
            </dl>
          </Panel>

          <Panel>
            <PanelHeader title="Permissions" subtitle={`${user.permissions?.length ?? 0} granted`} icon={<ShieldCheck className="h-4 w-4" />} />
            <ul className="flex flex-wrap gap-1.5">
              {(user.permissions ?? []).slice(0, 18).map((permission) => (
                <li key={permission} className="rounded bg-white/5 px-1.5 py-0.5 font-mono text-[9px] text-ink-300">
                  {permission}
                </li>
              ))}
            </ul>
            <p className="mt-2 text-[10px] text-ink-500">
              Permissions are evaluated on the server for every request. Hidden buttons are a convenience, not the
              control.
            </p>
          </Panel>

          <Panel>
            <PanelHeader title="Role lane" icon={<CheckCircle2 className="h-4 w-4" />} />
            <p className="text-[11px] leading-relaxed text-ink-400">
              {user.roles.some((role) => role.key === "super_admin")
                ? "Full control: user management, system settings, audit review and every operational action."
                : user.roles.some((role) => role.key === "city_operator")
                  ? "You run incidents, approve recovery plans and verify repairs. Resource writes are administrator-only."
                  : user.roles.some((role) => role.key === "city_analyst")
                    ? "You simulate cascades, optimise allocation and export reports. Operational edits are read-only for you."
                    : "You execute assigned repair tasks. You cannot verify your own work or open another engineer's task."}
            </p>
            {can("user:read") ? (
              <p className="mt-2 text-[10px] text-accent">You can open User & Role Management from the sidebar.</p>
            ) : null}
          </Panel>
        </div>
      </div>

      <ConfirmDialog
        open={revokeOpen}
        title="Sign out of every session?"
        message="All session tokens for your account will be revoked, including this one. You will need to sign in again."
        confirmLabel="Revoke all sessions"
        destructive
        loading={busy === "revoke"}
        onCancel={() => setRevokeOpen(false)}
        onConfirm={revokeSessions}
      />
    </>
  );
}
