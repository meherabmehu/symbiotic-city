"use client";

/**
 * The 3D twin as the page sees it: canvas + controls + legend + accessible list.
 *
 * The page keeps owning selection and data fetching. This component owns the
 * presentation of the 3D view and -- importantly -- the *accessible equivalent*
 * of it: a keyboard-navigable list of every asset with its status in words, so
 * the twin is usable with a screen reader, without a pointer, and when WebGL is
 * missing entirely.
 */

import { useRef, useCallback, useMemo, useState, type ReactNode } from "react";
import { Box, Frame, Layers, Maximize2, Minimize2, RotateCcw, Video } from "lucide-react";
import {
  City3D,
  SCENARIO_LABELS,
  hasWebGL,
  type City3DOverlay,
  type Quality,
} from "@/components/city3d/city-3d";
import { CAMERA_MODES, STATUS_STYLES, type CameraMode } from "@/lib/city-model";
import type { SceneStats } from "@/components/city3d/scene-stats";
import type { TwinGraph, TwinNode } from "@/lib/types";
import { timeAgo } from "@/lib/format";
import { Button, Select } from "@/components/ui";

const QUALITY_LABELS: Record<Quality, string> = {
  high: "High (shadows)",
  balanced: "Balanced",
  low: "Low (fastest)",
};

const CAMERA_ICON: Record<CameraMode, React.ComponentType<{ className?: string }>> = {
  perspective: Box,
  isometric: Layers,
  top: Frame,
};

const LEGEND_FILTERS = [
  { value: "all", label: "All statuses" },
  { value: "operational", label: "Operational only" },
  { value: "degraded", label: "Degraded only" },
  { value: "offline", label: "Offline only" },
  { value: "maintenance", label: "In maintenance" },
];

export interface TwinViewProps {
  graph: TwinGraph | null;
  loading?: boolean;
  error?: string | null;
  overlay?: City3DOverlay;
  selectedId?: number | null;
  onSelect?: (node: TwinNode | null) => void;
  selectedZone?: string | null;
  height?: number;
  /** Active incidents, which decide whether emergency vehicles are drawn. */
  activeIncidents?: number;
  /**
   * Rendered between the viewport and the keyboard navigator -- the metric cards
   * the reference design parks directly beneath the city. Kept as a slot so this
   * component still owns everything that talks to the canvas, while the page
   * owns the data those cards read.
   */
  belowCanvas?: ReactNode;
}

