"use client";

/**
 * Recharts wrappers with the SYMBIOTIC CITY palette. Every chart includes an
 * accessible text summary so data is not conveyed by colour alone.
 */

import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  PolarAngleAxis,
  PolarGrid,
  Radar,
  RadarChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

// Axis ticks are 9-10px, so they get no large-text allowance: these are the
// AA-clearing ink-300/ink-500 values from tailwind.config.ts, not the old
// #4d6d8f (2.6:1 on a raised glass row) and #8fb3d4.
const AXIS = { stroke: "#7699ba", fontSize: 10 };
const GRID = "#12314d";
const TOOLTIP = {
  contentStyle: {
    background: "rgba(6,18,37,0.96)",
    border: "1px solid rgba(164,194,222,0.2)",
    borderRadius: 12,
    fontSize: 12,
    color: "#f2f7fc",
  },
  labelStyle: { color: "#a4c2de", fontSize: 11, marginBottom: 4 },
  itemStyle: { color: "#f2f7fc" },
};

export const PALETTE = ["#45d8f5", "#3ee6a5", "#ffb545", "#ff6b6b", "#8b7cf6", "#4d9fff"];

export function TrendAreaChart({
  data,
  series,
  height = 240,
  summary,
}: {
  data: Record<string, string | number>[];
  series: { key: string; label: string; color: string }[];
  height?: number;
  summary: string;
}) {
  return (
    <figure>
      <div style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 6, right: 8, left: -18, bottom: 0 }}>
            <defs>
              {series.map((item) => (
                <linearGradient key={item.key} id={`grad-${item.key}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={item.color} stopOpacity={0.32} />
                  <stop offset="100%" stopColor={item.color} stopOpacity={0} />
                </linearGradient>
              ))}
            </defs>
            <CartesianGrid stroke={GRID} strokeDasharray="3 4" vertical={false} />
            <XAxis dataKey="date" tick={{ ...AXIS }} tickLine={false} axisLine={false} />
            <YAxis tick={{ ...AXIS }} tickLine={false} axisLine={false} allowDecimals={false} />
            <Tooltip {...TOOLTIP} />
            <Legend wrapperStyle={{ fontSize: 11, color: "#a4c2de" }} />
            {series.map((item) => (
              <Area
                key={item.key}
                type="monotone"
                dataKey={item.key}
                name={item.label}
                stroke={item.color}
                strokeWidth={2}
                fill={`url(#grad-${item.key})`}
              />
            ))}
          </AreaChart>
        </ResponsiveContainer>
      </div>
      <figcaption className="sr-only">{summary}</figcaption>
    </figure>
  );
}

export function ComparisonBarChart({
  data,
  bars,
  xKey,
  height = 260,
  summary,
  stacked,
}: {
  data: Record<string, string | number>[];
  bars: { key: string; label: string; color: string }[];
  xKey: string;
  height?: number;
  summary: string;
  stacked?: boolean;
}) {
  return (
    <figure>
      <div style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 6, right: 8, left: -18, bottom: 0 }}>
            <CartesianGrid stroke={GRID} strokeDasharray="3 4" vertical={false} />
            <XAxis dataKey={xKey} tick={{ ...AXIS }} tickLine={false} axisLine={false} interval={0} />
            <YAxis tick={{ ...AXIS }} tickLine={false} axisLine={false} />
            <Tooltip {...TOOLTIP} cursor={{ fill: "rgba(69,216,245,0.06)" }} />
            <Legend wrapperStyle={{ fontSize: 11, color: "#a4c2de" }} />
            {bars.map((bar) => (
              <Bar
                key={bar.key}
                dataKey={bar.key}
                name={bar.label}
                fill={bar.color}
                stackId={stacked ? "a" : undefined}
                radius={stacked ? 0 : [4, 4, 0, 0]}
                maxBarSize={38}
              />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
      <figcaption className="sr-only">{summary}</figcaption>
    </figure>
  );
}

export function LineTrend({
  data,
  series,
  xKey = "date",
  height = 240,
  summary,
}: {
  data: Record<string, string | number>[];
  series: { key: string; label: string; color: string; dashed?: boolean }[];
  xKey?: string;
  height?: number;
  summary: string;
}) {
  return (
    <figure>
      <div style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 6, right: 8, left: -18, bottom: 0 }}>
            <CartesianGrid stroke={GRID} strokeDasharray="3 4" vertical={false} />
            <XAxis dataKey={xKey} tick={{ ...AXIS }} tickLine={false} axisLine={false} />
            <YAxis tick={{ ...AXIS }} tickLine={false} axisLine={false} />
            <Tooltip {...TOOLTIP} />
            <Legend wrapperStyle={{ fontSize: 11, color: "#a4c2de" }} />
            {series.map((item) => (
              <Line
                key={item.key}
                type="monotone"
                dataKey={item.key}
                name={item.label}
                stroke={item.color}
                strokeWidth={2}
                strokeDasharray={item.dashed ? "5 4" : undefined}
                dot={{ r: 2.5, fill: item.color, strokeWidth: 0 }}
                activeDot={{ r: 4 }}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
      <figcaption className="sr-only">{summary}</figcaption>
    </figure>
  );
}

export function StatusDonut({
  data,
  height = 220,
  label,
}: {
  data: { name: string; value: number; color: string }[];
  height?: number;
  label: string;
}) {
  const total = data.reduce((sum, item) => sum + item.value, 0);
  return (
    <figure className="relative">
      <div style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={data}
              dataKey="value"
              nameKey="name"
              innerRadius="62%"
              outerRadius="88%"
              paddingAngle={2}
              stroke="none"
            >
              {data.map((item) => (
                <Cell key={item.name} fill={item.color} />
              ))}
            </Pie>
            <Tooltip {...TOOLTIP} />
          </PieChart>
        </ResponsiveContainer>
      </div>
      <figcaption className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
        <span className="font-display text-2xl font-semibold text-white">{total}</span>
        <span className="text-[10px] uppercase tracking-[0.16em] text-ink-500">{label}</span>
      </figcaption>
      <ul className="sr-only">
        {data.map((item) => (
          <li key={item.name}>
            {item.name}: {item.value}
          </li>
        ))}
      </ul>
    </figure>
  );
}

export function CoverageRadar({
  data,
  height = 240,
  summary,
}: {
  data: { subject: string; value: number }[];
  height?: number;
  summary: string;
}) {
  return (
    <figure>
      <div style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          <RadarChart data={data} outerRadius="72%">
            <PolarGrid stroke={GRID} />
            <PolarAngleAxis dataKey="subject" tick={{ fill: "#a4c2de", fontSize: 9 }} />
            <Radar dataKey="value" stroke="#45d8f5" fill="#45d8f5" fillOpacity={0.22} />
            <Tooltip {...TOOLTIP} />
          </RadarChart>
        </ResponsiveContainer>
      </div>
      <figcaption className="sr-only">{summary}</figcaption>
    </figure>
  );
}
