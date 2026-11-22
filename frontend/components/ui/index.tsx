"use client";

/**
 * Shared UI primitives implementing the SYMBIOTIC CITY design language:
 * glass panels, hairline borders, cyan focus rings, semantic status pills.
 * All primitives are keyboard accessible and announce state changes.
 */

import clsx from "clsx";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  Info,
  Loader2,
  Search,
  X,
  XCircle,
} from "lucide-react";
import Link from "next/link";
import {
  createContext,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";

/* -------------------------------------------------------------------------- */
/* layout                                                                      */
/* -------------------------------------------------------------------------- */

export function Panel({
  children,
  className,
  as: Tag = "section",
  ...rest
}: {
  children: ReactNode;
  className?: string;
  as?: "section" | "div" | "article" | "aside";
} & React.HTMLAttributes<HTMLElement>) {
  return (
    <Tag className={clsx("glass p-5", className)} {...rest}>
      {children}
    </Tag>
  );
}

export function PanelHeader({
  title,
  subtitle,
  action,
  icon,
}: {
  title: string;
  subtitle?: string;
  action?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="mb-4 flex items-start justify-between gap-4">
      <div className="flex items-start gap-3">
        {icon ? (
          <span className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-xl border border-white/10 bg-white/5 text-accent">
            {icon}
          </span>
        ) : null}
        <div>
          <h2 className="font-display text-base font-semibold text-white">{title}</h2>
          {subtitle ? <p className="mt-0.5 text-xs text-ink-400">{subtitle}</p> : null}
        </div>
      </div>
      {action}
    </div>
  );
}

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
  children,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <header className="mb-6 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
      <div>
        {eyebrow ? (
          <p className="mb-1 font-display text-[11px] font-semibold uppercase tracking-[0.22em] text-accent">
            {eyebrow}
          </p>
        ) : null}
        <h1 className="text-balance font-display text-2xl font-semibold tracking-tight text-white lg:text-3xl">
          {title}
        </h1>
        {description ? <p className="mt-2 max-w-2xl text-sm text-ink-400">{description}</p> : null}
        {children}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}

/* -------------------------------------------------------------------------- */
/* feedback                                                                    */
/* -------------------------------------------------------------------------- */

export function Badge({
  children,
  className,
  tone = "neutral",
}: {
  children: ReactNode;
  className?: string;
  tone?: "neutral" | "accent" | "success" | "warning" | "danger";
}) {
  const tones = {
    neutral: "bg-white/5 text-ink-200 border border-white/10",
    accent: "bg-accent/10 text-accent border border-accent/30",
    success: "bg-mint/10 text-mint border border-mint/30",
    warning: "bg-amber/10 text-amber border border-amber/30",
    danger: "bg-coral/10 text-coral border border-coral/30",
  };
  return <span className={clsx("badge", tones[tone], className)}>{children}</span>;
}

export function StatusPill({ status, className }: { status: string; className?: string }) {
  return (
    <span className={clsx("badge", STATUS_TONE[status] ?? STATUS_TONE.neutral, className)}>
      <span className={clsx("h-1.5 w-1.5 rounded-full", STATUS_DOT[status] ?? "bg-ink-400")} />
      {status.replace(/_/g, " ")}
    </span>
  );
}

