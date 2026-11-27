"use client";

/**
 * Authenticated application shell.
 *
 * Matches the reference composition: fixed left sidebar with grouped navigation
 * and an active-state pill, top bar with page search, the LIVE DIGITAL TWIN
 * status pill, notification bell and the user chip. On small screens the
 * sidebar becomes an overlay drawer.
 */

import clsx from "clsx";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  BarChart3,
  Bell,
  Building2,
  ChevronDown,
  ClipboardList,
  Cpu,
  Gauge,
  History,
  LayoutDashboard,
  LogOut,
  Menu,
  Network,
  Search,
  Settings,
  ShieldCheck,
  Users,
  Workflow,
  X,
  Zap,
} from "lucide-react";
import { LiveTwinPill, Logo } from "@/components/ui/logo";
import { Spinner } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { ROLE_LABELS, useAuth } from "@/lib/auth";
import { initials, timeAgo } from "@/lib/format";
import type { Notification as AppNotification } from "@/lib/types";

interface NavItem {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  permission?: string;
  badge?: "notifications" | "tasks";
}

interface NavGroup {
  title: string;
  items: NavItem[];
}

const NAV: NavGroup[] = [
  {
    title: "Command",
    items: [
      { href: "/dashboard", label: "Main Dashboard", icon: LayoutDashboard },
      { href: "/twin", label: "Interactive 3D City", icon: Building2, permission: "twin:read" },
      { href: "/incidents", label: "Incident Management", icon: AlertTriangle, permission: "incident:read" },
      { href: "/notifications", label: "Notifications", icon: Bell, badge: "notifications" },
    ],
  },
  {
    title: "Infrastructure",
    items: [
      { href: "/infrastructure", label: "Infrastructure", icon: Network, permission: "infrastructure:read" },
      { href: "/simulation", label: "Failure Simulation Lab", icon: Cpu, permission: "simulation:read" },
      { href: "/optimization", label: "AI Optimisation", icon: Zap, permission: "optimization:read" },
      { href: "/resources", label: "Resource Management", icon: Gauge, permission: "resource:read" },
      { href: "/resilience", label: "Resilience Intelligence", icon: ShieldCheck, permission: "resilience:read" },
    ],
  },
  {
    title: "Response",
    items: [
      { href: "/tasks", label: "Repair Dispatch", icon: ClipboardList, permission: "task:read" },
      { href: "/my-tasks", label: "My Assigned Tasks", icon: ClipboardList, permission: "task:execute" },
      { href: "/workflows", label: "Recovery Workflows", icon: Workflow, permission: "workflow:read" },
      { href: "/analytics", label: "Analytics & Reports", icon: BarChart3, permission: "analytics:read" },
    ],
  },
  {
    title: "Governance",
    items: [
      { href: "/admin/users", label: "User & Role Management", icon: Users, permission: "user:read" },
      { href: "/admin/audit", label: "System Audit Logs", icon: ShieldCheck, permission: "audit:read" },
      { href: "/admin/settings", label: "System Settings", icon: Settings, permission: "settings:manage" },
      { href: "/profile", label: "Profile & Settings", icon: Activity },
    ],
  },
];

