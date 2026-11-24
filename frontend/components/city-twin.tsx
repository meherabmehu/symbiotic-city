"use client";

/**
 * Interactive city digital twin.
 *
 * The twin is rendered on a canvas for smooth pan/zoom over ~25 nodes plus
 * dependency edges, but every interaction has a DOM equivalent: the selected
 * asset is described in the side panel, and a keyboard-navigable asset list
 * mirrors the canvas so the screen is fully usable without a pointer.
 *
 * The view is *data driven*: nodes, edges, statuses and simulation impacts are
 * all fetched from the API. Nothing here is a static illustration.
 */

import clsx from "clsx";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Building2,
  Crosshair,
  Droplets,
  HeartPulse,
  Home,
  Layers,
  Maximize2,
  Minus,
  Plus,
  Radio,
  RotateCcw,
  School,
  Waves,
  Zap,
} from "lucide-react";
import type { Impact, TwinEdge, TwinGraph, TwinNode, Zone } from "@/lib/types";
import { Badge, Button, Panel } from "@/components/ui";

const STATUS_COLOR: Record<string, string> = {
  operational: "#3ee6a5",
  degraded: "#ffb545",
  offline: "#ff6b6b",
  maintenance: "#45d8f5",
  archived: "#4d6d8f",
};

const IMPACT_COLOR: Record<string, string> = {
  failed: "#ff6b6b",
  degraded: "#ffb545",
  affected: "#45d8f5",
};

/**
 * A second encoding of status, independent of colour.
 *
 * The map used to distinguish operational / degraded / offline by hue alone:
 * mint against amber against coral. That is unreadable for the ~8% of men with a
 * red-green deficiency, and it fails the accessibility rule the rest of the
 * product follows. Each status now also has a mark, drawn on the tower it
 * belongs to, and the legend shows the same mark beside its swatch.
 */
const STATUS_MARK: Record<string, "none" | "half" | "bar" | "cross" | "dot"> = {
  operational: "none",
  degraded: "half",
  offline: "cross",
  maintenance: "bar",
  archived: "dot",
};

const MARK_LABEL: Record<string, string> = {
  none: "no mark",
  half: "half-filled",
  cross: "cross",
  bar: "bar",
  dot: "dot",
};

const CATEGORY_GLYPH: Record<string, React.ComponentType<{ className?: string }>> = {
  power_station: Zap,
  substation: Zap,
  hospital: HeartPulse,
  water_pump: Droplets,
  water_treatment: Waves,
  school: School,
  residential: Home,
  commercial: Building2,
  telecom: Radio,
};

interface Camera {
  x: number;
  y: number;
  scale: number;
}

interface CityTwinProps {
  graph: TwinGraph | null;
  loading?: boolean;
  impacts?: Impact[];
  selectedId?: number | null;
  onSelect?: (node: TwinNode | null) => void;
  showEdges?: boolean;
  className?: string;
  height?: number;
}

const PADDING = 46;