const STATUS_TONE: Record<string, string> = {
  operational: "bg-mint/10 text-mint border border-mint/30",
  degraded: "bg-amber/10 text-amber border border-amber/30",
  offline: "bg-coral/10 text-coral border border-coral/30",
  maintenance: "bg-accent/10 text-accent border border-accent/30",
  archived: "bg-white/5 text-ink-400 border border-white/10",
  neutral: "bg-white/5 text-ink-300 border border-white/10",
  reported: "bg-amber/10 text-amber border border-amber/30",
  verified: "bg-accent/10 text-accent border border-accent/30",
  planning: "bg-indigo-400/10 text-indigo-300 border border-indigo-400/30",
  approved: "bg-mint/10 text-mint border border-mint/30",
  in_progress: "bg-sky-400/10 text-sky-300 border border-sky-400/30",
  resolved: "bg-mint/15 text-mint border border-mint/40",
  cancelled: "bg-white/5 text-ink-400 border border-white/10",
  pending: "bg-white/5 text-ink-300 border border-white/10",
  assigned: "bg-amber/10 text-amber border border-amber/30",
  accepted: "bg-accent/10 text-accent border border-accent/30",
  rejected: "bg-coral/10 text-coral border border-coral/30",
  completed: "bg-mint/10 text-mint border border-mint/30",
  failed: "bg-coral/10 text-coral border border-coral/30",
  running: "bg-accent/10 text-accent border border-accent/30",
  awaiting_approval: "bg-amber/10 text-amber border border-amber/30",
  awaiting_field: "bg-sky-400/10 text-sky-300 border border-sky-400/30",
  optimal: "bg-mint/15 text-mint border border-mint/40",
  feasible: "bg-accent/10 text-accent border border-accent/30",
  infeasible: "bg-coral/10 text-coral border border-coral/30",
  proposed: "bg-amber/10 text-amber border border-amber/30",
  reserved: "bg-accent/10 text-accent border border-accent/30",
  released: "bg-white/5 text-ink-400 border border-white/10",
  consumed: "bg-mint/10 text-mint border border-mint/30",
  rolled_back: "bg-coral/10 text-coral border border-coral/30",
  success: "bg-mint/10 text-mint border border-mint/30",
  failure: "bg-coral/10 text-coral border border-coral/30",
};

const STATUS_DOT: Record<string, string> = {
  operational: "bg-mint",
  degraded: "bg-amber",
  offline: "bg-coral",
  maintenance: "bg-accent",
  failed: "bg-coral",
  resolved: "bg-mint",
  verified: "bg-mint",
  completed: "bg-mint",
  optimal: "bg-mint",
  success: "bg-mint",
  in_progress: "bg-sky-300",
  running: "bg-accent",
  pending: "bg-ink-400",
};

export function SeverityBadge({ severity }: { severity: string }) {
  const tone =
    severity === "critical"
      ? "bg-coral/15 text-coral border border-coral/40"
      : severity === "high"
        ? "bg-amber/15 text-amber border border-amber/40"
        : severity === "medium"
          ? "bg-accent/15 text-accent border border-accent/40"
          : "bg-mint/15 text-mint border border-mint/40";
  return <span className={clsx("badge", tone)}>{severity}</span>;
}

export function PriorityChip({ priority }: { priority: number }) {
  const tone =
    priority <= 1
      ? "border-coral/40 bg-coral/10 text-coral"
      : priority === 2
        ? "border-amber/40 bg-amber/10 text-amber"
        : priority === 3
          ? "border-accent/40 bg-accent/10 text-accent"
          : "border-white/10 bg-white/5 text-ink-300";
  return (
    <span className={clsx("badge", tone)} title={`Priority ${priority} of 5`}>
      P{priority}
    </span>
  );
}

export function EmptyState({
  title,
  description,
  action,
  icon,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-white/10 bg-white/[0.02] px-6 py-14 text-center">
      <span className="grid h-12 w-12 place-items-center rounded-2xl border border-white/10 bg-white/5 text-accent">
        {icon ?? <Info className="h-5 w-5" />}
      </span>
      <div>
        <p className="font-display text-sm font-semibold text-white">{title}</p>
        {description ? <p className="mt-1 max-w-md text-sm text-ink-400">{description}</p> : null}
      </div>
      {action}
    </div>
  );
}

