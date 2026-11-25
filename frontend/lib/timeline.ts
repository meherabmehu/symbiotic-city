/**
 * Rebuilding the twin's state at a point in its recorded past.
 *
 * `/resilience/timetravel` returns transitions, not frames: each step says what an
 * asset changed *from* and *to*. To draw the city at step 20 we start from the
 * present and undo the steps after 20 in reverse. That direction matters: the
 * current status is authoritative and already in the database, so walking
 * backwards from it cannot invent a state that never existed -- the worst it can
 * do is miss a transition the log does not contain, which leaves the asset at its
 * live status rather than at a fiction.
 *
 * Two rules follow from the acceptance criteria:
 *
 *  - A `maintenance` transition is applied even when a simulation overlay also
 *    touches the asset, because scheduled work is real and a hypothetical is not.
 *  - Nothing is ever shown as operational on the strength of a recovery animation
 *    alone. Status here comes only from recorded `from`/`to` values.
 */

import type { Timeline, TimelineStep, TwinNode } from "@/lib/types";

export interface TimelineFrame {
  /** The twin as it was at this step: status overrides keyed by asset id. */
  statuses: Map<number, string>;
  /** Assets the database currently calls maintenance, which stay that way. */
  maintenance: Set<number>;
  step: TimelineStep | null;
  index: number;
  total: number;
  /** Population of the zones that had a failed asset at this point. */
  at: string | null;
}

/** The status transitions, in order, ignoring unrelated activity. */
export function statusSteps(timeline: Timeline | null): TimelineStep[] {
  if (!timeline) return [];
  return timeline.steps
    .filter((step) => step.kind === "status" && step.asset_id != null && step.to)
    .sort((a, b) => a.index - b.index);
}

/**
 * The twin's statuses at `index` (1-based over the status transitions).
 *
 * `index = steps.length` gives the present. `index = 0` gives the furthest back
 * the log can reach.
 */
export function frameAt(
  timeline: Timeline | null,
  nodes: TwinNode[],
  index: number,
): TimelineFrame {
  const steps = statusSteps(timeline);
  const current = new Map<number, string>(nodes.map((node) => [node.id, node.status]));
  const maintenance = new Set(
    nodes.filter((node) => node.status === "maintenance").map((node) => node.id),
  );

  // A status the database holds for an asset that has since been archived still
  // needs a starting point, so the map starts from the live value.
  const statuses = new Map(current);
  const clamped = Math.max(0, Math.min(steps.length, Math.round(index)));
  const rewind = steps.slice(clamped);

  // Undo in reverse: the last change is the first thing to reverse.
  for (let position = rewind.length - 1; position >= 0; position -= 1) {
    const step = rewind[position];
    if (step.asset_id == null || !step.from) continue;
    statuses.set(step.asset_id, step.from);
    // Rewinding to "maintenance" means it really was in maintenance then; the
    // overlay must not overwrite that with a hypothetical.
    if (step.from === "maintenance") maintenance.add(step.asset_id);
    else maintenance.delete(step.asset_id);
  }

  return {
    statuses,
    maintenance,
    step: clamped > 0 ? steps[clamped - 1] : null,
    index: clamped,
    total: steps.length,
    at: clamped > 0 ? steps[clamped - 1].at : steps[0]?.at ?? null,
  };
}

/** A one-line description of the state at a step, for the scrubber's label. */
export function describeFrame(frame: TimelineFrame): string {
  if (frame.total === 0) return "No status changes recorded";
  if (frame.index === 0) return "Earlier than the recorded log";
  return frame.step?.summary ?? `Step ${frame.index} of ${frame.total}`;
}

/** Every asset whose status differs from the live one at this point. */
export function changedAssets(
  frame: TimelineFrame,
  nodes: TwinNode[],
): { node: TwinNode; was: string; now: string }[] {
  const changed: { node: TwinNode; was: string; now: string }[] = [];
  for (const node of nodes) {
    const then = frame.statuses.get(node.id);
    if (then && then !== node.status) {
      changed.push({ node, was: node.status, now: then });
    }
  }
  return changed;
}
