"use client";

/**
 * Zone risk map — the heatmap's visual surface.
 *
 * Drawn as a flat SVG rather than a canvas so the same DOM carries the data the
 * screen reader reads. Every zone is a real element with a label, its score and
 * its band; nothing about risk is conveyed by colour alone, because a colour-only
 * heatmap is unreadable to anyone with a colour vision deficiency and ambiguous
 * to everyone at the boundary between two bands.
 *
 * Zone geometry is derived from the assets inside it, so the map cannot drift
 * away from where the city's infrastructure actually is. A zone with no assets
 * is not drawn at all rather than drawn as a confident empty box.
 */

import { useMemo } from "react";
import clsx from "clsx";

const TOKEN_HEX: Record<string, string> = {
  mint: "#3ee6a5",
  accent: "#45d8f5",
  amber: "#ffb545",
  coral: "#ff6b6b",
  "coral-deep": "#ff8a5c",
};

export interface HeatZone {
  zone_id: number;
  code: string;
  name: string;
  district: string;
  population: number;
  center_x: number;
  center_y: number;
  risk_score: number;
  risk_band: string;
  asset_count: number;
  assets_failed: number;
  assets_degraded: number;
  population_at_risk: number;
  drivers: string[];
  top_assets: {
    asset_id: number;
    code: string;
    name: string;
    category: string;
    status: string;
    map_x: number;
    map_y: number;
    criticality: number;
    criticality_index: number;
    stored_impact: string | null;
    risk_score: number;
  }[];
  has_stored_impact: boolean;
}

export interface HeatAsset {
  asset_id: number;
  code: string;
  name: string;
  category: string;
  map_x: number;
  map_y: number;
  risk_score: number;
  risk_band: string;
  stored_impact: string | null;
  criticality_index: number;
}

export function tokenHex(token: string): string {
  return TOKEN_HEX[token] ?? "#7699ba";
}

/** Band colour for a score, read from the API's own legend. */
export function bandToken(
  score: number,
  legend: { threshold: number | null; color_token: string }[],
): string {
  for (const entry of legend) {
    if (entry.threshold !== null && score < entry.threshold) return entry.color_token;
  }
  return legend[legend.length - 1]?.color_token ?? "accent";
}

function zoneBox(assets: HeatAsset[], zone: HeatZone) {
  // Zone geometry comes from the assets inside it, matched by id, so a zone with
  // no assets is not drawn at all rather than drawn as a confident empty box.
  const points = assets.filter((asset) =>
    zone.top_assets.some((top) => top.asset_id === asset.asset_id),
  );
  if (points.length === 0) return null;
  const xs = points.map((point) => point.map_x);
  const ys = points.map((point) => point.map_y);
  // A minimum extent keeps a single-asset zone visible instead of collapsing to
  // a dot with a label hanging off it.
  const pad = 6;
  const x = Math.min(...xs) - pad;
  const y = Math.min(...ys) - pad;
  const width = Math.max(Math.max(...xs) - Math.min(...xs) + pad * 2, 22);
  const height = Math.max(Math.max(...ys) - Math.min(...ys) + pad * 2, 18);
  return { x, y, width, height };
}

export function ZoneRiskMap({
  zones,
  assets,
  legend,
  selectedZone,
  onSelect,
  height = 380,
}: {
  zones: HeatZone[];
  assets: HeatAsset[];
  legend: { threshold: number | null; color_token: string }[];
  selectedZone?: string | null;
  onSelect?: (zoneCode: string) => void;
  height?: number;
}) {
  const boxes = useMemo(
    () =>
      zones
        .map((zone) => ({ zone, box: zoneBox(assets, zone) }))
        .filter((entry): entry is { zone: HeatZone; box: NonNullable<ReturnType<typeof zoneBox>> } =>
          entry.box !== null,
        )
        .sort((a, b) => b.zone.risk_score - a.zone.risk_score),
    [zones, assets],
  );

  const maxY = Math.max(100, ...assets.map((asset) => asset.map_y));

  return (
    <div className="relative" style={{ height }}>
      <svg
        viewBox={`0 0 100 ${maxY}`}
        preserveAspectRatio="none"
        className="h-full w-full"
        role="img"
        aria-label={`Zone risk map, ${boxes.length} zones drawn from ${assets.length} assets`}
      >
        <defs>
          <pattern id="risk-grid" width="10" height="10" patternUnits="userSpaceOnUse">
            <path d="M 10 0 L 0 0 0 10" fill="none" stroke="rgba(120,170,210,0.10)" strokeWidth="0.25" />
          </pattern>
        </defs>
        <rect x="0" y="0" width="100" height={maxY} fill="url(#risk-grid)" />

        {boxes.map(({ zone, box }) => {
          const active = selectedZone === zone.code;
          const hex = tokenHex(bandToken(zone.risk_score, legend));
          return (
            <g
              key={zone.code}
              onClick={() => onSelect?.(zone.code)}
              className={onSelect ? "cursor-pointer" : undefined}
            >
              <rect
                x={box.x}
                y={box.y}
                width={box.width}
                height={box.height}
                rx="2.5"
                fill={hex}
                fillOpacity={active ? 0.34 : 0.16}
                stroke={hex}
                strokeOpacity={active ? 0.95 : 0.5}
                strokeWidth={active ? 0.7 : 0.35}
                // A dashed outline for a zone with no stored failure: it is an
                // estimate from criticality, not an observed impact, and the
                // legend must not be the only place that distinction lives.
                strokeDasharray={zone.has_stored_impact ? undefined : "1.5 1"}
              />
              <text
                x={box.x + box.width / 2}
                y={box.y + box.height / 2 - 1}
                textAnchor="middle"
                fontSize="2.6"
                fill="#f2f7fc"
                fontWeight="600"
                pointerEvents="none"
              >
                {zone.code}
              </text>
              <text
                x={box.x + box.width / 2}
                y={box.y + box.height / 2 + 3}
                textAnchor="middle"
                fontSize="2.2"
                fill={hex}
                pointerEvents="none"
              >
                {zone.risk_score.toFixed(0)} · {zone.risk_band}
              </text>
            </g>
          );
        })}

        {assets.map((asset) => (
          <circle
            key={asset.asset_id}
            cx={asset.map_x}
            cy={asset.map_y}
            r={asset.stored_impact === "failed" ? 1.15 : 0.7}
            fill={tokenHex(bandToken(asset.risk_score, legend))}
            stroke="#040b18"
            strokeWidth="0.2"
          />
        ))}
      </svg>

      {/* The same information as text, so colour is never the only encoding. */}
      <ul className="sr-only">
        {boxes.map(({ zone }) => (
          <li key={zone.code}>
            {zone.name} ({zone.code}): risk score {zone.risk_score.toFixed(0)}, band{" "}
            {zone.risk_band}. {zone.drivers.join(" ")}
            {zone.has_stored_impact
              ? ""
              : " No recorded failure in this zone; score is derived from asset criticality alone."}
          </li>
        ))}
      </ul>
    </div>
  );
}