export function CityTwin({
  graph,
  loading,
  impacts = [],
  selectedId = null,
  onSelect,
  showEdges = true,
  className,
  height = 520,
}: CityTwinProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [camera, setCamera] = useState<Camera>({ x: 0, y: 0, scale: 1 });
  const [hovered, setHovered] = useState<number | null>(null);
  const [internalSelected, setInternalSelected] = useState<number | null>(null);
  const dragState = useRef<{ x: number; y: number; camX: number; camY: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  // Start at zero and let the ResizeObserver supply the real width. A hardcoded
  // default width is written to the canvas as an inline pixel size, which pushes
  // the whole page wider than a narrow viewport until the observer fires.
  const [size, setSize] = useState({ width: 0, height });

  const selected = selectedId ?? internalSelected;
  const impactByAsset = useMemo(() => {
    const map = new Map<number, Impact>();
    for (const impact of impacts) map.set(impact.asset_id, impact);
    return map;
  }, [impacts]);

  const nodes = graph?.nodes ?? [];
  const edges = graph?.edges ?? [];
  const nodeById = useMemo(() => {
    const map = new Map<number, TwinNode>();
    for (const node of nodes) map.set(node.id, node);
    return map;
  }, [nodes]);

  /* ---------------------------------------------------------------- sizing */
  useEffect(() => {
    const element = wrapRef.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      // Round down so a fractional width can never round up past the container.
      setSize({ width: Math.floor(entry.contentRect.width), height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [height]);

  const project = useCallback(
    (node: TwinNode, cam: Camera, width: number, heightPx: number) => {
      const scale = Math.min(width, heightPx) / 128;
      return {
        x: width / 2 + (node.map_x - 50) * scale * cam.scale + cam.x,
        y: heightPx / 2 + (node.map_y - 50) * scale * cam.scale + cam.y,
      };
    },
    [],
  );

  /* ---------------------------------------------------------------- drawing */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    // Not measured yet: leave the canvas alone rather than painting at a guess.
    if (size.width <= 0) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = size.width * dpr;
    canvas.height = size.height * dpr;
    canvas.style.width = `${size.width}px`;
    canvas.style.height = `${size.height}px`;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, size.width, size.height);

    // background grid
    const grid = 48 * camera.scale;
    const offsetX = camera.x % grid;
    const offsetY = camera.y % grid;
    context.strokeStyle = "rgba(69,216,245,0.07)";
    context.lineWidth = 1;
    for (let x = offsetX; x < size.width; x += grid) {
      context.beginPath();
      context.moveTo(x, 0);
      context.lineTo(x, size.height);
      context.stroke();
    }
    for (let y = offsetY; y < size.height; y += grid) {
      context.beginPath();
      context.moveTo(0, y);
      context.lineTo(size.width, y);
      context.stroke();
    }

    // zone rings
    for (const zone of graph?.zones ?? []) {
      const center = project(
        { ...(nodes[0] ?? {}), map_x: zone.center_x, map_y: zone.center_y } as TwinNode,
        camera,
        size.width,
        size.height,
      );
      const radius = 22 * camera.scale + Math.min(70, zone.population / 900) * camera.scale;
      context.beginPath();
      context.arc(center.x, center.y, radius, 0, Math.PI * 2);
      context.fillStyle = "rgba(69,216,245,0.03)";
      context.fill();
      context.strokeStyle = "rgba(143,179,212,0.14)";
      context.setLineDash([4, 6]);
      context.stroke();
      context.setLineDash([]);
      context.fillStyle = "rgba(143,179,212,0.5)";
      context.font = "500 10px Inter, system-ui, sans-serif";
      context.textAlign = "center";
      context.fillText(zone.name.toUpperCase(), center.x, center.y - radius - 6);
    }

    // dependency edges
    if (showEdges) {
      for (const edge of edges) {
        const source = nodeById.get(edge.source);
        const target = nodeById.get(edge.target);
        if (!source || !target) continue;
        const from = project(source, camera, size.width, size.height);
        const to = project(target, camera, size.width, size.height);
        const sourceImpact = impactByAsset.get(source.id);
        const targetImpact = impactByAsset.get(target.id);
        const compromised =
          sourceImpact?.impact_level === "failed" || targetImpact?.impact_level === "failed";
        const highlighted = selected === source.id || selected === target.id;

        context.beginPath();
        const midX = (from.x + to.x) / 2;
        const midY = (from.y + to.y) / 2 - 14 * camera.scale;
        context.moveTo(from.x, from.y);
        context.quadraticCurveTo(midX, midY, to.x, to.y);
        context.strokeStyle = compromised
          ? "rgba(255,107,107,0.7)"
          : highlighted
            ? "rgba(69,216,245,0.85)"
            : `rgba(143,179,212,${0.12 + edge.impact_weight * 0.25})`;
        context.lineWidth = (highlighted ? 2 : 1) * Math.min(2, camera.scale);
        if (edge.dependency_type === "water") context.setLineDash([5, 4]);
        context.stroke();
        context.setLineDash([]);

        // direction arrow
        const angle = Math.atan2(to.y - from.y, to.x - from.x);
        const arrowX = from.x + (to.x - from.x) * 0.62;
        const arrowY = from.y + (to.y - from.y) * 0.62;
        context.beginPath();
        context.moveTo(arrowX, arrowY);
        context.lineTo(
          arrowX - 6 * Math.cos(angle - 0.4) * Math.min(1, camera.scale),
          arrowY - 6 * Math.sin(angle - 0.4) * Math.min(1, camera.scale),
        );
        context.lineTo(
          arrowX - 6 * Math.cos(angle + 0.4) * Math.min(1, camera.scale),
          arrowY - 6 * Math.sin(angle + 0.4) * Math.min(1, camera.scale),
        );
        context.closePath();
        context.fillStyle = compromised ? "rgba(255,107,107,0.8)" : "rgba(143,179,212,0.55)";
        context.fill();
      }
    }

    // nodes
    for (const node of nodes) {
      const point = project(node, camera, size.width, size.height);
      const impact = impactByAsset.get(node.id);
      const radius = (4.5 + (6 - node.criticality) * 1.15) * Math.min(1.9, Math.max(0.75, camera.scale));
      const isSelected = selected === node.id;
      const isHovered = hovered === node.id;
      const color = impact ? IMPACT_COLOR[impact.impact_level] ?? STATUS_COLOR[node.status] : STATUS_COLOR[node.status] ?? "#4d6d8f";

      // halo / glow
      if (impact?.impact_level === "failed") {
        const pulse = 1 + 0.18 * Math.sin(Date.now() / 320);
        context.beginPath();
        context.arc(point.x, point.y, radius * 3 * pulse, 0, Math.PI * 2);
        context.fillStyle = "rgba(255,107,107,0.12)";
        context.fill();
      }
      if (isSelected || isHovered) {
        context.beginPath();
        context.arc(point.x, point.y, radius * 2.6, 0, Math.PI * 2);
        context.strokeStyle = isSelected ? "rgba(69,216,245,0.9)" : "rgba(69,216,245,0.45)";
        context.lineWidth = 1.5;
        context.stroke();
      }

      // isometric plinth
      const w = radius * 2.4;
      const h = radius * 1.4;
      context.beginPath();
      context.moveTo(point.x, point.y - h / 2);
      context.lineTo(point.x + w / 2, point.y);
      context.lineTo(point.x, point.y + h / 2);
      context.lineTo(point.x - w / 2, point.y);
      context.closePath();
      context.fillStyle = `${color}22`;
      context.strokeStyle = color;
      context.lineWidth = 1.4;
      context.fill();
      context.stroke();

      // tower
      const towerHeight = (node.load_percent / 100) * radius * 2.2 + 3;
      context.beginPath();
      context.moveTo(point.x - w / 4, point.y);
      context.lineTo(point.x - w / 4, point.y - towerHeight);
      context.lineTo(point.x, point.y - towerHeight + h / 4);
      context.lineTo(point.x + w / 4, point.y - towerHeight);
      context.lineTo(point.x + w / 4, point.y);
      context.closePath();
      context.fillStyle = `${color}44`;
      context.fill();
      context.strokeStyle = color;
      context.stroke();

      // status mark: the non-colour encoding of the same fact
      const statusKey = impact
        ? impact.impact_level === "failed"
          ? "offline"
          : impact.impact_level === "degraded"
            ? "degraded"
            : "operational"
        : node.status;
      const mark = STATUS_MARK[statusKey] ?? "none";
      if (mark !== "none") {
        const mx = point.x;
        const my = point.y - towerHeight / 2;
        context.save();
        context.strokeStyle = "rgba(4,11,24,0.85)";
        context.fillStyle = "rgba(4,11,24,0.85)";
        context.lineWidth = 1;
        if (mark === "cross") {
          context.beginPath();
          context.moveTo(mx - 2.2, my - 2.2);
          context.lineTo(mx + 2.2, my + 2.2);
          context.moveTo(mx + 2.2, my - 2.2);
          context.lineTo(mx - 2.2, my + 2.2);
          context.stroke();
        } else if (mark === "bar") {
          context.fillRect(mx - 2.6, my - 0.6, 5.2, 1.2);
        } else if (mark === "half") {
          context.beginPath();
          context.arc(mx, my, 2.2, 0, Math.PI, false);
          context.closePath();
          context.fill();
        } else if (mark === "dot") {
          context.beginPath();
          context.arc(mx, my, 1.3, 0, Math.PI * 2);
          context.fill();
        }
        context.restore();
      }

      // incident marker
      if (node.active_incidents > 0) {
        context.beginPath();
        context.arc(point.x + w * 0.72, point.y - towerHeight - 3, 3.4, 0, Math.PI * 2);
        context.fillStyle = "#ffb545";
        context.fill();
      }

      // label for selected / large nodes
      if (isSelected || isHovered || node.criticality <= 2) {
        context.font = "600 10px Inter, system-ui, sans-serif";
        context.textAlign = "center";
        context.fillStyle = "rgba(242,247,252,0.92)";
        context.fillText(node.code, point.x, point.y + h / 2 + 13);
      }
    }
  }, [camera, edges, graph?.zones, hovered, impactByAsset, nodeById, nodes, selected, showEdges, size]);

  /* -------------------------------------------------------------- pointer */
  const hitTest = useCallback(
    (clientX: number, clientY: number): TwinNode | null => {
      const canvas = canvasRef.current;
      if (!canvas) return null;
      const rect = canvas.getBoundingClientRect();
      const x = clientX - rect.left;
      const y = clientY - rect.top;
      let closest: TwinNode | null = null;
      let best = 22;
      for (const node of nodes) {
        const point = project(node, camera, size.width, size.height);
        const distance = Math.hypot(point.x - x, point.y - y);
        if (distance < best) {
          best = distance;
          closest = node;
        }
      }
      return closest;
    },
    [camera, nodes, project, size],
  );

  function handleWheel(event: React.WheelEvent<HTMLCanvasElement>) {
    event.preventDefault();
    const factor = event.deltaY > 0 ? 0.9 : 1.1;
    setCamera((cam) => ({ ...cam, scale: Math.min(3.2, Math.max(0.55, cam.scale * factor)) }));
  }

  function handlePointerDown(event: React.PointerEvent<HTMLCanvasElement>) {
    (event.target as HTMLCanvasElement).setPointerCapture(event.pointerId);
    dragState.current = { x: event.clientX, y: event.clientY, camX: camera.x, camY: camera.y };
    setDragging(true);
  }

  function handlePointerMove(event: React.PointerEvent<HTMLCanvasElement>) {
    const drag = dragState.current;
    if (drag) {
      setCamera((cam) => ({
        ...cam,
        x: drag.camX + (event.clientX - drag.x),
        y: drag.camY + (event.clientY - drag.y),
      }));
      return;
    }
    const hit = hitTest(event.clientX, event.clientY);
    setHovered(hit?.id ?? null);
  }

  function handlePointerUp(event: React.PointerEvent<HTMLCanvasElement>) {
    const drag = dragState.current;
    dragState.current = null;
    setDragging(false);
    if (!drag) return;
    const moved = Math.hypot(event.clientX - drag.x, event.clientY - drag.y);
    if (moved > 4) return;
    const hit = hitTest(event.clientX, event.clientY);
    setInternalSelected(hit?.id ?? null);
    onSelect?.(hit);
  }

  const resetView = () => setCamera({ x: 0, y: 0, scale: 1 });

  const legend = [
    { label: "Operational", color: STATUS_COLOR.operational, mark: STATUS_MARK.operational },
    { label: "Degraded", color: STATUS_COLOR.degraded, mark: STATUS_MARK.degraded },
    { label: "Offline", color: STATUS_COLOR.offline, mark: STATUS_MARK.offline },
    ...(impacts.length
      ? [
          { label: "Simulated failure", color: IMPACT_COLOR.failed, mark: STATUS_MARK.offline },
          { label: "Simulated impact", color: IMPACT_COLOR.affected, mark: STATUS_MARK.operational },
        ]
      : []),
  ];

  return (
    <div className={clsx("relative", className)}>
      <div
        ref={wrapRef}
        className="relative overflow-hidden rounded-2xl border border-white/10 bg-navy-950/70"
      >
        <canvas
          ref={canvasRef}
          className={clsx(
            "block w-full max-w-full touch-none",
            dragging ? "cursor-grabbing" : hovered ? "cursor-pointer" : "cursor-grab",
          )}
          style={{ height }}
          onWheel={handleWheel}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          role="img"
          aria-label={`Digital twin map of ${nodes.length} infrastructure assets across ${
            graph?.zones.length ?? 0
          } zones. Use the asset list below to navigate with a keyboard.`}
        />

        {loading ? (
          <div className="absolute inset-0 grid place-items-center bg-navy-950/60 backdrop-blur-sm">
            <p className="text-sm text-ink-300">Loading twin…</p>
          </div>
        ) : null}

        {!loading && nodes.length === 0 ? (
          <div className="absolute inset-0 grid place-items-center">
            <p className="max-w-xs text-center text-sm text-ink-400">
              No infrastructure is registered yet. Add assets to populate the digital twin.
            </p>
          </div>
        ) : null}

        {/* map controls */}
        <div className="absolute right-3 top-3 flex flex-col gap-1.5">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setCamera((cam) => ({ ...cam, scale: Math.min(3.2, cam.scale * 1.15) }))}
            aria-label="Zoom in"
          >
            <Plus className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setCamera((cam) => ({ ...cam, scale: Math.max(0.55, cam.scale * 0.87) }))}
            aria-label="Zoom out"
          >
            <Minus className="h-3.5 w-3.5" />
          </Button>
          <Button variant="secondary" size="sm" onClick={resetView} aria-label="Reset view">
            <RotateCcw className="h-3.5 w-3.5" />
          </Button>
        </div>

        <div className="absolute left-3 top-3 flex flex-wrap gap-1.5">
          <Badge tone="accent">
            <Layers className="h-3 w-3" /> {nodes.length} assets
          </Badge>
          <Badge>{edges.length} links</Badge>
          <Badge>
            <Crosshair className="h-3 w-3" /> drag to pan · scroll to zoom
          </Badge>
          <Badge>
            <Maximize2 className="h-3 w-3" /> {(camera.scale * 100).toFixed(0)}%
          </Badge>
        </div>

        <div
          className="absolute bottom-3 left-3 flex flex-wrap gap-2 rounded-xl border border-white/10 bg-navy-950/80 px-3 py-2 backdrop-blur"
          aria-label="Map legend: colour and mark"
        >
          {legend.map((item) => (
            <span key={item.label} className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-ink-400">
              <span
                className="relative flex h-3 w-3 items-center justify-center"
                aria-hidden
                title={MARK_LABEL[item.mark]}
              >
                <span className="h-2 w-2 rounded-full" style={{ backgroundColor: item.color }} />
                {item.mark === "cross" ? (
                  <span className="absolute text-[8px] leading-none text-navy-950">✕</span>
                ) : item.mark === "bar" ? (
                  <span className="absolute h-px w-2 bg-navy-950" />
                ) : item.mark === "half" ? (
                  <span className="absolute h-2 w-1 self-end rounded-l-full bg-navy-950/80" />
                ) : null}
              </span>
              {item.label}
            </span>
          ))}
        </div>
      </div>

      {/* keyboard-accessible equivalent of the canvas */}
      <AssetPicker nodes={nodes} selected={selected} onSelect={(node) => {
        setInternalSelected(node?.id ?? null);
        onSelect?.(node);
      }} />
    </div>
  );
}

