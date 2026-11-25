"use client";

/**
 * Time-travel replay of a stored simulation run.
 *
 * The panel picks a completed run, then plays its cascade back as a wave over the
 * city. Everything it displays comes from the stored result -- it never re-runs
 * the engine, and it never writes anything. Playing a cascade cannot start an
 * incident, transition an asset or approve a recovery.
 *
 * The distinction is made explicit in the UI, not just in the code: the panel is
 * labelled "replay", it says which run it is replaying, and it offers a single
 * action when it finishes -- clear the overlay.
 */

import { useEffect, useMemo } from "react";
import { AlertTriangle, Pause, Play, RotateCcw, Users } from "lucide-react";
import { Badge, Button, Select } from "@/components/ui";
import { formatNumber } from "@/lib/format";
import type { SimulationRun, SimulationRunDetail } from "@/lib/types";
import { STEP_SECONDS, useReplay } from "@/lib/replay";

export interface ReplayPanelProps {
  runs: SimulationRun[];
  selectedRunId: number | null;
  onSelectRun: (id: number | null) => void;
  /** The full result of the selected run, with impacts. */
  detail: SimulationRunDetail | null;
  loading?: boolean;
  error?: string | null;
  reducedMotion?: boolean;
  /** Called for every frame with the assets to draw and their levels. */
  onFrame?: (levels: Map<number, "failed" | "degraded" | "affected">, population: number) => void;
}

export function ReplayPanel({
  runs,
  selectedRunId,
  onSelectRun,
  detail,
  loading,
  error,
  reducedMotion,
  onFrame,
}: ReplayPanelProps) {
  const replay = useReplay(detail, { reducedMotion });
  const { frame, playhead, playing, duration } = replay;

  // Push each frame up to the scene. This is an effect rather than a call during
  // render: notifying a parent from the render pass is a side effect React is
  // entitled to run twice (StrictMode does), and it would set state on a component
  // that is mid-render.
  useEffect(() => {
    onFrame?.(frame.levels as Map<number, "failed" | "degraded" | "affected">, frame.population);
  }, [frame, onFrame]);

  const completedRuns = useMemo(
    () => runs.filter((run) => run.status === "completed"),
    [runs],
  );

  if (loading) {
    return <p className="text-xs text-ink-500">Loading simulation runs…</p>;
  }

  if (error) {
    return (
      <p className="rounded-lg border border-coral/30 bg-coral/10 px-3 py-2 text-xs text-coral" role="alert">
        {error}
      </p>
    );
  }

  if (completedRuns.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-white/10 bg-white/[0.02] px-3 py-4 text-center">
        <p className="text-xs font-semibold text-white">No completed runs to replay</p>
        <p className="mt-1 text-[11px] leading-relaxed text-ink-500">
          Run a failure simulation in the failure lab first. Replay shows a stored result; it cannot
          start one.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={selectedRunId ?? ""}
          onChange={(event) => onSelectRun(event.target.value ? Number(event.target.value) : null)}
          aria-label="Simulation run to replay"
          className="py-1.5 text-xs"
        >
          <option value="">Choose a run…</option>
          {completedRuns.map((run) => (
            <option key={run.id} value={run.id}>
              {run.code} · {run.name}
            </option>
          ))}
        </Select>
        {detail ? (
          <Badge tone="accent">
            {detail.summary.assets_failed} failed · {detail.summary.assets_degraded} degraded
          </Badge>
        ) : null}
      </div>

      {!detail ? (
        <p className="text-xs text-ink-500">
          Pick a run to watch its cascade spread from the origin outward. Replay is a projection of a
          stored result onto the live map — it changes nothing.
        </p>
      ) : (
        <>
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={replay.toggle}
              disabled={duration === 0}
              aria-label={playing ? "Pause replay" : "Play replay"}
            >
              {playing ? <Pause className="h-3.5 w-3.5" aria-hidden /> : <Play className="h-3.5 w-3.5" aria-hidden />}
              {playing ? "Pause" : playhead >= duration && duration > 0 ? "Replay" : "Play"}
            </Button>
            <Button variant="ghost" size="sm" onClick={replay.reset} disabled={playhead === 0}>
              <RotateCcw className="h-3.5 w-3.5" aria-hidden /> Reset
            </Button>
            <span className="text-[11px] text-ink-500">
              Depth {frame.depth}/{frame.depthCount} ·{" "}
              <span className="inline-flex items-center gap-1">
                <Users className="h-3 w-3" aria-hidden /> {formatNumber(frame.population, 0)} people affected
              </span>
            </span>
          </div>

          <div>
            <label htmlFor="replay-scrub" className="text-[10px] uppercase tracking-[0.16em] text-ink-500">
              Scrub
            </label>
            <input
              id="replay-scrub"
              type="range"
              min={0}
              max={Math.max(duration, STEP_SECONDS)}
              step={0.05}
              value={playhead}
              onChange={(event) => replay.seek(Number(event.target.value))}
              aria-valuetext={`Depth ${frame.depth} of ${frame.depthCount}, ${formatNumber(frame.population, 0)} people affected`}
              className="mt-1 w-full accent-accent"
            />
            <div className="flex justify-between text-[10px] text-ink-600">
              <span>Origin</span>
              <span>Cascade complete</span>
            </div>
          </div>

          {frame.complete ? (
            <p className="text-[11px] text-amber">
              <AlertTriangle className="mr-1 inline h-3 w-3" aria-hidden />
              End of replay. This is the result the engine produced, not the live state of these assets.
            </p>
          ) : null}

          <details className="rounded-lg bg-white/[0.03] px-2 py-1.5">
            <summary className="cursor-pointer text-[11px] text-ink-400">
              Run details ({detail.code})
            </summary>
            <dl className="mt-2 space-y-1 text-[11px] text-ink-400">
              <div className="flex justify-between">
                <dt>Started</dt>
                <dd>{new Date(detail.started_at).toLocaleString()}</dd>
              </div>
              <div className="flex justify-between">
                <dt>Mode</dt>
                <dd>{detail.failure_mode.replace(/_/g, " ")}</dd>
              </div>
              <div className="flex justify-between">
                <dt>Cascade threshold</dt>
                <dd>{Math.round(detail.cascade_threshold * 100)}%</dd>
              </div>
              <div className="flex justify-between">
                <dt>Seed</dt>
                <dd className="font-mono">{detail.random_seed}</dd>
              </div>
              <div className="flex justify-between">
                <dt>Origin</dt>
                <dd>{detail.initial_failure_ids.length} asset(s)</dd>
              </div>
            </dl>
          </details>
        </>
      )}
    </div>
  );
}
