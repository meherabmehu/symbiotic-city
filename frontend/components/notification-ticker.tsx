"use client";

/**
 * The dashboard's bottom notification marquee, modelled on the reference
 * dashboard's ticker: a fixed label, a continuously scrolling strip of the
 * latest per-user notifications, and a link to the full feed.
 *
 * Every item is real backend data (incidents, tasks, workflows, simulations
 * writing notification rows) -- nothing is invented for the strip's sake. It
 * stays out of the way when there is nothing to say: no rows, no strip.
 */

import Link from "next/link";
import { ArrowRight, Bell } from "lucide-react";
import { api, qs } from "@/lib/api";
import { useAsync } from "@/lib/hooks";
import type { ListResponse, Notification } from "@/lib/types";

const SEVERITY_DOT: Record<string, string> = {
  critical: "bg-coral",
  error: "bg-coral",
  warning: "bg-amber",
  info: "bg-accent",
};

function clockOf(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

export function NotificationTicker() {
  const feed = useAsync<Notification[]>(async (signal) => {
    const response: ListResponse<Notification> = await api.list(
      `/notifications${qs({ page_size: 12 })}`,
      { signal },
    );
    return response.data;
  }, []);

  const items = feed.data ?? [];
  if (items.length === 0) return null;

  const strip = (copy: string) => (
    <div className="flex shrink-0 items-center gap-7 pr-7" aria-hidden={copy === "b"}>
      {items.map((item) => (
        <span
          key={`${copy}-${item.id}`}
          className="flex items-center gap-2 whitespace-nowrap text-xs text-ink-300"
        >
          <span className={`h-1.5 w-1.5 rounded-full ${SEVERITY_DOT[item.severity] ?? "bg-ink-500"}`} aria-hidden />
          <span className="tabular-nums text-ink-500">{clockOf(item.created_at)}</span>
          <span className="font-semibold text-white">{item.title}</span>
          <span className="text-ink-400">{item.body}</span>
        </span>
      ))}
    </div>
  );

  return (
    <div
      className="group mt-4 flex items-stretch overflow-hidden rounded-xl border border-white/10 bg-navy-900/60"
      data-testid="city-ticker"
    >
      <div className="flex shrink-0 items-center gap-2 border-r border-white/10 bg-white/[0.03] px-3 py-2">
        <Bell className="h-3.5 w-3.5 text-accent" aria-hidden />
        <span className="label text-[10px]">City notifications</span>
      </div>
      <div className="relative min-w-0 flex-1 overflow-hidden py-2">
        <div className="animate-ticker flex w-max">
          {strip("a")}
          {strip("b")}
        </div>
      </div>
      <Link
        href="/notifications"
        className="flex shrink-0 items-center gap-1 border-l border-white/10 px-3 text-xs text-ink-300 transition hover:text-white"
      >
        View all
        <ArrowRight className="h-3 w-3" aria-hidden />
      </Link>
    </div>
  );
}
