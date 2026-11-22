"use client";

/**
 * Session context.
 *
 * The session itself lives in an httpOnly cookie issued by FastAPI; this
 * provider only mirrors the *current user + permissions* so the UI can hide
 * actions the backend would refuse anyway. It is a convenience layer, never a
 * security boundary.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { api, ApiError } from "./api";
import type { Role, User } from "./types";

interface MeResponse {
  user: User;
  permissions: string[];
  roles: string[];
}

interface AuthState {
  user: User | null;
  permissions: string[];
  roles: string[];
  loading: boolean;
  error: string | null;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
  can: (permission: string) => boolean;
  hasRole: (role: Role) => boolean;
  setUser: (user: User | null) => void;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [permissions, setPermissions] = useState<string[]>([]);
  const [roles, setRoles] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const me = await api.get<MeResponse>("/auth/me");
      setUser(me.user);
      setPermissions(me.permissions);
      setRoles(me.roles);
      setError(null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setUser(null);
        setPermissions([]);
        setRoles([]);
      } else {
        setError(err instanceof Error ? err.message : "Unable to verify your session.");
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const login = useCallback(
    async (email: string, password: string) => {
      await api.raw("/auth/login", { method: "POST", body: { email, password } });
      await refresh();
    },
    [refresh],
  );

  const logout = useCallback(async () => {
    try {
      await api.raw("/auth/logout", { method: "POST" });
    } finally {
      setUser(null);
      setPermissions([]);
      setRoles([]);
    }
  }, []);

  const value = useMemo<AuthState>(
    () => ({
      user,
      permissions,
      roles,
      loading,
      error,
      login,
      logout,
      refresh,
      can: (permission: string) => permissions.includes(permission),
      hasRole: (role: Role) => roles.includes(role),
      setUser,
    }),
    [user, permissions, roles, loading, error, login, logout, refresh],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}

export const ROLE_LABELS: Record<Role, string> = {
  super_admin: "Super Admin",
  city_operator: "City Operator",
  field_engineer: "Field Engineer",
  city_analyst: "City Analyst",
};

export const DEMO_ACCOUNTS: { role: Role; email: string; password: string; label: string }[] = [
  { role: "city_operator", email: "operator@symbiotic.city", password: "Operator#2026", label: "Watch Commander" },
  { role: "city_analyst", email: "analyst@symbiotic.city", password: "Analyst#2026", label: "Resilience Analyst" },
  { role: "field_engineer", email: "engineer@symbiotic.city", password: "Engineer#2026", label: "Grid Engineer" },
  { role: "super_admin", email: "admin@symbiotic.city", password: "Admin#2026", label: "Administrator" },
];
