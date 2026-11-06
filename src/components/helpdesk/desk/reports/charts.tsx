"use client";

// Desk reports (1.19.0): the hand-rolled charts behind every widget
// (STYLEGUIDE §Desk reports and charts; the dataviz method). One axis,
// thin marks (2px lines, bars at most 0.75rem thick with a 4px rounded
// data end, a 2px surface gap between touching marks), recessive solid
// hairline grids, values in text tokens never the series colour, a legend
// for two or more series, and the hover layer on every plot: real buttons
// over the marks with a roving tabindex (Tab lands once, arrows walk the
// points), each carrying its house data-tt tooltip and aria-label, and a
// click that drills into the matching tickets. Each chart also renders an
// sr-only table; the widget offers "Show as table" for everyone.
//
// Colour: slot 1 is the workspace accent; slots 2 to 8 the validated
// categorical order in charts.module.css. A series keeps its slot while
// filters change the others (slots follow the key, not the rank).

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { CircleAlert, CircleCheck, Minus, TrendingDown, TrendingUp, TriangleAlert } from "lucide-react";
import { Table, Td, Th, TABLE_HEAD_ROW, TR, type SortDir } from "@/components/Table";
import { initialsOf } from "@/components/UserAvatar";
import {
  HD_COMPARE_LABEL,
  HD_DIMENSIONS,
  HD_MEASURES,
  WEEKDAY_SHORT,
  deltaTone,
  formatDelta,
  formatValue,
  targetState,
  type HdDimension,
  type HdKey,
  type HdMeasureDef,
  type HdQueryResult,
  type HdResultRow,
  type HdTarget,
} from "@/lib/helpdesk/analytics/shared";
import css from "./charts.module.css";

export const VIZ_CLASS = css.viz;