export function Alert({
  tone = "info",
  title,
  children,
  action,
}: {
  tone?: "info" | "success" | "warning" | "danger";
  title?: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  const styles = {
    info: "border-accent/30 bg-accent/[0.07] text-ink-100",
    success: "border-mint/30 bg-mint/[0.07] text-ink-100",
    warning: "border-amber/30 bg-amber/[0.07] text-ink-100",
    danger: "border-coral/30 bg-coral/[0.07] text-ink-100",
  };
  const Icon = { info: Info, success: CheckCircle2, warning: AlertTriangle, danger: XCircle }[tone];
  return (
    <div role={tone === "danger" ? "alert" : "status"} className={clsx("notice flex gap-3", styles[tone])}>
      <Icon
        className={clsx(
          "mt-0.5 h-4 w-4 shrink-0",
          tone === "success" && "text-mint",
          tone === "warning" && "text-amber",
          tone === "danger" && "text-coral",
          tone === "info" && "text-accent",
        )}
      />
      <div className="flex-1">
        {title ? <p className="font-semibold text-white">{title}</p> : null}
        {children ? <div className={clsx("text-sm", title && "mt-0.5 text-ink-300")}>{children}</div> : null}
      </div>
      {action}
    </div>
  );
}

export function Spinner({ label = "Loading" }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-2 text-sm text-ink-400" role="status">
      <Loader2 className="h-4 w-4 animate-spin text-accent" aria-hidden />
      {label}
    </span>
  );
}