export function TwinView({
  graph,
  loading,
  error,
  overlay,
  selectedId = null,
  onSelect,
  selectedZone = null,
  height = 560,
  activeIncidents = 0,
  belowCanvas,
}: TwinViewProps) {
  const [quality, setQuality] = useState<Quality>("balanced");
  const [mode, setMode] = useState<CameraMode>("perspective");
  const [focusId, setFocusId] = useState<number | null>(null);
  const [showTraffic, setShowTraffic] = useState(true);
  // The canvas overlays live *in* the viewport, so the switches that control
  // them live here too: a toggle outside the canvas that changes what is drawn
  // inside it is exactly the kind of split that left both sides out of sync.
  const [showEdges, setShowEdges] = useState(true);
  const [showZones, setShowZones] = useState(true);
  const [statusFilter, setStatusFilter] = useState("all");
  // A counter, not a boolean: pressing "Fit city" twice should fit twice.
  const [fitRequest, setFitRequest] = useState(0);
  // "Reset view" and Expand both mean "give me the default shot again" -- the
  // second at the new panel size -- so they share a reframe counter.
  const [resetRequest, setResetRequest] = useState(0);
  // What the last framing command asked for, so Expand can re-apply it at the
  // new panel size instead of silently swapping one intent for the other.
  const framingIntent = useRef<"fill" | "whole">("fill");
  const [stats, setStats] = useState<SceneStats | null>(null);
  const [showScenery, setShowScenery] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const [listOpen, setListOpen] = useState(false);
  const webgl = useMemo(() => hasWebGL(), []);

  // Filtering here rather than in the page keeps the legend, the navigator and
  // the canvas looking at exactly the same set of assets.
  const visibleGraph = useMemo<TwinGraph | null>(() => {
    if (!graph) return null;
    if (statusFilter === "all") return graph;
    return { ...graph, nodes: graph.nodes.filter((node) => node.status === statusFilter) };
  }, [graph, statusFilter]);

  const applyMode = useCallback((next: CameraMode) => {
    // A preset is a *direction*, and the raw preset distance was tuned for one
    // aspect ratio: at 1024 it crops, at 1920 it leaves gaps. So a preset click
    // also re-solves the distance for the viewport actually on screen --
    // immersive framing for the angled views, the whole grid for top-down.
    framingIntent.current = next === "top" ? "whole" : "fill";
    setMode(next);
    if (next === "top") setFitRequest((count) => count + 1);
    else setResetRequest((count) => count + 1);
  }, []);

  const resetView = useCallback(() => {
    setFocusId(null);
    framingIntent.current = "fill";
    setMode("perspective");
    setResetRequest((count) => count + 1);
  }, []);

  const select = useCallback(
    (node: TwinNode | null) => {
      onSelect?.(node);
      setFocusId(node?.id ?? null);
    },
    [onSelect],
  );

  const statusCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const node of visibleGraph?.nodes ?? []) {
      const visual = node.status === "offline" ? "failed" : node.status;
      counts[visual] = (counts[visual] ?? 0) + 1;
    }
    return counts;
  }, [visibleGraph]);

  if (!webgl) {
    return (
      <div className="space-y-3">
        <div
          className="rounded-2xl border border-dashed border-white/15 bg-navy-900/40 px-6 py-10 text-center"
          role="status"
        >
          <p className="text-sm font-semibold text-white">3D view unavailable on this device</p>
          <p className="mx-auto mt-2 max-w-md text-xs leading-relaxed text-ink-400">
            This browser did not provide a WebGL context. The accessible list below lists every
            asset with its status in words, and the 2D map on the failure lab draws the same graph.
            No action is lost.
          </p>
        </div>
        {/* The metric cards do not depend on WebGL, so they still render here. */}
        {belowCanvas}
        <AssetList graph={visibleGraph} selectedId={selectedId} onSelect={select} defaultOpen />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Control bar: one dark rail holding every viewport control, in the
          reference's composition -- camera and view actions on the left, quality
          and expand pinned right. Wraps rather than scrolls, so nothing is ever
          hidden behind a hover on a small screen. */}
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-white/10 bg-white/[0.03] px-2.5 py-2">
        <Select
          value={statusFilter}
          onChange={(event) => setStatusFilter(event.target.value)}
          aria-label="Filter twin by status"
          className="py-1.5 text-xs"
        >
          {LEGEND_FILTERS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </Select>

        <div className="flex items-center gap-1 rounded-lg border border-white/10 bg-navy-950/60 p-1">
          {(Object.keys(CAMERA_MODES) as CameraMode[]).map((key) => {
            const Icon = CAMERA_ICON[key];
            return (
              <button
                key={key}
                onClick={() => applyMode(key)}
                aria-pressed={mode === key}
                title={CAMERA_MODES[key].description}
                className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[11px] transition ${
                  mode === key ? "bg-accent/15 text-accent" : "text-ink-400 hover:bg-white/5 hover:text-ink-200"
                }`}
              >
                <Icon className="h-3.5 w-3.5" aria-hidden />
                {CAMERA_MODES[key].label}
              </button>
            );
          })}
        </div>

        <Button variant="secondary" size="sm" onClick={resetView}>
          <RotateCcw className="h-3.5 w-3.5" aria-hidden /> Reset view
        </Button>

        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            framingIntent.current = "whole";
            setFitRequest((value) => value + 1);
          }}
          title="Frame the whole city in the panel, whatever its size"
        >
          <Frame className="h-3.5 w-3.5" aria-hidden /> Fit city
        </Button>

        <Button
          variant={showTraffic ? "secondary" : "ghost"}
          size="sm"
          onClick={() => setShowTraffic((v) => !v)}
          aria-pressed={showTraffic}
        >
          <Video className="h-3.5 w-3.5" aria-hidden /> {showTraffic ? "Traffic on" : "Traffic off"}
        </Button>

        <Button
          variant={showScenery ? "secondary" : "ghost"}
          size="sm"
          onClick={() => setShowScenery((v) => !v)}
          aria-pressed={showScenery}
        >
          {showScenery ? "Scenery on" : "Scenery off"}
        </Button>

        <div className="ml-auto flex items-center gap-2">
          <Select
            value={quality}
            onChange={(event) => setQuality(event.target.value as Quality)}
            aria-label="3D quality"
            className="py-1.5 text-xs"
          >
            {(Object.keys(QUALITY_LABELS) as Quality[]).map((key) => (
              <option key={key} value={key}>
                {QUALITY_LABELS[key]}
              </option>
            ))}
          </Select>

          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setExpanded((v) => !v);
              // The panel just changed height: re-apply the last framing intent
              // at the new size. The bump is deferred two frames so the panel's
              // layout and the canvas's ResizeObserver have both landed first --
              // otherwise the solver reads the OLD aspect and "re-solves" the
              // distance the camera already has, which is not a reframe at all.
              requestAnimationFrame(() =>
                requestAnimationFrame(() => {
                  if (framingIntent.current === "whole") setFitRequest((count) => count + 1);
                  else setResetRequest((count) => count + 1);
                }),
              );
            }}
          >
            {expanded ? <Minimize2 className="h-3.5 w-3.5" aria-hidden /> : <Maximize2 className="h-3.5 w-3.5" aria-hidden />}
            {expanded ? "Fit panel" : "Expand"}
          </Button>
        </div>
      </div>

      {stats ? (
        <details data-testid="city3d-stats" className="overflow-hidden rounded-xl border border-white/10 bg-white/[0.02]">
          {/* The strip itself: the numbers a reference dashboard shows at a
              glance, always visible; the full breakdown stays one click away and
              collapsed, so the page reads clean and the detail is still there. */}
          <summary className="flex cursor-pointer list-none flex-wrap items-center justify-between gap-x-4 gap-y-1 px-3 py-2 text-[11px] text-ink-300 select-none hover:text-ink-100">
            <span className="flex items-center gap-2">
              <span aria-hidden className="text-accent">▶</span>
              <span>
                Scene cost: {stats.meshes} meshes · Draw calls: {stats.drawCalls.toLocaleString("en-US")} ·{" "}
                FPS: {stats.fps}
              </span>
            </span>
            <span className="flex items-center gap-3 text-[10px] text-ink-500">
              <span className="flex items-center gap-1.5">
                <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-mint" />
                Live sync
              </span>
              <span aria-hidden className="hidden h-3 w-px bg-white/10 sm:block" />
              <span className="hidden sm:inline">Last update: {timeAgo(graph?.generated_at)}</span>
            </span>
          </summary>
          <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-[10px] sm:grid-cols-4">
            {[
              ["Draw calls", String(stats.drawCalls)],
              ["Triangles", stats.triangles.toLocaleString("en-US")],
              ["Meshes", String(stats.meshes)],
              ["Instanced meshes", `${stats.instancedMeshes} (${stats.instances} instances)`],
              ["Materials", String(stats.materials)],
              ["Geometries", String(stats.geometries)],
              ["Textures", String(stats.textures)],
              ["Shaders", String(stats.programs)],
              ["JS heap", stats.heapMb == null ? "not exposed" : `${stats.heapMb} MB`],
              ["Frame rate", `${stats.fps} fps`],
            ].map(([label, value]) => (
              <div key={label} className="flex justify-between gap-2">
                <dt className="text-ink-600">{label}</dt>
                <dd className="font-mono text-ink-300">{value}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-2 text-[9px] leading-snug text-ink-600">
            Read from three.js&apos;s own renderer counters after the last drawn frame, in this
            browser. Frame rate is the only number that depends on your machine; the rest describe the
            scene. Heap is shown only where the browser exposes it.
          </p>
        </details>
      ) : null}

      {error ? (
        <p className="rounded-lg border border-coral/30 bg-coral/10 px-3 py-2 text-xs text-coral" role="alert">
          {error}
        </p>
      ) : null}

      <div className="relative overflow-hidden rounded-2xl border border-white/10 bg-navy-950">
        <City3D
          graph={visibleGraph}
          loading={loading}
          overlay={overlay}
          selectedId={selectedId}
          onSelect={select}
          showEdges={showEdges}
          showZones={showZones}
          selectedZone={selectedZone}
          showTraffic={showTraffic}
          showScenery={showScenery}
          activeIncidents={activeIncidents}
          fitRequest={fitRequest}
          resetRequest={resetRequest}
          onStats={setStats}
          onToggleZones={() => setShowZones((value) => !value)}
          onToggleEdges={() => setShowEdges((value) => !value)}
          quality={quality}
          mode={mode}
          onModeChange={applyMode}
          focusId={focusId}
          height={expanded ? Math.max(height, 720) : height}
        />

        {/* What kind of thing the overlay is, stated in words.
            A hypothetical cascade and a recorded one are the same geometry; only
            this badge distinguishes them, and confusing the two is the worst
            mistake this view can make. Top-centre so it clears both the tool
            rail on the left and the compass stack on the right. */}
        {overlay?.scenario && overlay.scenario !== "live" ? (
          <div
            data-testid="city3d-scenario-badge"
            className={`pointer-events-none absolute left-1/2 top-3 -translate-x-1/2 rounded-xl border px-3 py-2 text-center backdrop-blur ${
              overlay.scenario === "hypothetical"
                ? "border-amber/40 bg-amber/10"
                : overlay.scenario === "historical"
                  ? "border-white/15 bg-navy-950/85"
                  : "border-accent/40 bg-accent/10"
            }`}
          >
            <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-ink-300">
              {SCENARIO_LABELS[overlay.scenario].heading}
            </p>
            <p className="mt-0.5 max-w-[190px] text-[9px] leading-snug text-ink-400">
              {SCENARIO_LABELS[overlay.scenario].detail}
            </p>
          </div>
        ) : null}

        {/* The legend is DOM, not in-canvas: text stays crisp, it is selectable,
            and it is read by assistive technology without a canvas hook. */}
        <div
          data-testid="city3d-legend"
          className="pointer-events-none absolute bottom-3 left-3 rounded-xl border border-white/10 bg-navy-950/85 px-3 py-2 backdrop-blur"
        >
          <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-ink-500">
            Status
          </p>
          <ul className="space-y-1">
            {(["operational", "degraded", "failed", "maintenance", "recovering"] as const).map((key) => {
              const style = STATUS_STYLES[key];
              const count = statusCounts[key];
              return (
                <li key={key} className="flex items-center gap-2 text-[10px] text-ink-300">
                  <span className="inline-flex items-center gap-1">
                    <span
                      className="inline-block h-2 w-2 rounded-sm"
                      style={{ backgroundColor: style.color }}
                      aria-hidden
                    />
                    <StatusMarkGlyph mark={style.mark} color={style.color} />
                  </span>
                  {style.label}
                  {typeof count === "number" ? <span className="text-ink-500">· {count}</span> : null}
                </li>
              );
            })}
          </ul>
          <p className="mt-1.5 max-w-[190px] text-[9px] leading-snug text-ink-600">
            Each status carries a mark as well as a colour, so shape identifies it too.
          </p>
        </div>
      </div>

      <p className="text-[11px] text-ink-500">
        Drag to rotate · right-drag (or two fingers) to pan · wheel or pinch to zoom · click a
        building or a floating label to inspect it. The rail inside the viewport switches the left
        drag between orbit and pan; the presets above move the whole city.
      </p>

      {/* Metric cards, parked directly beneath the city the way the reference
          dashboard composes them. Owned by the page: they read data this
          component never sees. */}
      {belowCanvas}

      {/* The asset strip predates the 3D view and stays: it is the fastest path to
          a known asset by keyboard, and the chips carry status as a dot as well as
          the text in the list below. */}
      <AssetNavigator nodes={visibleGraph?.nodes ?? []} selected={selectedId} onSelect={select} />

      <AssetList graph={visibleGraph} selectedId={selectedId} onSelect={select} defaultOpen={listOpen} />
    </div>
  );
}

/* ------------------------------------------------------- asset navigator */

const CATEGORY_GLYPH: Record<string, React.ComponentType<{ className?: string }>> = {};

/**
 * Filterable chip strip of every asset.
 *
 * Kept from the 2D twin because it is the keyboard route to selection: type three
 * characters, tab to the chip, press Enter. The 3D canvas cannot offer that.
 */
export function AssetNavigator({
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
          const visual = node.status === "offline" ? "failed" : node.status;
          const style = STATUS_STYLES[visual as keyof typeof STATUS_STYLES] ?? STATUS_STYLES.operational;
          const active = selected === node.id;
          return (
            <li key={node.id}>
              <button
                type="button"
                onClick={() => onSelect(active ? null : node)}
                aria-pressed={active}
                title={`${node.code} · ${node.name} · ${style.label}`}
                className={`flex items-center gap-1.5 rounded-lg border px-2 py-1 text-[11px] transition ${
                  active
                    ? "border-accent/50 bg-accent/10 text-white"
                    : "border-white/10 bg-white/[0.03] text-ink-300 hover:border-accent/30 hover:text-white"
                }`}
              >
                {node.code}
                <span
                  className="h-1.5 w-1.5 rounded-full"
                  style={{ backgroundColor: style.color }}
                  aria-hidden
                />
                <span className="sr-only">{style.label}</span>
              </button>
            </li>
          );
        })}
        {filtered.length === 0 ? (
          <li className="px-1 py-2 text-[11px] text-ink-500">No asset matches “{query}”.</li>
        ) : null}
      </ul>
    </div>
  );
}

/** The shape that encodes a status, matching the 3D beacon above each building. */
function StatusMarkGlyph({ mark, color }: { mark: string; color: string }) {
  if (mark === "none") return null;
  if (mark === "cross") {
    return <span aria-hidden style={{ color }} className="text-[10px] leading-none">✕</span>;
  }
  if (mark === "bar") {
    return <span aria-hidden style={{ color }} className="text-[10px] leading-none">▬</span>;
  }
  if (mark === "half") {
    return <span aria-hidden style={{ color }} className="text-[10px] leading-none">◐</span>;
  }
  return <span aria-hidden style={{ color }} className="text-[10px] leading-none">●</span>;
}

/**
 * Keyboard-navigable asset list.
 *
 * This is the twin's accessible equivalent, not a decoration: every asset is
 * reachable, its status is spoken in words, and choosing one moves the camera.
 */
export function AssetList({
  graph,
  selectedId,
  onSelect,
  defaultOpen = false,
}: {
  graph: TwinGraph | null;
  selectedId?: number | null;
  onSelect?: (node: TwinNode) => void;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const nodes = graph?.nodes ?? [];

  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.02]">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center justify-between px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-400 hover:text-ink-200"
      >
        Accessible asset list ({nodes.length})
        <span aria-hidden className="text-ink-600">{open ? "−" : "+"}</span>
      </button>
      {open ? (
        <ul className="max-h-64 overflow-y-auto border-t border-white/5 px-2 py-2">
          {nodes.length === 0 ? (
            <li className="px-2 py-3 text-[11px] text-ink-500">No assets loaded yet.</li>
          ) : (
            nodes.map((node) => {
              const visual = node.status === "offline" ? "failed" : node.status;
              const style = STATUS_STYLES[visual as keyof typeof STATUS_STYLES] ?? STATUS_STYLES.operational;
              const isSelected = node.id === selectedId;
              return (
                <li key={node.id}>
                  <button
                    onClick={() => onSelect?.(node)}
                    aria-current={isSelected ? "true" : undefined}
                    className={`flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left text-[11px] transition ${
                      isSelected ? "bg-accent/15 text-white" : "text-ink-300 hover:bg-white/5"
                    }`}
                  >
                    <span className="truncate">
                      <span className="font-mono text-[10px] text-ink-500">{node.code}</span> {node.name}
                    </span>
                    <span className="shrink-0 text-[10px]" style={{ color: style.color }}>
                      {style.label} · {style.markLabel}
                    </span>
                  </button>
                </li>
              );
            })
          )}
        </ul>
      ) : null}
    </div>
  );
}