// --- Helpers -----------------------------------------------------------------------------

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "3 Nov", "w/c 3 Nov", "Nov 2026" for time keys; the label otherwise. */
export function keyLabel(dim: HdDimension, key: HdKey, label: string, long = false): string {
  if (typeof key !== "string") return label;
  if (dim === "day" || dim === "week") {
    const [y, m, d] = key.split("-").map(Number);
    const s = `${d} ${MONTHS[m - 1]}${long ? ` ${y}` : ""}`;
    return dim === "week" ? `w/c ${s}` : s;
  }
  if (dim === "month") {
    const [y, m] = key.split("-").map(Number);
    return `${MONTHS[m - 1]} ${y}`;
  }
  return label;
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

// Dimensions with a small fixed set of values keep a fixed colour each.
const FIXED_SLOT: Partial<Record<HdDimension, Record<string, number>>> = {
  priority: { low: 3, normal: 1, high: 4, urgent: 8 },
  channel: { portal: 1, email: 2, desk: 3, trigger: 7, workflow: 5, alert: 8, api: 6 },
  status: { new: 7, open: 1, pending: 4, on_hold: 5, solved: 3, closed: 6 },
  origin: { people: 1, automated: 2 },
  vip: { yes: 2, no: 1 },
};

/** A colour slot (1–8) per series key, stable across filters: priorities fixed, others by hash with the next free slot. */
export function assignSlots(dim: HdDimension | undefined, keys: HdKey[]): Map<string, string> {
  const out = new Map<string, string>();
  const used = new Set<number>();
  const sorted = [...keys].map((k) => String(k)).sort();
  for (const k of sorted) {
    if (k === "__other__") {
      out.set(k, "var(--s-other)");
      continue;
    }
    const fixed = dim ? FIXED_SLOT[dim]?.[k] : undefined;
    let slot = fixed ?? (hash(k) % 8) + 1;
    for (let i = 0; i < 8 && used.has(slot); i++) slot = (slot % 8) + 1;
    used.add(slot);
    out.set(k, `var(--s${slot})`);
  }
  return out;
}

/** A clean axis top with four equal steps (0, ¼, ½, ¾, 1), whole numbers for counts. */
function niceMax(max: number, unit: HdQueryResult["unit"]): number {
  if (unit === "percent") return 100;
  if (max <= 0) return unit === "minutes" ? 60 : 4;
  if (unit === "minutes") {
    const steps = [15, 30, 60, 120, 240, 480, 960, 1440, 2880, 5760, 11520, 23040];
    return steps.find((s) => s >= max) ?? Math.ceil(max / 1440) * 1440;
  }
  const raw = max / 4;
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const ms = unit === "count" ? [1, 2, 3, 4, 5, 6, 8, 10] : [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];
  for (const m of ms) {
    const step = m * pow;
    if (unit === "count" && step < 1) continue;
    if (step >= raw) return step * 4;
  }
  return 40 * pow;
}

function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(el.clientWidth);
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

/** Roving focus over a row of hit targets: one tab stop, arrows walk, Home/End jump. */
function useRoving(count: number) {
  const [focus, setFocus] = useState(0);
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  useEffect(() => {
    if (focus >= count) setFocus(Math.max(0, count - 1));
  }, [count, focus]);
  const onKeyDown = (e: React.KeyboardEvent, i: number, cols = count) => {
    let next = -1;
    if (e.key === "ArrowRight") next = Math.min(count - 1, i + 1);
    else if (e.key === "ArrowLeft") next = Math.max(0, i - 1);
    else if (e.key === "ArrowDown" && cols < count) next = Math.min(count - 1, i + cols);
    else if (e.key === "ArrowUp" && cols < count) next = Math.max(0, i - cols);
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = count - 1;
    if (next < 0) return;
    e.preventDefault();
    setFocus(next);
    refs.current[next]?.focus();
  };
  return { focus, setFocus, refs, onKeyDown };
}

/** Drill-downs open the queue in the desk without a full page load. */
function useGo(): (href: string) => void {
  const router = useRouter();
  return (href) => router.push(href);
}

function SrTable({ result, caption }: { result: HdQueryResult; caption: string }) {
  const def: HdMeasureDef = HD_MEASURES[result.measure];
  return (
    <table className="sr-only">
      <caption>{caption}</caption>
      <thead>
        <tr>
          {result.groupBy.map((g) => (
            <th key={g} scope="col">
              {HD_DIMENSIONS[g].label}
            </th>
          ))}
          <th scope="col">{def.label}</th>
        </tr>
      </thead>
      <tbody>
        {result.rows.map((r, i) => (
          <tr key={i}>
            {r.labels.map((l, j) => (
              <td key={j}>{keyLabel(result.groupBy[j], r.keys[j], l, true)}</td>
            ))}
            <td>{formatValue(r.value, result.unit)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export type DrillFn = ((keys: HdKey[]) => string | null) | null;

function Legend({ items }: { items: { key: string; label: string; color: string; dashed?: boolean }[] }) {
  return (
    <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-600" aria-label="Legend">
      {items.map((i) => (
        <li key={i.key} className="inline-flex items-center gap-1.5">
          {i.dashed ? (
            <svg width="16" height="8" aria-hidden className="shrink-0">
              <line x1="0" x2="16" y1="4" y2="4" stroke={i.color} strokeWidth="2" strokeDasharray="4 3" />
            </svg>
          ) : (
            <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: i.color }} aria-hidden />
          )}
          {i.label}
        </li>
      ))}
    </ul>
  );
}

// --- KPI tile ------------------------------------------------------------------------------

export function Delta({ result }: { result: HdQueryResult }) {
  const c = result.compare;
  if (!c) return null;
  const def: HdMeasureDef = HD_MEASURES[result.measure];
  if (c.delta === null) return <span className="text-xs text-slate-500">{HD_COMPARE_LABEL[c.kind]}: no figure to compare</span>;
  if (Math.abs(c.delta) < (result.unit === "minutes" ? 1 : 0.05))
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-slate-600">
        <Minus className="h-3.5 w-3.5" aria-hidden /> Same as {HD_COMPARE_LABEL[c.kind].toLowerCase()}
      </span>
    );
  const tone = deltaTone(c.delta, def.good);
  const Icon = c.delta > 0 ? TrendingUp : c.delta < 0 ? TrendingDown : Minus;
  const ink = tone === "good" ? "ink-ok" : tone === "bad" ? "text-red-600" : "text-slate-600";
  const word = tone === "good" ? "better" : tone === "bad" ? "worse" : "";
  return (
    <span className="inline-flex flex-wrap items-center gap-x-1.5 text-xs">
      <span className={`inline-flex items-center gap-0.5 font-semibold ${ink}`}>
        <Icon className="h-3.5 w-3.5" aria-hidden />
        {formatDelta(c.delta, c.delta_pct, result.unit) || "±0"}
        {word && <span className="sr-only"> ({word})</span>}
      </span>
      <span className="text-slate-500">vs {HD_COMPARE_LABEL[c.kind].toLowerCase()}</span>
    </span>
  );
}

export function TargetNote({ value, target, result }: { value: number | null; target: HdTarget | null | undefined; result: HdQueryResult }) {
  const def: HdMeasureDef = HD_MEASURES[result.measure];
  const st = targetState(value, target, def.good);
  if (!st || !target) return null;
  const goal = `${def.good === "down" ? "at most" : "at least"} ${formatValue(target.value, result.unit)}`;
  if (st === "met")
    return (
      <span className="inline-flex items-center gap-1 text-xs ink-ok">
        <CircleCheck className="h-3.5 w-3.5" aria-hidden /> On target ({goal})
      </span>
    );
  if (st === "close")
    return (
      <span className="inline-flex items-center gap-1 text-xs ink-warn">
        <TriangleAlert className="h-3.5 w-3.5" aria-hidden /> Close to target ({goal})
      </span>
    );
  return (
    <span className="inline-flex items-center gap-1 text-xs text-red-600">
      <CircleAlert className="h-3.5 w-3.5" aria-hidden /> Off target ({goal})
    </span>
  );
}

export function Sparkline({ rows, label }: { rows: HdResultRow[]; label: string }) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const vals = rows.map((r) => r.value);
  const nums = vals.filter((v): v is number => v !== null);
  if (nums.length < 2) return <div ref={ref} className="h-8" aria-hidden />;
  const h = 32;
  const max = Math.max(...nums, 1);
  const min = Math.min(0, ...nums);
  const x = (i: number) => (vals.length <= 1 ? 0 : (i / (vals.length - 1)) * Math.max(1, w - 6) + 3);
  const y = (v: number) => h - 3 - ((v - min) / (max - min || 1)) * (h - 6);
  let d = "";
  vals.forEach((v, i) => {
    if (v === null) return;
    d += `${d && vals[i - 1] !== null ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
  });
  const lastI = vals.length - 1 - [...vals].reverse().findIndex((v) => v !== null);
  return (
    <div ref={ref} className="mt-3 h-8" role="img" aria-label={label}>
      {w > 0 && (
        <svg width={w} height={h} aria-hidden>
          <path d={d} fill="none" stroke="var(--axis)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
          <circle cx={x(lastI)} cy={y(vals[lastI]!)} r="4" fill="var(--s1)" className={css.gapStroke} />
        </svg>
      )}
    </div>
  );
}

export function KpiTile({ result, target, spark, live }: { result: HdQueryResult; target?: HdTarget | null; spark?: HdResultRow[] | null; live?: boolean }) {
  const def: HdMeasureDef = HD_MEASURES[result.measure];
  return (
    <div className={css.viz}>
      <p className="text-3xl font-semibold tracking-tight text-slate-900">{formatValue(result.total.value, result.unit, { compact: true })}</p>
      <div className="mt-1 flex min-h-5 flex-wrap items-center gap-x-3 gap-y-1">
        {live ? <span className="text-xs text-slate-500">Right now · refreshes every minute</span> : <Delta result={result} />}
        {result.low_sample && <span className="text-xs text-slate-500">Based on {result.total.n}</span>}
      </div>
      {target && (
        <div className="mt-1">
          <TargetNote value={result.total.value} target={target} result={result} />
        </div>
      )}
      {spark && spark.length > 1 && <Sparkline rows={spark} label={`${def.label} trend: ${spark.map((r) => formatValue(r.value, result.unit)).join(", ")}`} />}
    </div>
  );
}

// --- Gauge ------------------------------------------------------------------------------------

export function Gauge({ result, target }: { result: HdQueryResult; target?: HdTarget | null }) {
  const def: HdMeasureDef = HD_MEASURES[result.measure];
  const v = result.total.value;
  const st = targetState(v, target, def.good);
  const fill = st === "missed" ? "bg-red-500" : st === "close" ? "bg-amber-500" : "bg-compass-600";
  return (
    <div className={css.viz}>
      <p className="text-3xl font-semibold tracking-tight text-slate-900">{formatValue(v, "percent")}</p>
      <div
        className="relative mt-3 h-2 rounded-full bg-compass-100"
        role="meter"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={v ?? 0}
        aria-label={`${def.label}: ${formatValue(v, "percent")}${target ? `, target ${formatValue(target.value, "percent")}` : ""}`}
      >
        <div className={`h-full rounded-full ${fill}`} style={{ width: `${Math.max(0, Math.min(100, v ?? 0))}%` }} />
        {target && <div className="absolute -top-1 h-4 w-0.5 rounded-full bg-slate-700" style={{ left: `calc(${target.value}% - 1px)` }} aria-hidden />}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
        <TargetNote value={v} target={target} result={result} />
        <Delta result={result} />
        <span className="text-xs text-slate-500">of {result.total.n.toLocaleString("en-GB")}</span>
      </div>
    </div>
  );
}

// --- Time series (line, area, stacked columns) -----------------------------------------------

interface Series {
  key: string;
  label: string;
  color: string;
  values: (number | null)[];
  dashed?: boolean;
}

function seriesOf(result: HdQueryResult): { xKeys: HdKey[]; xLabels: string[]; series: Series[] } {
  const dim = result.groupBy[0];
  const xKeys: HdKey[] = [];
  const xLabels: string[] = [];
  const xIndex = new Map<string, number>();
  for (const r of result.rows) {
    const k = JSON.stringify(r.keys[0]);
    if (!xIndex.has(k)) {
      xIndex.set(k, xKeys.length);
      xKeys.push(r.keys[0]);
      xLabels.push(keyLabel(dim, r.keys[0], r.labels[0]));
    }
  }
  if (result.groupBy.length === 1) {
    return {
      xKeys,
      xLabels,
      series: [{ key: "main", label: HD_MEASURES[result.measure].label, color: "var(--s1)", values: result.rows.map((r) => r.value) }],
    };
  }
  const second = result.groupBy[1];
  const byKey = new Map<string, Series>();
  const slots = assignSlots(second, [...new Set(result.rows.map((r) => r.keys[1]))]);
  for (const r of result.rows) {
    const sk = String(r.keys[1]);
    let s = byKey.get(sk);
    if (!s) {
      s = { key: sk, label: r.labels[1], color: slots.get(sk) ?? "var(--s1)", values: xKeys.map(() => null) };
      byKey.set(sk, s);
    }
    s.values[xIndex.get(JSON.stringify(r.keys[0]))!] = r.value;
  }
  // Largest series first in the legend, "Other" last.
  const total = (s: Series) => s.values.reduce<number>((a, v) => a + (v ?? 0), 0);
  const series = [...byKey.values()].sort((a, b) => (a.key === "__other__" ? 1 : b.key === "__other__" ? -1 : total(b) - total(a)));
  return { xKeys, xLabels, series };
}

const PAD = { l: 44, r: 12, t: 12, b: 24 };

export function TimeChart({
  result,
  kind,
  target,
  drill,
  height = 200,
}: {
  result: HdQueryResult;
  kind: "line" | "area" | "stacked";
  target?: HdTarget | null;
  drill: DrillFn;
  height?: number;
}) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const { xKeys, xLabels, series } = useMemo(() => seriesOf(result), [result]);
  const compare =
    kind !== "stacked" && result.compare?.rows && result.groupBy.length === 1
      ? { key: "compare", label: HD_COMPARE_LABEL[result.compare.kind], color: "var(--s-compare)", values: result.compare.rows.map((r) => r.value), dashed: true }
      : null;
  const n = xKeys.length;
  const roving = useRoving(n);
  const [hover, setHover] = useState<number | null>(null);
  const [focused, setFocused] = useState(false);
  const go = useGo();
  const active = hover ?? (focused ? roving.focus : null);

  const stackTotals = xKeys.map((_, i) => series.reduce((a, s) => a + (s.values[i] ?? 0), 0));
  const rawMax =
    kind === "stacked"
      ? Math.max(0, ...stackTotals)
      : Math.max(0, ...series.flatMap((s) => s.values.map((v) => v ?? 0)), ...(compare?.values.map((v) => v ?? 0) ?? []), target?.value ?? 0);
  const max = niceMax(rawMax, result.unit);
  const innerW = Math.max(10, w - PAD.l - PAD.r);
  const innerH = height - PAD.t - PAD.b;
  const band = innerW / Math.max(1, n);
  const x = (i: number) => (kind === "stacked" ? PAD.l + band * i + band / 2 : PAD.l + (n <= 1 ? innerW / 2 : (i / (n - 1)) * innerW));
  const y = (v: number) => PAD.t + innerH - (Math.max(0, v) / max) * innerH;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => max * f);
  const tickLabel = (v: number) => formatValue(v, result.unit, { compact: true });
  const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(innerW / 72))));
  // Every nth label and always the latest; the nth label nearest the end gives way when it would collide with it.
  const lastLabelled = Math.floor((n - 1) / every) * every;
  const crowded = n - 1 - lastLabelled < every * 0.75;
  const showLabel = (i: number) => i === n - 1 || (i % every === 0 && !(i === lastLabelled && crowded && i !== 0));

  const path = (vals: (number | null)[]) => {
    let d = "";
    vals.forEach((v, i) => {
      if (v === null) return;
      d += `${d && vals[i - 1] !== null && vals[i - 1] !== undefined ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
    });
    return d;
  };
  const tip = (i: number) => {
    const parts = series.map((s) => `${series.length > 1 ? `${s.label}: ` : ""}${formatValue(s.values[i], result.unit)}`);
    if (compare && compare.values[i] !== undefined) parts.push(`${compare.label}: ${formatValue(compare.values[i], result.unit)}`);
    return `${keyLabel(result.groupBy[0], xKeys[i], xLabels[i], true)}: ${parts.join(" · ")}`;
  };
  const barW = Math.min(12, Math.max(2, band - 4));

  return (
    <div className={css.viz}>
      <div ref={ref} className="relative" style={{ height }}>
        {w > 0 && (
          <svg width={w} height={height} aria-hidden className="block">
            {ticks.map((t) => (
              <g key={t}>
                <line x1={PAD.l} x2={w - PAD.r} y1={y(t)} y2={y(t)} stroke="var(--grid)" strokeWidth="1" />
                <text x={PAD.l - 6} y={y(t) + 3.5} textAnchor="end" fontSize="10" fill="var(--tick)" className="tabular-nums">
                  {tickLabel(t)}
                </text>
              </g>
            ))}
            <line x1={PAD.l} x2={w - PAD.r} y1={y(0)} y2={y(0)} stroke="var(--axis)" strokeWidth="1" />
            {xKeys.map((_, i) =>
              showLabel(i) ? (
                <text key={i} x={x(i)} y={height - 6} textAnchor={i === 0 && kind !== "stacked" ? "start" : i === n - 1 && kind !== "stacked" ? "end" : "middle"} fontSize="10" fill="var(--tick)">
                  {xLabels[i]}
                </text>
              ) : null
            )}
            {target && result.unit !== "count" && (
              <g>
                <line x1={PAD.l} x2={w - PAD.r} y1={y(target.value)} y2={y(target.value)} stroke="var(--tick)" strokeWidth="1" strokeDasharray="2 3" />
                <text x={w - PAD.r} y={y(target.value) - 4} textAnchor="end" fontSize="10" fill="var(--tick)">
                  Target {formatValue(target.value, result.unit)}
                </text>
              </g>
            )}
            {active !== null && <line x1={x(active)} x2={x(active)} y1={PAD.t} y2={PAD.t + innerH} stroke="var(--axis)" strokeWidth="1" />}
            {kind === "stacked"
              ? xKeys.map((_, i) => {
                  let acc = 0;
                  return (
                    <g key={i} opacity={active === null || active === i ? 1 : 0.55}>
                      {series.map((s, si) => {
                        const v = s.values[i] ?? 0;
                        if (v <= 0) return null;
                        const top = y(acc + v);
                        const bottom = y(acc);
                        acc += v;
                        const hgt = Math.max(0, bottom - top - (si === 0 ? 0 : 2));
                        return <rect key={s.key} x={x(i) - barW / 2} y={top} width={barW} height={hgt} rx={si === series.length - 1 || acc === stackTotals[i] ? 2 : 0} fill={s.color} />;
                      })}
                    </g>
                  );
                })
              : (
                <>
                  {compare && <path d={path(compare.values)} fill="none" stroke={compare.color} strokeWidth="2" strokeDasharray="4 3" strokeLinejoin="round" />}
                  {series.map((s) => (
                    <g key={s.key}>
                      {kind === "area" && series.length === 1 && (
                        <path d={`${path(s.values)} L${x(n - 1).toFixed(1)},${y(0)} L${x(0).toFixed(1)},${y(0)} Z`} fill={s.color} fillOpacity="0.1" />
                      )}
                      <path d={path(s.values)} fill="none" stroke={s.color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
                    </g>
                  ))}
                  {/* The last point is labelled (one series) or marked; the active one is dotted. */}
                  {series.map((s) => {
                    const i = active ?? n - 1;
                    const v = s.values[i];
                    if (v === null || v === undefined) return null;
                    return <circle key={s.key} cx={x(i)} cy={y(v)} r="4" fill={s.color} className={css.gapStroke} />;
                  })}
                </>
              )}
          </svg>
        )}
        {/* The hover and keyboard layer: one button per point. */}
        <div className="absolute flex" style={{ left: PAD.l - (kind === "stacked" ? 0 : band / 2), right: PAD.r - (kind === "stacked" ? 0 : band / 2), top: PAD.t, bottom: PAD.b }} role="group" aria-label={`${HD_MEASURES[result.measure].label}, ${n} points`}>
          {xKeys.map((k, i) => {
            const href = drill?.([k]) ?? null;
            const label = tip(i);
            return (
              <button
                key={i}
                ref={(el) => {
                  roving.refs.current[i] = el;
                }}
                type="button"
                tabIndex={i === roving.focus ? 0 : -1}
                aria-label={href ? `${label}. Open these tickets` : label}
                data-tt={label}
                data-tt-wrap
                className="h-full min-w-0 flex-1 cursor-pointer rounded-sm outline-offset-0"
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover(null)}
                onFocus={() => {
                  roving.setFocus(i);
                  setFocused(true);
                }}
                onBlur={() => setFocused(false)}
                onKeyDown={(e) => roving.onKeyDown(e, i)}
                onClick={() => href && go(href)}
              />
            );
          })}
        </div>
      </div>
      {(series.length > 1 || compare) && (
        <Legend items={[...series.map((s) => ({ key: s.key, label: s.label, color: s.color })), ...(compare ? [{ key: "compare", label: compare.label, color: compare.color, dashed: true }] : [])]} />
      )}
      <SrTable result={result} caption={HD_MEASURES[result.measure].label} />
    </div>
  );
}

// --- Ranked bars, stacked bars by category, leaderboard ---------------------------------------

export function RankedBars({ result, target, drill, leaderboard = false, maxRows = 10 }: { result: HdQueryResult; target?: HdTarget | null; drill: DrillFn; leaderboard?: boolean; maxRows?: number }) {
  const rows = result.rows.slice(0, maxRows);
  const def: HdMeasureDef = HD_MEASURES[result.measure];
  const max = result.unit === "percent" ? 100 : Math.max(1e-9, ...rows.map((r) => r.value ?? 0));
  const roving = useRoving(rows.length);
  const go = useGo();
  return (
    <div className={css.viz}>
      <ol className="space-y-2" aria-label={def.label}>
        {rows.map((r, i) => {
          const href = drill?.(r.keys) ?? null;
          const value = formatValue(r.value, result.unit);
          const st = targetState(r.value, target, def.good);
          const label = `${r.labels[0]}: ${value}${r.n && result.unit !== "count" ? ` (based on ${r.n})` : ""}`;
          return (
            <li key={i}>
              <button
                ref={(el) => {
                  roving.refs.current[i] = el;
                }}
                type="button"
                tabIndex={i === roving.focus ? 0 : -1}
                onFocus={() => roving.setFocus(i)}
                onKeyDown={(e) => roving.onKeyDown(e, i)}
                onClick={() => href && go(href)}
                data-tt={href ? "Open these tickets" : label}
                aria-label={href ? `${label}. Open these tickets` : label}
                className={`group block w-full rounded-md px-1 py-0.5 text-left ${href ? "cursor-pointer hover:bg-slate-50" : "cursor-default"}`}
              >
                <span className="flex items-center justify-between gap-2 text-sm">
                  <span className="flex min-w-0 items-center gap-2">
                    {leaderboard && (
                      <>
                        <span className="w-4 shrink-0 text-right text-xs tabular-nums text-slate-500">{i + 1}</span>
                        <span className="flex h-5.5 w-5.5 shrink-0 items-center justify-center rounded-full bg-compass-100 text-3xs font-semibold text-compass-700" aria-hidden>
                          {r.keys[0] === null ? "–" : initialsOf(r.labels[0])}
                        </span>
                      </>
                    )}
                    <span className="truncate text-slate-700 group-hover:text-slate-900">{r.labels[0]}</span>
                  </span>
                  <span className="inline-flex shrink-0 items-center gap-1 font-medium tabular-nums text-slate-800">
                    {st === "missed" && <CircleAlert className="h-3.5 w-3.5 text-red-600" aria-label="Off target" />}
                    {st === "close" && <TriangleAlert className="h-3.5 w-3.5 ink-warn" aria-label="Close to target" />}
                    {value}
                  </span>
                </span>
                <span className="mt-1 block h-2.5 rounded-r bg-slate-100">
                  <span className="block h-full rounded-r" style={{ width: `${Math.max(0.5, ((r.value ?? 0) / max) * 100)}%`, background: r.keys[0] === "__other__" ? "var(--s-other)" : "var(--s1)" }} />
                </span>
              </button>
            </li>
          );
        })}
      </ol>
      {result.rows.length > maxRows && <p className="mt-2 text-xs text-slate-500">Top {maxRows} of {result.rows.length}. Show as a table for all of them.</p>}
      <SrTable result={result} caption={def.label} />
    </div>
  );
}

export function StackedBars({ result, drill }: { result: HdQueryResult; drill: DrillFn }) {
  // Time first: columns over time. Category first: one horizontal bar per category.
  if (HD_DIMENSIONS[result.groupBy[0]].kind === "time") return <TimeChart result={result} kind="stacked" drill={drill} />;
  return <CategoryStack result={result} drill={drill} />;
}

function CategoryStack({ result, drill }: { result: HdQueryResult; drill: DrillFn }) {
  const go = useGo();
  const { xKeys, xLabels, series } = seriesOf(result);
  const totals = xKeys.map((_, i) => series.reduce((a, s) => a + (s.values[i] ?? 0), 0));
  const max = Math.max(1, ...totals);
  const order = xKeys.map((_, i) => i).sort((a, b) => totals[b] - totals[a]).slice(0, 10);
  return (
    <div className={css.viz}>
      <ol className="space-y-2.5">
        {order.map((i) => (
          <li key={i}>
            <div className="flex items-center justify-between gap-2 text-sm">
              <span className="truncate text-slate-700">{xLabels[i]}</span>
              <span className="shrink-0 font-medium tabular-nums text-slate-800">{formatValue(totals[i], result.unit)}</span>
            </div>
            <div className="mt-1 flex h-2.5 gap-0.5" style={{ width: `${(totals[i] / max) * 100}%` }}>
              {series.map((s) => {
                const v = s.values[i] ?? 0;
                if (v <= 0) return null;
                const href = drill?.([xKeys[i], s.key === "__other__" ? null : result.rows.find((r) => String(r.keys[1]) === s.key)?.keys[1] ?? null]) ?? null;
                const label = `${xLabels[i]}, ${s.label}: ${formatValue(v, result.unit)}`;
                return (
                  <button
                    key={s.key}
                    type="button"
                    className="h-full min-w-0.5 first:rounded-l-none last:rounded-r"
                    style={{ flexGrow: v, flexBasis: 0, background: s.color }}
                    data-tt={label}
                    aria-label={href ? `${label}. Open these tickets` : label}
                    onClick={() => href && go(href)}
                  />
                );
              })}
            </div>
          </li>
        ))}
      </ol>
      <Legend items={series.map((s) => ({ key: s.key, label: s.label, color: s.color }))} />
      <SrTable result={result} caption={HD_MEASURES[result.measure].label} />
    </div>
  );
}

// --- Donut (≤ 5 parts of a whole) -------------------------------------------------------------

export function Donut({ result, drill }: { result: HdQueryResult; drill: DrillFn }) {
  const rows = result.rows.filter((r) => (r.value ?? 0) > 0);
  const total = rows.reduce((a, r) => a + (r.value ?? 0), 0);
  const slots = assignSlots(result.groupBy[0], rows.map((r) => r.keys[0]));
  const [hover, setHover] = useState<number | null>(null);
  const go = useGo();
  if (rows.length > 5) return <RankedBars result={result} drill={drill} />;
  const R = 56;
  const r0 = 36;
  let a0 = -Math.PI / 2;
  const arcs = rows.map((r, i) => {
    const frac = (r.value ?? 0) / (total || 1);
    const a1 = a0 + frac * Math.PI * 2;
    const large = a1 - a0 > Math.PI ? 1 : 0;
    const p = (a: number, rad: number) => `${(60 + rad * Math.cos(a)).toFixed(2)},${(60 + rad * Math.sin(a)).toFixed(2)}`;
    const d =
      frac >= 0.9999
        ? `M60,${60 - R} A${R},${R} 0 1 1 59.99,${60 - R} L59.99,${60 - r0} A${r0},${r0} 0 1 0 60,${60 - r0} Z`
        : `M${p(a0, R)} A${R},${R} 0 ${large} 1 ${p(a1, R)} L${p(a1, r0)} A${r0},${r0} 0 ${large} 0 ${p(a0, r0)} Z`;
    a0 = a1;
    return { d, color: slots.get(String(r.keys[0])) ?? "var(--s1)", i };
  });
  return (
    <div className={`${css.viz} flex flex-wrap items-center gap-4`}>
      <svg width="120" height="120" viewBox="0 0 120 120" aria-hidden className="shrink-0">
        {arcs.map((a) => (
          <path key={a.i} d={a.d} fill={a.color} className={css.gapStroke} opacity={hover === null || hover === a.i ? 1 : 0.45} />
        ))}
        <text x="60" y="58" textAnchor="middle" fontSize="16" fontWeight="600" fill="currentColor" className="text-slate-900">
          {formatValue(total, result.unit, { compact: true })}
        </text>
        <text x="60" y="74" textAnchor="middle" fontSize="10" fill="var(--tick)">
          total
        </text>
      </svg>
      <ul className="min-w-0 flex-1 space-y-1">
        {rows.map((r, i) => {
          const href = drill?.(r.keys) ?? null;
          const share = total ? Math.round(((r.value ?? 0) / total) * 1000) / 10 : 0;
          const label = `${r.labels[0]}: ${formatValue(r.value, result.unit)} (${share}%)`;
          return (
            <li key={i}>
              <button
                type="button"
                className={`flex w-full items-center gap-2 rounded-md px-1 py-0.5 text-left text-sm ${href ? "hover:bg-slate-50" : "cursor-default"}`}
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover(null)}
                onFocus={() => setHover(i)}
                onBlur={() => setHover(null)}
                onClick={() => href && go(href)}
                data-tt={href ? "Open these tickets" : label}
                aria-label={href ? `${label}. Open these tickets` : label}
              >
                <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: slots.get(String(r.keys[0])) }} aria-hidden />
                <span className="min-w-0 flex-1 truncate text-slate-700">{r.labels[0]}</span>
                <span className="shrink-0 tabular-nums text-slate-800">{formatValue(r.value, result.unit)}</span>
                <span className="w-12 shrink-0 text-right text-xs tabular-nums text-slate-500">{share}%</span>
              </button>
            </li>
          );
        })}
      </ul>
      <SrTable result={result} caption={HD_MEASURES[result.measure].label} />
    </div>
  );
}