export function LoadingBlock({ rows = 3, label = "Loading data" }: { rows?: number; label?: string }) {
  return (
    <div className="space-y-3" role="status" aria-label={label}>
      {Array.from({ length: rows }).map((_, index) => (
        <div key={index} className="skeleton h-12 w-full" />
      ))}
      <span className="sr-only">{label}</span>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* controls                                                                    */
/* -------------------------------------------------------------------------- */

export function Button({
  variant = "primary",
  size,
  loading,
  children,
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm";
  loading?: boolean;
}) {
  const variants = {
    primary: "btn-primary",
    secondary: "btn-secondary",
    ghost: "btn-ghost",
    danger: "btn-danger",
  };
  return (
    <button
      className={clsx(variants[variant], size === "sm" && "btn-sm", className)}
      disabled={rest.disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
      {children}
    </button>
  );
}

export function Field({
  label,
  htmlFor,
  hint,
  error,
  required,
  children,
}: {
  label: string;
  htmlFor: string;
  hint?: string;
  error?: string;
  required?: boolean;
  children: ReactNode;
}) {
  return (
    <div>
      <label className="label" htmlFor={htmlFor}>
        {label}
        {required ? <span className="ml-1 text-coral">*</span> : null}
      </label>
      {children}
      {hint && !error ? <p className="mt-1 text-xs text-ink-500">{hint}</p> : null}
      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function Input({
  className,
  invalid,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }) {
  return (
    <input
      className={clsx("input", invalid && "border-coral/60 focus:ring-coral/30", className)}
      aria-invalid={invalid || undefined}
      {...rest}
    />
  );
}

export function Textarea({
  className,
  invalid,
  ...rest
}: TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }) {
  return (
    <textarea
      className={clsx("input min-h-[92px] resize-y", invalid && "border-coral/60", className)}
      aria-invalid={invalid || undefined}
      {...rest}
    />
  );
}

export function Select({
  className,
  children,
  invalid,
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement> & { invalid?: boolean }) {
  return (
    <div className="relative">
      <select
        className={clsx("input appearance-none pr-9", invalid && "border-coral/60", className)}
        aria-invalid={invalid || undefined}
        {...rest}
      >
        {children}
      </select>
      <ChevronDown
        className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-400"
        aria-hidden
      />
    </div>
  );
}

export function SearchInput({
  value,
  onChange,
  placeholder = "Search…",
  label,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  label?: string;
}) {
  const id = useId();
  return (
    <div className="relative">
      {label ? (
        <label htmlFor={id} className="sr-only">
          {label}
        </label>
      ) : null}
      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-500" aria-hidden />
      <input
        id={id}
        type="search"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className="input pl-9"
        aria-label={label ?? placeholder}
      />
    </div>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  description,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  description?: string;
}) {
  const id = useId();
  return (
    <div className="flex items-start justify-between gap-4">
      <div>
        <label htmlFor={id} className="text-sm font-medium text-white">
          {label}
        </label>
        {description ? <p className="mt-0.5 text-xs text-ink-400">{description}</p> : null}
      </div>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => onChange(!checked)}
        className={clsx(
          "relative h-6 w-11 shrink-0 rounded-full border transition-colors",
          checked ? "border-accent/50 bg-accent/30" : "border-white/15 bg-white/10",
        )}
      >
        <span
          className={clsx(
            "absolute top-0.5 h-4.5 w-4.5 rounded-full bg-white transition-transform",
            checked ? "translate-x-6" : "translate-x-1",
          )}
          style={{ height: "18px", width: "18px" }}
        />
      </button>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* table                                                                       */
/* -------------------------------------------------------------------------- */

export function DataTable<T>({
  rows,
  columns,
  getKey,
  empty,
  loading,
}: {
  rows: T[];
  columns: {
    key: string;
    header: ReactNode;
    render: (row: T) => ReactNode;
    className?: string;
    sortable?: boolean;
  }[];
  getKey: (row: T) => string | number;
  empty?: ReactNode;
  loading?: boolean;
}) {
  if (loading) return <LoadingBlock rows={4} label="Loading table" />;
  if (!rows.length) return <>{empty ?? <EmptyState title="Nothing to show yet" />}</>;
  return (
    <div className="table-shell">
      <table className="data-table">
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.key} scope="col" className={column.className}>
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={getKey(row)}>
              {columns.map((column) => (
                <td key={column.key} className={column.className}>
                  {column.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Pagination({
  meta,
  onPage,
}: {
  meta: { page: number; pages: number; total: number; page_size: number };
  onPage: (page: number) => void;
}) {
  if (!meta || meta.total === 0) return null;
  const from = (meta.page - 1) * meta.page_size + 1;
  const to = Math.min(meta.page * meta.page_size, meta.total);
  return (
    <nav className="mt-4 flex flex-wrap items-center justify-between gap-3" aria-label="Pagination">
      <p className="text-xs text-ink-400">
        Showing <span className="text-ink-100">{from}</span>–<span className="text-ink-100">{to}</span> of{" "}
        <span className="text-ink-100">{meta.total}</span>
      </p>
      <div className="flex items-center gap-2">
        <Button variant="secondary" size="sm" onClick={() => onPage(meta.page - 1)} disabled={meta.page <= 1}>
          Previous
        </Button>
        <span className="px-2 text-xs text-ink-300">
          Page {meta.page} / {meta.pages}
        </span>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => onPage(meta.page + 1)}
          disabled={meta.page >= meta.pages}
        >
          Next
        </Button>
      </div>
    </nav>
  );
}

/* -------------------------------------------------------------------------- */
/* modal & drawer                                                              */
/* -------------------------------------------------------------------------- */

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])';

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = "md",
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  size?: "sm" | "md" | "lg";
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const node = ref.current;
    const focusables = node ? Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE)) : [];
    focusables[0]?.focus();

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab" || !node) return;
      const items = Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null,
      );
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
      previous?.focus();
    };
  }, [open, onClose]);

  if (!open) return null;
  const widths = { sm: "max-w-md", md: "max-w-2xl", lg: "max-w-4xl" };
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-navy-950/80 p-4 backdrop-blur-sm sm:items-center">
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={clsx(
          "glass my-auto w-full animate-fade-up overflow-hidden shadow-glow",
          widths[size],
        )}
      >
        <div className="flex items-start justify-between gap-4 border-b border-white/10 px-5 py-4">
          <div>
            <h2 id={titleId} className="font-display text-lg font-semibold text-white">
              {title}
            </h2>
            {description ? <p className="mt-1 text-sm text-ink-400">{description}</p> : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-ink-400 transition hover:bg-white/10 hover:text-white"
            aria-label="Close dialog"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="max-h-[70vh] overflow-y-auto px-5 py-4 scrollbar-slim">{children}</div>
        {footer ? <div className="flex justify-end gap-2 border-t border-white/10 px-5 py-4">{footer}</div> : null}
      </div>
    </div>
  );
}

export function Drawer({
  open,
  onClose,
  title,
  subtitle,
  children,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const titleId = useId();
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-navy-950/70 backdrop-blur-sm">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="flex h-full w-full max-w-lg animate-fade-up flex-col border-l border-white/10 bg-navy-900/95 shadow-glass"
      >
        <div className="flex items-start justify-between gap-4 border-b border-white/10 px-5 py-4">
          <div>
            <h2 id={titleId} className="font-display text-lg font-semibold text-white">
              {title}
            </h2>
            {subtitle ? <p className="mt-0.5 text-xs text-ink-400">{subtitle}</p> : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-ink-400 transition hover:bg-white/10 hover:text-white"
            aria-label="Close panel"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4 scrollbar-slim">{children}</div>
        {footer ? <div className="border-t border-white/10 px-5 py-4">{footer}</div> : null}
      </div>
    </div>
  );
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = "Confirm",
  destructive,
  onConfirm,
  onCancel,
  loading,
  children,
}: {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  loading?: boolean;
  children?: ReactNode;
}) {
  return (
    <Modal
      open={open}
      onClose={onCancel}
      title={title}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onCancel} disabled={loading}>
            Cancel
          </Button>
          <Button variant={destructive ? "danger" : "primary"} onClick={onConfirm} loading={loading}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <p className="text-sm text-ink-300">{message}</p>
      {children}
    </Modal>
  );
}