function isActive(pathname: string, href: string): boolean {
  if (href === "/dashboard") return pathname === href;
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const { user, permissions, loading, logout } = useAuth();
  const pathname = usePathname();
  const router = useRouter();
  const [navOpen, setNavOpen] = useState(false);
  const [userMenu, setUserMenu] = useState(false);
  const [bellOpen, setBellOpen] = useState(false);
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [unread, setUnread] = useState(0);
  const [search, setSearch] = useState("");

  useEffect(() => {
    if (!loading && !user) {
      router.replace(`/login?next=${encodeURIComponent(pathname)}`);
    }
  }, [loading, user, router, pathname]);

  useEffect(() => {
    setNavOpen(false);
    setUserMenu(false);
    setBellOpen(false);
  }, [pathname]);

  const loadNotifications = useMemo(
    () => async () => {
      if (!user) return;
      try {
        const response = await api.list<AppNotification>("/notifications?page_size=6");
        setNotifications(response.data);
        setUnread(response.unread_count ?? response.data.filter((n) => !n.is_read).length);
      } catch {
        /* silent: the bell is non-critical chrome */
      }
    },
    [user],
  );

  useEffect(() => {
    void loadNotifications();
    const timer = window.setInterval(() => void loadNotifications(), 45_000);
    return () => window.clearInterval(timer);
  }, [loadNotifications]);

  const groups = useMemo(
    () =>
      NAV.map((group) => ({
        ...group,
        items: group.items.filter((item) => !item.permission || permissions.includes(item.permission)),
      })).filter((group) => group.items.length > 0),
    [permissions],
  );

  const matches = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return [];
    return groups
      .flatMap((group) => group.items)
      .filter((item) => item.label.toLowerCase().includes(needle))
      .slice(0, 6);
  }, [search, groups]);

  if (loading) {
    return (
      <div className="grid min-h-screen place-items-center">
        <div className="glass flex items-center gap-3 px-5 py-4">
          <Spinner label="Restoring your session…" />
        </div>
      </div>
    );
  }

  if (!user) return null;

  const primaryRole = user.roles[0]?.key;

  return (
    <div className="min-h-screen lg:flex">
      {/* mobile overlay */}
      {navOpen ? (
        <button
          className="fixed inset-0 z-30 bg-navy-950/70 backdrop-blur-sm lg:hidden"
          onClick={() => setNavOpen(false)}
          aria-label="Close navigation"
        />
      ) : null}

      <aside
        className={clsx(
          "fixed inset-y-0 left-0 z-40 flex w-[272px] flex-col border-r border-white/10 bg-navy-900/80 backdrop-blur-xl transition-transform lg:sticky lg:top-0 lg:h-screen lg:translate-x-0",
          navOpen ? "translate-x-0" : "-translate-x-full",
        )}
        aria-label="Primary navigation"
      >
        <div className="flex items-center justify-between px-4 py-4">
          <Logo size="sm" href="/dashboard" />
          <button
            className="rounded-lg p-1.5 text-ink-400 hover:bg-white/10 hover:text-white lg:hidden"
            onClick={() => setNavOpen(false)}
            aria-label="Close navigation"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <nav className="flex-1 overflow-y-auto px-3 pb-4 scrollbar-slim">
          {groups.map((group) => (
            <div key={group.title} className="mb-4">
              <p className="mb-1.5 px-3 text-[10px] font-semibold uppercase tracking-[0.2em] text-ink-500">
                {group.title}
              </p>
              <ul className="space-y-0.5">
                {group.items.map((item) => {
                  const active = isActive(pathname, item.href);
                  return (
                    <li key={item.href}>
                      <Link
                        href={item.href}
                        aria-current={active ? "page" : undefined}
                        className={clsx("nav-item", active && "nav-item-active")}
                      >
                        <item.icon className={clsx("h-4 w-4", active ? "text-accent" : "text-ink-500")} />
                        <span className="flex-1">{item.label}</span>
                        {item.badge === "notifications" && unread > 0 ? (
                          <span className="rounded-full bg-coral px-1.5 py-0.5 text-[10px] font-bold text-white">
                            {unread > 9 ? "9+" : unread}
                          </span>
                        ) : null}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </nav>

        <div className="border-t border-white/10 p-3">
          <div className="rounded-xl border border-white/10 bg-white/[0.03] p-3">
            <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-ink-500">Synthetic data</p>
            <p className="mt-1 text-[11px] leading-relaxed text-ink-400">
              Aurora Vale is fictional. No live infrastructure is connected to this platform.
            </p>
          </div>
          <Link
            href="/docs"
            className="mt-2 flex items-center justify-between rounded-xl px-3 py-2 text-xs text-ink-400 hover:bg-white/5 hover:text-white"
          >
            <span className="inline-flex items-center gap-2">
              <History className="h-3.5 w-3.5" /> Methodology & docs
            </span>
            <ChevronDown className="h-3.5 w-3.5 -rotate-90" />
          </Link>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 border-b border-white/10 bg-navy-950/75 backdrop-blur-xl">
          <div className="flex items-center gap-3 px-4 py-3 lg:px-6">
            <button
              className="rounded-lg p-2 text-ink-300 hover:bg-white/10 hover:text-white lg:hidden"
              onClick={() => setNavOpen(true)}
              aria-label="Open navigation"
              aria-expanded={navOpen}
            >
              <Menu className="h-5 w-5" />
            </button>

            <div className="relative hidden max-w-sm flex-1 sm:block">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-500" />
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Jump to a screen…"
                aria-label="Search navigation"
                className="input py-2 pl-9 text-xs"
              />
              {matches.length > 0 ? (
                <ul className="absolute left-0 right-0 top-full z-30 mt-1 overflow-hidden rounded-xl border border-white/10 bg-navy-900/98 shadow-glass">
                  {matches.map((match) => (
                    <li key={match.href}>
                      <Link
                        href={match.href}
                        onClick={() => setSearch("")}
                        className="flex items-center gap-2 px-3 py-2 text-xs text-ink-200 hover:bg-white/5 hover:text-white"
                      >
                        <match.icon className="h-3.5 w-3.5 text-accent" /> {match.label}
                      </Link>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>

            <div className="ml-auto flex items-center gap-2">
              <div className="hidden md:block">
                <LiveTwinPill />
              </div>

              <div className="relative">
                <button
                  onClick={() => setBellOpen((v) => !v)}
                  aria-label={`Notifications${unread ? `, ${unread} unread` : ""}`}
                  aria-expanded={bellOpen}
                  className="relative rounded-xl p-2 text-ink-300 transition hover:bg-white/10 hover:text-white"
                >
                  <Bell className="h-5 w-5" />
                  {unread > 0 ? (
                    <span className="absolute right-1 top-1 grid h-4 min-w-4 place-items-center rounded-full bg-coral px-1 text-[9px] font-bold text-white">
                      {unread > 9 ? "9+" : unread}
                    </span>
                  ) : null}
                </button>
                {bellOpen ? (
                  <div className="fixed left-4 right-4 top-16 z-30 max-h-[min(70dvh,24rem)] overflow-y-auto rounded-xl border border-white/10 bg-navy-900/98 shadow-glass sm:absolute sm:left-auto sm:right-0 sm:top-full sm:mt-2 sm:w-80">
                    <div className="flex items-center justify-between border-b border-white/10 px-3 py-2">
                      <p className="text-xs font-semibold uppercase tracking-[0.14em] text-ink-400">Notifications</p>
                      <Link href="/notifications" className="text-[11px] text-accent hover:underline">
                        View all
                      </Link>
                    </div>
                    <ul className="max-h-80 overflow-y-auto">
                      {notifications.length === 0 ? (
                        <li className="px-3 py-6 text-center text-xs text-ink-500">No notifications yet.</li>
                      ) : (
                        notifications.map((note) => (
                          <li key={note.id} className="border-b border-white/5 last:border-0">
                            <Link
                              href={note.link ?? "/notifications"}
                              className="block px-3 py-2.5 hover:bg-white/5"
                              onClick={() => setBellOpen(false)}
                            >
                              <p className={clsx("text-xs", note.is_read ? "text-ink-300" : "font-semibold text-white")}>
                                {note.title}
                              </p>
                              <p className="mt-0.5 line-clamp-2 text-[11px] text-ink-500">{note.body}</p>
                              <p className="mt-1 text-[10px] text-ink-600">{timeAgo(note.created_at)}</p>
                            </Link>
                          </li>
                        ))
                      )}
                    </ul>
                  </div>
                ) : null}
              </div>

              <div className="relative">
                <button
                  onClick={() => setUserMenu((v) => !v)}
                  className="flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 py-1.5 pl-1.5 pr-2.5 text-left transition hover:border-accent/30 hover:bg-white/10"
                  aria-expanded={userMenu}
                  aria-haspopup="menu"
                >
                  <span
                    className="grid h-7 w-7 place-items-center rounded-lg text-[11px] font-bold text-navy-950"
                    style={{ backgroundColor: user.avatar_color }}
                    aria-hidden
                  >
                    {initials(user.full_name)}
                  </span>
                  <span className="hidden sm:block">
                    <span className="block text-xs font-semibold leading-tight text-white">{user.full_name}</span>
                    <span className="block text-[10px] leading-tight text-ink-500">
                      {primaryRole ? ROLE_LABELS[primaryRole as keyof typeof ROLE_LABELS] : "Member"}
                    </span>
                  </span>
                  <ChevronDown className="h-3.5 w-3.5 text-ink-500" />
                </button>
                {userMenu ? (
                  <div
                    role="menu"
                    className="absolute right-0 top-full z-30 mt-2 w-56 overflow-hidden rounded-xl border border-white/10 bg-navy-900/98 shadow-glass"
                  >
                    <div className="border-b border-white/10 px-3 py-2">
                      <p className="truncate text-xs font-semibold text-white">{user.email}</p>
                      <p className="text-[10px] uppercase tracking-[0.14em] text-ink-500">
                        {user.roles.map((role) => role.name).join(", ")}
                      </p>
                    </div>
                    <Link href="/profile" role="menuitem" className="flex items-center gap-2 px-3 py-2 text-xs text-ink-200 hover:bg-white/5">
                      <Settings className="h-3.5 w-3.5" /> Profile & settings
                    </Link>
                    <Link href="/notifications" role="menuitem" className="flex items-center gap-2 px-3 py-2 text-xs text-ink-200 hover:bg-white/5">
                      <Bell className="h-3.5 w-3.5" /> Notifications
                    </Link>
                    <button
                      role="menuitem"
                      onClick={async () => {
                        await logout();
                        router.replace("/login");
                      }}
                      className="flex w-full items-center gap-2 border-t border-white/10 px-3 py-2 text-left text-xs text-coral hover:bg-coral/10"
                    >
                      <LogOut className="h-3.5 w-3.5" /> Sign out
                    </button>
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        </header>

        <main id="main" className="min-w-0 flex-1 px-4 py-6 lg:px-6 lg:py-8">
          {children}
        </main>

        <footer className="border-t border-white/10 px-4 py-4 text-[11px] text-ink-600 lg:px-6">
          SYMBIOTIC CITY · Self-Healing Urban Intelligence · synthetic Aurora Vale dataset · results are decision
          support for the exercise, not validated predictions.
        </footer>
      </div>
    </div>
  );
}