// --- Heatmap (day of the week × hour) ------------------------------------------------------------

export function Heatmap({ result, drill }: { result: HdQueryResult; drill: DrillFn }) {
  const grid = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of result.rows) m.set(`${r.keys[0]}:${r.keys[1]}`, r.value ?? 0);
    return m;
  }, [result]);
  const max = Math.max(1, ...grid.values());
  const roving = useRoving(7 * 24);
  const go = useGo();
  const steps = [0.12, 0.28, 0.45, 0.65, 0.85, 1];
  const alpha = (v: number) => (v <= 0 ? 0 : steps[Math.min(steps.length - 1, Math.floor((v / max) * (steps.length - 0.0001)))]);
  return (
    <div className={css.viz}>
      <div className="grid gap-0.5" style={{ gridTemplateColumns: "2.25rem repeat(24, minmax(0, 1fr))" }} role="grid" aria-label="Tickets by day of the week and hour">
        <span aria-hidden />
        {Array.from({ length: 24 }, (_, h) => (
          <span key={h} className="text-center text-3xs tabular-nums text-slate-500" aria-hidden>
            {h % 3 === 0 ? String(h).padStart(2, "0") : ""}
          </span>
        ))}
        {[1, 2, 3, 4, 5, 6, 7].map((d) => (
          <div key={d} role="row" className="contents">
            <span className="pr-1 text-xs text-slate-500" role="rowheader">
              {WEEKDAY_SHORT[d]}
            </span>
            {Array.from({ length: 24 }, (_, h) => {
              const i = (d - 1) * 24 + h;
              const v = grid.get(`${d}:${h}`) ?? 0;
              const label = `${WEEKDAY_SHORT[d]} ${String(h).padStart(2, "0")}:00: ${formatValue(v, result.unit)}`;
              const a = alpha(v);
              return (
                <button
                  key={h}
                  ref={(el) => {
                    roving.refs.current[i] = el;
                  }}
                  type="button"
                  role="gridcell"
                  tabIndex={i === roving.focus ? 0 : -1}
                  onFocus={() => roving.setFocus(i)}
                  onKeyDown={(e) => roving.onKeyDown(e, i, 24)}
                  data-tt={label}
                  aria-label={label}
                  className={`h-5 min-w-0 rounded-sm ${a === 0 ? "bg-slate-100" : ""}`}
                  style={a ? { background: `rgb(var(--compass-600) / ${a})` } : undefined}
                  onClick={() => {
                    const href = drill?.([d, h]);
                    if (href) go(href);
                  }}
                />
              );
            })}
          </div>
        ))}
      </div>
      <div className="mt-2 flex items-center justify-end gap-1.5 text-2xs text-slate-500" aria-hidden>
        Fewer
        {steps.map((s) => (
          <span key={s} className="h-2.5 w-3.5 rounded-sm" style={{ background: `rgb(var(--compass-600) / ${s})` }} />
        ))}
        More · busiest hour {formatValue(max, result.unit)}
      </div>
      <SrTable result={result} caption="Tickets by day of the week and hour" />
    </div>
  );
}

