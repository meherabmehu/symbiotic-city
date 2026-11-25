"use client";

/**
 * Time travel over the twin's recorded history.
 *
 * Scrubbing rewinds the statuses the map draws. It is a read-only reconstruction
 * from `/resilience/timetravel`: no request is sent while scrubbing, and nothing is
 * written back. The panel says "recorded history", not "restore", for that reason.
 */

import { useMemo } from "react";
import { History, RotateCcw } from "lucide-react";
import { Badge, Button } from "@/components/ui";
import { changedAssets, describeFrame, frameAt, statusSteps, type TimelineFrame } from "@/lib/timeline";
import { STATUS_STYLES } from "@/lib/city-model";
import type { Timeline, TwinNode } from "@/lib/types";

export interface TimelinePanelProps {
  timeline: Timeline | null;
  nodes: TwinNode[];
  loading?: boolean;
  error?: string | null;
  frame: TimelineFrame;
  onScrub: (index: number) => void;
  onReset: () => void;
  onSelectAsset?: (id: number) => void;
}

export function TimelinePanel({
  timeline,
  nodes,
  loading,
  error,
  frame,
  onScrub,
  onReset,
  onSelectAsset,
}: TimelinePanelProps) {
  const steps = useMemo(() => statusSteps(timeline), [timeline]);
  const changed = useMemo(() => changedAssets(frame, nodes), [frame, nodes]);

  if (loading) return <p className="text-xs text-ink-500">Loading recorded history…</p>;

  if (error) {
    return (
      <p className="rounded-lg border border-coral/30 bg-coral/10 px-3 py-2 text-xs text-coral" role="alert">
        {error}
      </p>
    );
  }

  if (!timeline || steps.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-white/10 bg-white/[0.02] px-3 py-4 text-center">
        <p className="text-xs font-semibold text-white">No recorded status changes</p>
        <p className="mt-1 text-[11px] leading-relaxed text-ink-500">
          The log records status transitions as they happen. Until an asset changes state there is
          nothing to rewind through.
        </p>
      </div>
    );
  }

  const atEnd = frame.index === frame.total;
  const label = atEnd
    ? (frame.step?.at ? new Date(frame.step.at).toLocaleString() : "Present")
    : describeFrame(frame);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={atEnd ? "success" : "accent"}>
          <History className="h-3 w-3" aria-hidden /> {atEnd ? "Present" : "Rewound"}
        </Badge>
        <span className="text-[11px] text-ink-400">
          Step {frame.index}/{frame.total}
        </span>
        {!atEnd ? (
          <Button variant="ghost" size="sm" onClick={onReset}>
            <RotateCcw className="h-3.5 w-3.5" aria-hidden /> Back to present
          </Button>
        ) : null}
      </div>

      <div>
        <label htmlFor="timeline-scrub" className="text-[10px] uppercase tracking-[0.16em] text-ink-500">
          Rewind through recorded changes
        </label>
        <input
          id="timeline-scrub"
          type="range"
          min={0}
          max={frame.total}
          step={1}
          value={frame.index}
          onChange={(event) => onScrub(Number(event.target.value))}
          aria-valuetext={label}
          className="mt-1 w-full accent-accent"
        />
        <p className="mt-0.5 text-[11px] text-ink-400">{label}</p>
      </div>

      {!atEnd ? (
        <p className="rounded-lg border border-amber/25 bg-amber/5 px-2 py-1.5 text-[10px] leading-snug text-amber">
          Reconstructed from the change log. Where the log is silent, assets keep their current
          status — nothing here is invented.
        </p>
      ) : null}

      <div>
        <p className="mb-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-ink-500">
          {changed.length === 0 ? "No difference from now" : `${changed.length} asset(s) differ from now`}
        </p>
        <ul className="max-h-44 space-y-1 overflow-y-auto">
          {changed.slice(0, 12).map(({ node, was, now }) => {
            const style = STATUS_STYLES[(now === "offline" ? "failed" : now) as keyof typeof STATUS_STYLES]
              ?? STATUS_STYLES.operational;
            return (
              <li key={node.id}>
                <button
                  onClick={() => onSelectAsset?.(node.id)}
                  className="flex w-full items-center justify-between gap-2 rounded-md bg-white/[0.03] px-2 py-1 text-left text-[11px] hover:bg-white/[0.06]"
                >
                  <span className="truncate text-ink-300">
                    <span className="font-mono text-[10px] text-ink-500">{node.code}</span> {node.name}
                  </span>
                  <span className="shrink-0 text-[10px]" style={{ color: style.color }}>
                    was {was} → {style.label}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>

      {timeline.truncated ? (
        <p className="text-[10px] text-ink-600">
          Showing the most recent {timeline.step_count} of {timeline.total_changes} changes.
        </p>
      ) : null}
    </div>
  );
}

/** Draw-ready overrides for the 3D canvas: only assets that differ from now. */
export function timelineOverlay(frame: TimelineFrame, nodes: TwinNode[]) {
  return changedAssets(frame, nodes).map(({ node, now }) => ({
    asset_id: node.id,
    impact_level: now === "offline" ? "failed" : now === "degraded" ? "degraded" : "affected",
  }));
}

/** Rebinding helper used by the page when the timeline first arrives. */
export function presentFrame(timeline: Timeline | null, nodes: TwinNode[]): TimelineFrame {
  return frameAt(timeline, nodes, statusSteps(timeline).length);
}