/* -------------------------------------------------------------------------- */
/* misc                                                                        */
/* -------------------------------------------------------------------------- */

export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
  label = "Sections",
}: {
  tabs: { id: T; label: string; count?: number }[];
  value: T;
  onChange: (id: T) => void;
  label?: string;
}) {
  return (
    <div
      role="tablist"
      aria-label={label}
      className="flex flex-wrap gap-1 rounded-xl border border-white/10 bg-white/[0.03] p-1"
    >
      {tabs.map((tab) => (
        <button
          key={tab.id}
          role="tab"
          aria-selected={value === tab.id}
          tabIndex={value === tab.id ? 0 : -1}
          onClick={() => onChange(tab.id)}
          onKeyDown={(event) => {
            if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
            event.preventDefault();
            const index = tabs.findIndex((t) => t.id === value);
            const next = event.key === "ArrowRight" ? index + 1 : index - 1;
            const target = tabs[(next + tabs.length) % tabs.length];
            onChange(target.id);
          }}
          className={clsx(
            "rounded-lg px-3.5 py-2 text-sm font-medium transition",
            value === tab.id
              ? "bg-accent/15 text-white shadow-[inset_0_0_0_1px_rgba(69,216,245,0.3)]"
              : "text-ink-400 hover:bg-white/5 hover:text-white",
          )}
        >
          {tab.label}
          {typeof tab.count === "number" ? (
            <span className="ml-2 rounded-full bg-white/10 px-1.5 py-0.5 text-[10px] text-ink-200">
              {tab.count}
            </span>
          ) : null}
        </button>
      ))}
    </div>
  );
}

export function ProgressBar({
  value,
  tone = "accent",
  label,
}: {
  value: number;
  tone?: "accent" | "mint" | "amber" | "coral";
  label?: string;
}) {
  const clamped = Math.max(0, Math.min(100, value));
  const tones = { accent: "bg-accent", mint: "bg-mint", amber: "bg-amber", coral: "bg-coral" };
  return (
    <div
      className="h-2 w-full overflow-hidden rounded-full bg-white/10"
      role="progressbar"
      aria-valuenow={Math.round(clamped)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label}
    >
      <div
        className={clsx("h-full rounded-full transition-all duration-500", tones[tone])}
        style={{ width: `${clamped}%` }}
      />
    </div>
  );
}