// --- Table ------------------------------------------------------------------------------------------

export function DataTable({ result, drill, maxRows = 200, compact = false }: { result: HdQueryResult; drill: DrillFn; maxRows?: number; compact?: boolean }) {
  const def: HdMeasureDef = HD_MEASURES[result.measure];
  const [sort, setSort] = useState<{ by: string | null; dir: SortDir }>({ by: null, dir: "desc" });
  const onSort = (key: string) => setSort((s) => (s.by === key ? { by: key, dir: s.dir === "asc" ? "desc" : "asc" } : { by: key, dir: key === "value" || key === "n" ? "desc" : "asc" }));
  const rows = useMemo(() => {
    const list = [...result.rows];
    if (sort.by === null) return list;
    const dir = sort.dir === "asc" ? 1 : -1;
    list.sort((a, b) => {
      if (sort.by === "value") return ((a.value ?? -Infinity) - (b.value ?? -Infinity)) * dir;
      if (sort.by === "n") return (a.n - b.n) * dir;
      const i = Number(sort.by);
      const ak = HD_DIMENSIONS[result.groupBy[i]].kind === "category" ? a.labels[i] : String(a.keys[i]);
      const bk = HD_DIMENSIONS[result.groupBy[i]].kind === "category" ? b.labels[i] : String(b.keys[i]);
      return ak.localeCompare(bk, undefined, { numeric: true }) * dir;
    });
    return list;
  }, [result, sort]);
  const shown = rows.slice(0, maxRows);
  return (
    <div>
      <Table scroll className={compact ? "text-xs" : ""}>
        <thead>
          <tr className={TABLE_HEAD_ROW}>
            {result.groupBy.map((g, i) => (
              <Th key={g} sort={{ key: String(i), by: sort.by, dir: sort.dir, onSort }} className="px-2">
                {HD_DIMENSIONS[g].label}
              </Th>
            ))}
            <Th align="right" sort={{ key: "value", by: sort.by, dir: sort.dir, onSort }} className="px-2">
              {def.short}
            </Th>
            {result.unit !== "count" && (
              <Th align="right" fit sort={{ key: "n", by: sort.by, dir: sort.dir, onSort }} className="px-2">
                Based on
              </Th>
            )}
          </tr>
        </thead>
        <tbody>
          {shown.map((r, i) => {
            const href = drill?.(r.keys) ?? null;
            return (
              <tr key={i} className={TR}>
                {r.labels.map((l, j) => (
                  <Td key={j} className="px-2 py-2">
                    {j === 0 && href ? (
                      <a href={href} className="text-slate-800 hover:text-compass-700 hover:underline" data-tt="Open these tickets">
                        {keyLabel(result.groupBy[j], r.keys[j], l)}
                      </a>
                    ) : (
                      <span className="text-slate-700">{keyLabel(result.groupBy[j], r.keys[j], l)}</span>
                    )}
                  </Td>
                ))}
                <Td align="right" className="px-2 py-2 font-medium text-slate-800">
                  {formatValue(r.value, result.unit)}
                </Td>
                {result.unit !== "count" && (
                  <Td align="right" fit className="px-2 py-2 text-slate-500">
                    {r.n.toLocaleString("en-GB")}
                  </Td>
                )}
              </tr>
            );
          })}
        </tbody>
      </Table>
      {rows.length > maxRows && <p className="mt-2 text-xs text-slate-500">Showing {maxRows} of {rows.length}. The CSV export has every row.</p>}
    </div>
  );
}

/** A widget's body for its type. */
export function ChartFor({
  type,
  result,
  target,
  drill,
  spark,
}: {
  type: string;
  result: HdQueryResult;
  target?: HdTarget | null;
  drill: DrillFn;
  spark?: HdResultRow[] | null;
}): ReactNode {
  switch (type) {
    case "kpi":
      return <KpiTile result={result} target={target} spark={spark} />;
    case "live":
      return <KpiTile result={result} target={target} live />;
    case "gauge":
      return <Gauge result={result} target={target} />;
    case "line":
    case "area":
      return <TimeChart result={result} kind={type} target={target} drill={drill} />;
    case "stacked":
      return <StackedBars result={result} drill={drill} />;
    case "bar":
      return <RankedBars result={result} target={target} drill={drill} />;
    case "leaderboard":
      return <RankedBars result={result} target={target} drill={drill} leaderboard />;
    case "donut":
      return <Donut result={result} drill={drill} />;
    case "heatmap":
      return <Heatmap result={result} drill={drill} />;
    default:
      return <DataTable result={result} drill={drill} compact />;
  }
}
