"use client";

/**
 * Playback of a simulated cascade.
 *
 * This file exists to answer one question precisely: *what should be drawn at
 * second 3.5 of this run?* It is a pure function of the run's timeline and the
 * playhead, which means:
 *
 *  - playback is reproducible, and tested without a browser;
 *  - it cannot touch live data, because it has no access to anything but the
 *    run that was fetched, and it returns values rather than writing them;
 *  - scrubbing, pausing and replaying are all just changes to the playhead.
 *
 * The run being replayed is always a stored simulation result. Nothing here
 * commits, approves, or transitions anything: the overlay is drawn on top of the
 * live twin and disappears when playback ends.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Impact, SimulationRunDetail } from "@/lib/types";

/** How long each depth of the cascade takes to appear, in seconds. */
export const STEP_SECONDS = 1.4;

/** Status shown for an asset at a given moment of the replay. */
export type ReplayVisual = "failed" | "degraded" | "affected" | null;

export interface ReplayFrame {
  /** Impacts visible at this playhead position, deepest-first order preserved. */
  impacts: Impact[];
  /** Assets shown as failed/degraded, keyed by asset id. */
  levels: Map<number, Exclude<ReplayVisual, null>>;
  /** The depth currently being revealed, for narration. */
  depth: number;
  /** Total number of cascade depths in the run. */
  depthCount: number;
  /** Population affected by the impacts revealed so far. */
  population: number;
  /** True once the playhead has reached the end of the cascade. */
  complete: boolean;
}

/**
 * Build the frame at `seconds` into the run.
 *
 * Impacts arrive with a `depth` (0 is the asset that failed, 1 is what depends on
 * it, and so on). They are revealed one depth at a time so the cascade reads as a
 * wave moving outward instead of a single flash -- which is the difference between
 * showing the result and showing the failure.
 */
export function replayFrame(run: SimulationRunDetail | null, seconds: number): ReplayFrame {
  const empty: ReplayFrame = {
    impacts: [],
    levels: new Map(),
    depth: 0,
    depthCount: 0,
    population: 0,
    complete: false,
  };
  if (!run) return empty;

  const impacts = run.impacts ?? [];
  const depthCount = impacts.reduce((max, impact) => Math.max(max, impact.depth), -1) + 1;
  if (depthCount === 0) return { ...empty, complete: true };

  const revealed = Math.max(0, Math.min(depthCount, Math.floor(seconds / STEP_SECONDS) + 1));
  const visible = impacts.filter((impact) => impact.depth < revealed);

  const levels = new Map<number, Exclude<ReplayVisual, null>>();
  for (const impact of visible) {
    levels.set(impact.asset_id, impact.impact_level);
  }

  return {
    impacts: visible,
    levels,
    depth: Math.min(revealed, depthCount),
    depthCount,
    population: visible.reduce((sum, impact) => sum + (impact.affected_population ?? 0), 0),
    complete: revealed >= depthCount,
  };
}

/** The wall-clock length of a replay, in seconds. */
export function replayDuration(run: SimulationRunDetail | null): number {
  if (!run) return 0;
  const impacts = run.impacts ?? [];
  const depthCount = impacts.reduce((max, impact) => Math.max(max, impact.depth), -1) + 1;
  return Math.max(0, depthCount) * STEP_SECONDS;
}

export interface ReplayControls {
  playhead: number;
  playing: boolean;
  duration: number;
  frame: ReplayFrame;
  play: () => void;
  pause: () => void;
  toggle: () => void;
  reset: () => void;
  /** Jump to a position, in seconds. Used by the scrubber. */
  seek: (seconds: number) => void;
}

/**
 * Drive a replay with requestAnimationFrame.
 *
 * The clock advances at the frame's delta rather than by counting frames, so a
 * slow device replays in the same wall-clock time as a fast one. A hidden tab
 * pauses rather than skipping the cascade, and reduced-motion replays instantly
 * to the end state -- the analysis is still available, just not animated.
 */
export function useReplay(
  run: SimulationRunDetail | null,
  options: { reducedMotion?: boolean } = {},
): ReplayControls {
  const duration = useMemo(() => replayDuration(run), [run]);
  const [playhead, setPlayhead] = useState(0);
  const [playing, setPlaying] = useState(false);
  const frameRef = useRef<number | null>(null);
  const lastTick = useRef<number | null>(null);

  const stop = useCallback(() => {
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
    lastTick.current = null;
  }, []);

  // A new run resets the playhead: replaying the previous run's position against
  // a different cascade would show an arbitrary frame.
  useEffect(() => {
    stop();
    setPlayhead(0);
    setPlaying(false);
  }, [run, stop]);

  useEffect(() => {
    if (!playing) {
      stop();
      return;
    }

    const tick = (now: number) => {
      if (lastTick.current === null) lastTick.current = now;
      const delta = (now - lastTick.current) / 1000;
      lastTick.current = now;

      setPlayhead((current) => {
        const next = current + delta;
        if (next >= duration) {
          setPlaying(false);
          return duration;
        }
        return next;
      });
      frameRef.current = requestAnimationFrame(tick);
    };

    frameRef.current = requestAnimationFrame(tick);
    return stop;
  }, [playing, duration, stop]);

  const play = useCallback(() => {
    if (duration <= 0) return;
    if (options.reducedMotion) {
      // Jump straight to the end: the result is the point, the motion is not.
      setPlayhead(duration);
      setPlaying(false);
      return;
    }
    setPlayhead((current) => (current >= duration ? 0 : current));
    setPlaying(true);
  }, [duration, options.reducedMotion]);

  const pause = useCallback(() => setPlaying(false), []);
  const toggle = useCallback(() => (playing ? pause() : play()), [playing, pause, play]);
  const reset = useCallback(() => {
    setPlaying(false);
    setPlayhead(0);
  }, []);
  const seek = useCallback(
    (seconds: number) => {
      setPlaying(false);
      setPlayhead(Math.max(0, Math.min(duration, seconds)));
    },
    [duration],
  );

  const frame = useMemo(() => replayFrame(run, playhead), [run, playhead]);

  return { playhead, playing, duration, frame, play, pause, toggle, reset, seek };
}