export function ToastHost({
  toasts,
  onDismiss,
}: {
  toasts: { id: number; message: string; tone: "success" | "error" | "info" }[];
  onDismiss: (id: number) => void;
}) {
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-full max-w-sm flex-col gap-2">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          role="status"
          className={clsx(
            "pointer-events-auto flex items-start gap-3 rounded-xl border px-4 py-3 text-sm shadow-glass backdrop-blur-xl",
            toast.tone === "success" && "border-mint/30 bg-navy-900/95 text-ink-100",
            toast.tone === "error" && "border-coral/40 bg-navy-900/95 text-ink-100",
            toast.tone === "info" && "border-accent/30 bg-navy-900/95 text-ink-100",
          )}
        >
          {toast.tone === "success" ? <CheckCircle2 className="mt-0.5 h-4 w-4 text-mint" /> : null}
          {toast.tone === "error" ? <XCircle className="mt-0.5 h-4 w-4 text-coral" /> : null}
          {toast.tone === "info" ? <Info className="mt-0.5 h-4 w-4 text-accent" /> : null}
          <p className="flex-1">{toast.message}</p>
          <button
            onClick={() => onDismiss(toast.id)}
            className="text-ink-400 hover:text-white"
            aria-label="Dismiss notification"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}

/* Simple accessible stat card used across dashboards. */
export function StatCard({
  label,
  value,
  hint,
  tone = "accent",
  icon,
  trend,
  href,
}: {
  label: string;
  value: string | number;
  hint?: string;
  tone?: "accent" | "mint" | "amber" | "coral";
  icon?: ReactNode;
  trend?: { value: string; direction: "up" | "down" | "flat" };
  href?: string;
}) {
  const tones = {
    accent: "from-accent/20 to-transparent text-accent",
    mint: "from-mint/20 to-transparent text-mint",
    amber: "from-amber/20 to-transparent text-amber",
    coral: "from-coral/20 to-transparent text-coral",
  };
  const body = (
    <div className="glass group relative overflow-hidden p-4 transition hover:border-accent/30">
      <div
        className={clsx(
          "pointer-events-none absolute -right-8 -top-10 h-28 w-28 rounded-full bg-gradient-to-br blur-2xl",
          tones[tone],
        )}
        aria-hidden
      />
      <div className="relative flex items-start justify-between">
        <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-ink-400">{label}</p>
        {icon ? <span className={clsx("text-ink-300", `text-${tone}`)}>{icon}</span> : null}
      </div>
      <p className="relative mt-2 font-display text-2xl font-semibold text-white">{value}</p>
      {hint ? <p className="relative mt-1 text-xs text-ink-400">{hint}</p> : null}
      {trend ? (
        <p
          className={clsx(
            "relative mt-2 text-xs font-medium",
            trend.direction === "up" && "text-mint",
            trend.direction === "down" && "text-coral",
            trend.direction === "flat" && "text-ink-400",
          )}
        >
          {trend.direction === "up" ? "▲" : trend.direction === "down" ? "▼" : "■"} {trend.value}
        </p>
      ) : null}
    </div>
  );
  return href ? (
    <Link href={href} aria-label={`${label}: ${value}`}>
      {body}
    </Link>
  ) : (
    body
  );
}

/* Modal state helper so screens do not repeat open/close plumbing. */
export function useDisclosure(initial = false) {
  const [open, setOpen] = useState(initial);
  return useMemo(
    () => ({
      open,
      show: () => setOpen(true),
      hide: () => setOpen(false),
      toggle: () => setOpen((v) => !v),
    }),
    [open],
  );
}

export function useToastContext() {
  return useContext(ToastContext);
}

const ToastContext = createContext<{ push: (m: string, t?: "success" | "error" | "info") => void }>({
  push: () => undefined,
});