function AssetPicker({
  nodes,
  selected,
  onSelect,
}: {
  nodes: TwinNode[];
  selected: number | null;
  onSelect: (node: TwinNode | null) => void;
}) {
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return nodes;
    return nodes.filter(
      (node) =>
        node.name.toLowerCase().includes(needle) ||
        node.code.toLowerCase().includes(needle) ||
        node.category.replace(/_/g, " ").includes(needle),
    );
  }, [nodes, query]);

  return (
    <div className="mt-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-ink-500">
          Keyboard asset navigator
        </p>
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Filter assets…"
          aria-label="Filter twin assets"
          className="input max-w-[220px] py-1.5 text-xs"
        />
      </div>
      <ul className="flex max-h-28 flex-wrap gap-1.5 overflow-y-auto scrollbar-slim" aria-label="Twin assets">
        {filtered.map((node) => {
          const Glyph = CATEGORY_GLYPH[node.category] ?? Building2;
          const active = selected === node.id;
          return (
            <li key={node.id}>
              <button
                type="button"
                onClick={() => onSelect(active ? null : node)}
                aria-pressed={active}
                className={clsx(
                  "flex items-center gap-1.5 rounded-lg border px-2 py-1 text-[11px] transition",
                  active
                    ? "border-accent/50 bg-accent/10 text-white"
                    : "border-white/10 bg-white/[0.03] text-ink-300 hover:border-accent/30 hover:text-white",
                )}
              >
                <Glyph className="h-3 w-3" />
                {node.code}
                <span
                  className="h-1.5 w-1.5 rounded-full"
                  style={{ backgroundColor: STATUS_COLOR[node.status] ?? "#4d6d8f" }}
                  aria-hidden
                />
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function ZoneSummary({ zones, nodes }: { zones: Zone[]; nodes: TwinNode[] }) {
  return (
    <Panel className="p-4">
      <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-ink-500">Zones</p>
      <ul className="mt-2 space-y-2">
        {zones.map((zone) => {
          const inZone = nodes.filter((node) => node.zone === zone.name);
          const offline = inZone.filter((node) => node.status === "offline").length;
          return (
            <li key={zone.id} className="flex items-center justify-between text-xs">
              <span className="text-ink-200">{zone.name}</span>
              <span className="flex items-center gap-2 text-ink-500">
                {inZone.length} assets
                {offline > 0 ? <span className="text-coral">{offline} down</span> : null}
              </span>
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}
