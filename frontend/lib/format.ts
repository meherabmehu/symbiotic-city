/** Formatting helpers shared across the app. */

export function formatNumber(value: number | null | undefined, digits = 0): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
}

export function formatCompact(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(date);
}

export function timeAgo(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  const seconds = Math.round((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.round(days / 30);
  return `${months}mo ago`;
}

export function titleCase(value: string | null | undefined): string {
  if (!value) return "—";
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function initials(name: string): string {
  return name
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

export function percent(value: number, digits = 1): string {
  return `${value.toFixed(digits)}%`;
}

export const STATUS_STYLES: Record<string, string> = {
  operational: "bg-mint/10 text-mint border border-mint/30",
  degraded: "bg-amber/10 text-amber border border-amber/30",
  offline: "bg-coral/10 text-coral border border-coral/30",
  maintenance: "bg-accent/10 text-accent border border-accent/30",
  archived: "bg-white/5 text-ink-400 border border-white/10",
};

export const SEVERITY_STYLES: Record<string, string> = {
  critical: "bg-coral/15 text-coral border border-coral/40",
  high: "bg-amber/15 text-amber border border-amber/40",
  medium: "bg-accent/15 text-accent border border-accent/40",
  low: "bg-mint/15 text-mint border border-mint/40",
};

export const INCIDENT_STATUS_STYLES: Record<string, string> = {
  reported: "bg-amber/10 text-amber border border-amber/30",
  verified: "bg-accent/10 text-accent border border-accent/30",
  planning: "bg-indigo-400/10 text-indigo-300 border border-indigo-400/30",
  approved: "bg-mint/10 text-mint border border-mint/30",
  in_progress: "bg-sky-400/10 text-sky-300 border border-sky-400/30",
  resolved: "bg-mint/15 text-mint border border-mint/40",
  cancelled: "bg-white/5 text-ink-400 border border-white/10",
};

export const TASK_STATUS_STYLES: Record<string, string> = {
  pending: "bg-white/5 text-ink-300 border border-white/10",
  assigned: "bg-amber/10 text-amber border border-amber/30",
  accepted: "bg-accent/10 text-accent border border-accent/30",
  rejected: "bg-coral/10 text-coral border border-coral/30",
  in_progress: "bg-sky-400/10 text-sky-300 border border-sky-400/30",
  completed: "bg-mint/10 text-mint border border-mint/30",
  verified: "bg-mint/15 text-mint border border-mint/40",
  cancelled: "bg-white/5 text-ink-400 border border-white/10",
};

export const WORKFLOW_STATUS_STYLES: Record<string, string> = {
  running: "bg-accent/10 text-accent border border-accent/30",
  awaiting_approval: "bg-amber/10 text-amber border border-amber/30",
  awaiting_field: "bg-sky-400/10 text-sky-300 border border-sky-400/30",
  failed: "bg-coral/10 text-coral border border-coral/30",
  completed: "bg-mint/15 text-mint border border-mint/40",
};

export const CATEGORY_ICON_KEY: Record<string, string> = {
  power_station: "zap",
  substation: "plug-zap",
  hospital: "heart-pulse",
  water_pump: "droplets",
  water_treatment: "waves",
  school: "graduation-cap",
  residential: "home",
  commercial: "building-2",
  telecom: "radio",
};
