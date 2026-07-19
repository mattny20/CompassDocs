"use client";

// Knowledge-base analytics dashboard: KPI strip with period-over-period
// deltas, a views-over-time chart, trending / most / least viewed documents
// with per-document drill-down, search analytics, reader engagement, author
// stats, and a live activity feed. Filterable by date range, space, category,
// author, and tag. Charts are hand-rolled SVG so the design stays native.

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  ChartColumn,
  Eye,
  Users,
  FileText,
  Clock,
  Search,
  SearchX,
  Download,
  Globe,
  TrendingUp,
  TrendingDown,
  Minus,
  Flame,
  Moon,
  LoaderCircle,
  X,
  ArrowUpRight,
  UserPen,
  Activity,
  MousePointerClick,
  FilterX,
} from "lucide-react";

type Kpis = Record<string, number>;
interface SeriesPoint {
  day: string;
  app_views: number;
  public_views: number;
  active_users: number;
}
interface Payload {
  days: number;
  kpis: Kpis;
  series: SeriesPoint[];
  top: any[];
  least: any[];
  trending: any[];
  searches: any[];
  zeroSearches: any[];
  readers: any[];
  authors: any[];
  activity: any[];
  options: {
    spaces: { id: number; name: string; icon: string }[];
    categories: { id: number; name: string }[];
    authors: string[];
  };
}

function fmtDuration(seconds: number): string {
  if (!seconds) return "—";
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m ${seconds % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function fmtDay(day: string): string {
  const d = new Date(day + "T00:00:00");
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// --- KPI cards ----------------------------------------------------------------

function Delta({ now, prev }: { now: number; prev: number }) {
  if (!prev && !now) return null;
  if (!prev) {
    return (
      <span className="inline-flex items-center gap-0.5 text-xs font-medium text-emerald-600">
        <TrendingUp className="h-3 w-3" /> new
      </span>
    );
  }
  const pct = Math.round(((now - prev) / prev) * 100);
  if (pct === 0) {
    return (
      <span className="inline-flex items-center gap-0.5 text-xs font-medium text-slate-400">
        <Minus className="h-3 w-3" /> 0%
      </span>
    );
  }
  const up = pct > 0;
  return (
    <span
      className={`inline-flex items-center gap-0.5 text-xs font-medium ${
        up ? "text-emerald-600" : "text-red-500"
      }`}
    >
      {up ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
      {up ? "+" : ""}
      {pct}%
    </span>
  );
}

function Kpi({
  icon,
  label,
  value,
  sub,
  delta,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub?: string;
  delta?: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-slate-200 bg-surface p-4 shadow-sm">
      <div className="flex items-center justify-between">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-compass-50 text-compass-600 dark:bg-compass-950/50">
          {icon}
        </span>
        {delta}
      </div>
      <div className="mt-2 text-2xl font-bold tracking-tight text-slate-900">{value}</div>
      <div className="text-xs text-slate-400">
        {label}
        {sub ? ` · ${sub}` : ""}
      </div>
    </div>
  );
}

// --- Views-over-time chart ----------------------------------------------------

const W = 820;
const H = 220;
const PAD = { l: 36, r: 10, t: 12, b: 24 };

function TrendChart({ series, compact = false }: { series: SeriesPoint[]; compact?: boolean }) {
  const [hover, setHover] = useState<number | null>(null);
  const h = compact ? 160 : H;
  const innerW = W - PAD.l - PAD.r;
  const innerH = h - PAD.t - PAD.b;
  const totals = series.map((p) => p.app_views + p.public_views);
  const max = Math.max(4, ...totals);
  const x = (i: number) => PAD.l + (series.length <= 1 ? 0 : (i / (series.length - 1)) * innerW);
  const y = (v: number) => PAD.t + innerH - (v / max) * innerH;

  const path = (vals: number[]) =>
    vals.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const area =
    path(totals) +
    ` L${x(series.length - 1).toFixed(1)},${y(0)} L${x(0).toFixed(1)},${y(0)} Z`;

  const ticks = [0, 0.5, 1].map((f) => Math.round(max * f));
  const p = hover !== null ? series[hover] : null;

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${W} ${h}`}
        className="w-full"
        onMouseMove={(e) => {
          const rect = (e.currentTarget as SVGElement).getBoundingClientRect();
          const px = ((e.clientX - rect.left) / rect.width) * W;
          const i = Math.round(((px - PAD.l) / innerW) * (series.length - 1));
          setHover(Math.max(0, Math.min(series.length - 1, i)));
        }}
        onMouseLeave={() => setHover(null)}
      >
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(t)} y2={y(t)} className="stroke-slate-200/70 dark:stroke-slate-700/60" strokeDasharray="3 4" strokeWidth="1" />
            <text x={PAD.l - 6} y={y(t) + 3.5} textAnchor="end" className="fill-slate-400 text-[10px]">
              {t}
            </text>
          </g>
        ))}
        <path d={area} className="fill-compass-500/10" />
        <path d={path(totals)} fill="none" className="stroke-compass-500" strokeWidth="2" strokeLinejoin="round" />
        <path
          d={path(series.map((s) => s.public_views))}
          fill="none"
          className="stroke-violet-400"
          strokeWidth="1.6"
          strokeDasharray="5 3"
          strokeLinejoin="round"
        />
        {!compact && (
          <path
            d={path(series.map((s) => s.active_users))}
            fill="none"
            className="stroke-emerald-500/80"
            strokeWidth="1.4"
            strokeLinejoin="round"
          />
        )}
        {series.length > 1 &&
          series.map((s, i) =>
            i % Math.ceil(series.length / 8) === 0 || i === series.length - 1 ? (
              <text key={i} x={x(i)} y={h - 6} textAnchor="middle" className="fill-slate-400 text-[10px]">
                {fmtDay(s.day)}
              </text>
            ) : null
          )}
        {hover !== null && (
          <g>
            <line x1={x(hover)} x2={x(hover)} y1={PAD.t} y2={h - PAD.b} className="stroke-slate-300" strokeWidth="1" />
            <circle cx={x(hover)} cy={y(totals[hover])} r="3.5" className="fill-compass-600" />
          </g>
        )}
      </svg>
      {p && (
        <div
          className="pointer-events-none absolute top-1 z-10 rounded-lg border border-slate-200 bg-surface px-3 py-2 text-xs shadow-md"
          style={{ left: `${Math.min(82, Math.max(2, (x(hover!) / W) * 100))}%` }}
        >
          <div className="font-semibold text-slate-700">{fmtDay(p.day)}</div>
          <div className="mt-0.5 text-slate-500">
            {p.app_views + p.public_views} views ({p.public_views} public)
          </div>
          {!compact && <div className="text-emerald-600">{p.active_users} active users</div>}
        </div>
      )}
    </div>
  );
}

// --- Reusable bits ------------------------------------------------------------

function Card({
  icon,
  title,
  sub,
  children,
  extra,
}: {
  icon: React.ReactNode;
  title: string;
  sub?: string;
  children: React.ReactNode;
  extra?: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-slate-200 bg-surface p-4 shadow-sm">
      <div className="mb-3 flex items-center justify-between gap-2">
        <div>
          <h2 className="flex items-center gap-1.5 text-sm font-semibold text-slate-800">
            <span className="text-compass-600">{icon}</span> {title}
          </h2>
          {sub && <p className="mt-0.5 text-xs text-slate-400">{sub}</p>}
        </div>
        {extra}
      </div>
      {children}
    </section>
  );
}

function Empty({ note }: { note: string }) {
  return <p className="py-6 text-center text-sm text-slate-400">{note}</p>;
}

function BarList({
  rows,
  onPick,
}: {
  rows: { label: string; value: number; hint?: string }[];
  onPick?: (label: string) => void;
}) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <ul className="space-y-1.5">
      {rows.map((r) => (
        <li key={r.label} className="group">
          <div className="flex items-center justify-between gap-2 text-sm">
            {onPick ? (
              <button
                onClick={() => onPick(r.label)}
                className="truncate text-left text-slate-700 hover:text-compass-700 hover:underline"
                title="Run this search"
              >
                {r.label}
              </button>
            ) : (
              <span className="truncate text-slate-700">{r.label}</span>
            )}
            <span className="shrink-0 text-xs text-slate-400">
              {r.value}
              {r.hint ? ` · ${r.hint}` : ""}
            </span>
          </div>
          <div className="mt-0.5 h-1.5 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
            <div className="h-full rounded-full bg-compass-400/80" style={{ width: `${(r.value / max) * 100}%` }} />
          </div>
        </li>
      ))}
    </ul>
  );
}

// --- Drill-down modal ---------------------------------------------------------

function DocDrilldown({ docId, days, onClose }: { docId: number; days: number; onClose: () => void }) {
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`/api/analytics/doc/${docId}?days=${days}`);
        const d = await res.json();
        if (!res.ok) throw new Error(d?.error || "Failed to load.");
        setData(d);
      } catch (e: any) {
        setError(e.message);
      }
    })();
  }, [docId, days]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4" onClick={onClose}>
      <div
        className="max-h-[85vh] w-full max-w-2xl overflow-y-auto rounded-xl border border-slate-200 bg-surface p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {error ? (
          <p className="text-sm text-red-600">{error}</p>
        ) : !data ? (
          <div className="flex items-center gap-2 py-10 text-sm text-slate-400">
            <LoaderCircle className="h-4 w-4 animate-spin" /> Loading…
          </div>
        ) : (
          <>
            <div className="mb-3 flex items-start justify-between gap-3">
              <div>
                <div className="text-xs text-slate-400">
                  {data.doc.space_icon} {data.doc.space_name} · by {data.doc.author}
                </div>
                <h3 className="text-lg font-bold text-slate-900">{data.doc.title}</h3>
              </div>
              <div className="flex items-center gap-1.5">
                <Link
                  href={`/doc/${data.doc.id}`}
                  className="inline-flex items-center gap-1 rounded-md border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50"
                >
                  Open <ArrowUpRight className="h-3 w-3" />
                </Link>
                <button onClick={onClose} aria-label="Close" className="rounded-md border border-slate-200 p-1.5 text-slate-400 hover:text-slate-600">
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>
            <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-5">
              {[
                ["Views", data.totals.views],
                ["Unique", data.totals.unique_viewers],
                ["Public", data.totals.public_views],
                ["Avg time", fmtDuration(data.totals.avg_seconds)],
                ["Downloads", data.totals.downloads],
              ].map(([label, v]) => (
                <div key={label as string} className="rounded-lg border border-slate-200 bg-slate-50/70 px-2.5 py-2 text-center dark:bg-slate-800/40">
                  <div className="text-base font-bold text-slate-800">{v as any}</div>
                  <div className="text-[10px] uppercase tracking-wide text-slate-400">{label as string}</div>
                </div>
              ))}
            </div>
            <TrendChart
              compact
              series={data.daily.map((d: any) => ({ ...d, active_users: 0 }))}
            />
            {data.readers.length > 0 && (
              <div className="mt-3">
                <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-400">
                  Top readers
                </h4>
                <ul className="divide-y divide-slate-100 text-sm">
                  {data.readers.map((r: any) => (
                    <li key={r.username} className="flex items-center justify-between py-1.5">
                      <span className="text-slate-700">{r.name || r.username}</span>
                      <span className="text-xs text-slate-400">
                        {r.views} views · {fmtDuration(r.seconds)}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// --- Dashboard ----------------------------------------------------------------

export function AnalyticsClient() {
  const [days, setDays] = useState(30);
  const [space, setSpace] = useState("");
  const [category, setCategory] = useState("");
  const [author, setAuthor] = useState("");
  const [tag, setTag] = useState("");
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [drill, setDrill] = useState<number | null>(null);

  const filtered = Boolean(space || category || author || tag);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const qs = new URLSearchParams({ days: String(days) });
      if (space) qs.set("space", space);
      if (category) qs.set("category", category);
      if (author) qs.set("author", author);
      if (tag) qs.set("tag", tag);
      const res = await fetch(`/api/analytics?${qs}`);
      const d = await res.json();
      if (!res.ok) throw new Error(d?.error || "Failed to load analytics.");
      setData(d);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [days, space, category, author, tag]);

  useEffect(() => {
    void load();
  }, [load]);

  const k = data?.kpis ?? {};
  const select =
    "rounded-lg border border-slate-200 bg-surface px-2.5 py-1.5 text-sm text-slate-600 outline-none focus:border-compass-400";

  const trendRows = useMemo(
    () =>
      (data?.trending ?? []).map((t: any) => ({
        ...t,
        delta: t.views - t.prev_views,
      })),
    [data]
  );

  return (
    <div>
      <div className="mb-1 flex items-center gap-2">
        <ChartColumn className="h-6 w-6 text-compass-600" />
        <h1 className="text-2xl font-bold text-slate-900">Analytics</h1>
      </div>
      <p className="mb-5 text-slate-500">
        How your knowledge base is read, searched, and used.
      </p>

      {/* Filters */}
      <div className="mb-5 flex flex-wrap items-center gap-2">
        <div className="flex overflow-hidden rounded-lg border border-slate-200">
          {[7, 30, 90, 365].map((d) => (
            <button
              key={d}
              onClick={() => setDays(d)}
              className={`px-3 py-1.5 text-sm font-medium ${
                days === d ? "bg-compass-600 text-white" : "bg-surface text-slate-500 hover:bg-slate-50"
              }`}
            >
              {d === 365 ? "1y" : `${d}d`}
            </button>
          ))}
        </div>
        <select value={space} onChange={(e) => { setSpace(e.target.value); setCategory(""); }} className={select}>
          <option value="">All spaces</option>
          {data?.options.spaces.map((s) => (
            <option key={s.id} value={s.id}>
              {s.icon} {s.name}
            </option>
          ))}
        </select>
        {space && (data?.options.categories.length ?? 0) > 0 && (
          <select value={category} onChange={(e) => setCategory(e.target.value)} className={select}>
            <option value="">All categories</option>
            {data?.options.categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        )}
        <select value={author} onChange={(e) => setAuthor(e.target.value)} className={select}>
          <option value="">All authors</option>
          {data?.options.authors.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
        <input
          value={tag}
          onChange={(e) => setTag(e.target.value)}
          placeholder="Filter by tag…"
          className={`${select} w-36 placeholder:text-slate-400`}
        />
        {filtered && (
          <button
            onClick={() => {
              setSpace("");
              setCategory("");
              setAuthor("");
              setTag("");
            }}
            className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-1.5 text-sm text-slate-500 hover:bg-slate-50"
          >
            <FilterX className="h-3.5 w-3.5" /> Clear
          </button>
        )}
        {loading && <LoaderCircle className="h-4 w-4 animate-spin text-slate-400" />}
      </div>

      {error && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
          {error}
        </div>
      )}

      {data && (
        <div className="space-y-5">
          {/* KPI strip */}
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Kpi icon={<Eye className="h-4 w-4" />} label="Total views" value={String(k.views ?? 0)} delta={<Delta now={k.views} prev={k.views_prev} />} />
            <Kpi icon={<Users className="h-4 w-4" />} label="Unique viewers" value={String(k.unique_viewers ?? 0)} delta={<Delta now={k.unique_viewers} prev={k.unique_viewers_prev} />} />
            <Kpi icon={<Clock className="h-4 w-4" />} label="Avg time on doc" value={fmtDuration(k.avg_seconds ?? 0)} delta={<Delta now={k.avg_seconds} prev={k.avg_seconds_prev} />} />
            <Kpi icon={<FileText className="h-4 w-4" />} label="Documents viewed" value={String(k.docs_viewed ?? 0)} />
            <Kpi icon={<Search className="h-4 w-4" />} label="Searches" value={String(k.searches ?? 0)} delta={<Delta now={k.searches} prev={k.searches_prev} />} />
            <Kpi icon={<SearchX className="h-4 w-4" />} label="Searches with no results" value={String(k.zero_searches ?? 0)} />
            <Kpi icon={<Download className="h-4 w-4" />} label="Downloads" value={String(k.downloads ?? 0)} delta={<Delta now={k.downloads} prev={k.downloads_prev} />} />
            <Kpi
              icon={<Globe className="h-4 w-4" />}
              label="Public site views"
              value={String(k.public_views ?? 0)}
              sub={k.views ? `${Math.round(((k.public_views ?? 0) / k.views) * 100)}% of total` : undefined}
            />
          </div>

          {/* Chart + trending */}
          <div className="grid gap-5 lg:grid-cols-3">
            <div className="lg:col-span-2">
              <Card
                icon={<Activity className="h-4 w-4" />}
                title="Views over time"
                sub="Solid: all views · dashed: public site · green: daily active users"
              >
                <TrendChart series={data.series} />
              </Card>
            </div>
            <Card
              icon={<Flame className="h-4 w-4" />}
              title="Trending"
              sub="Biggest gains vs the previous period"
            >
              {trendRows.length === 0 ? (
                <Empty note="No views recorded yet in this period." />
              ) : (
                <ul className="divide-y divide-slate-100">
                  {trendRows.map((t: any, i: number) => (
                    <li key={t.id}>
                      <button
                        onClick={() => setDrill(t.id)}
                        className="flex w-full items-center gap-2.5 py-2 text-left hover:bg-slate-50/60"
                      >
                        <span className="w-5 text-center text-xs font-bold text-slate-300">{i + 1}</span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium text-slate-700">{t.title}</span>
                          <span className="block text-xs text-slate-400">
                            {t.space_icon} {t.space_name}
                          </span>
                        </span>
                        <span className="shrink-0 text-right">
                          <span className="block text-sm font-semibold text-slate-700">{t.views}</span>
                          <Delta now={t.views} prev={t.prev_views} />
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>

          {/* Most / least viewed */}
          <div className="grid gap-5 lg:grid-cols-2">
            <Card
              icon={<Eye className="h-4 w-4" />}
              title="Most viewed documents"
              sub="Click a row for the full breakdown"
            >
              {data.top.length === 0 ? (
                <Empty note="No document views in this period." />
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs uppercase tracking-wide text-slate-400">
                      <th className="pb-2 font-medium">Document</th>
                      <th className="pb-2 text-right font-medium">Views</th>
                      <th className="pb-2 text-right font-medium">Unique</th>
                      <th className="pb-2 text-right font-medium">Avg time</th>
                      <th className="pb-2 text-right font-medium">DLs</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {data.top.map((d: any) => (
                      <tr key={d.id} onClick={() => setDrill(d.id)} className="cursor-pointer hover:bg-slate-50/60">
                        <td className="max-w-0 truncate py-2 pr-2 font-medium text-slate-700">
                          {d.space_icon} {d.title}
                        </td>
                        <td className="py-2 text-right text-slate-600">{d.views}</td>
                        <td className="py-2 text-right text-slate-400">{d.unique_viewers}</td>
                        <td className="py-2 text-right text-slate-400">{fmtDuration(d.avg_seconds)}</td>
                        <td className="py-2 text-right text-slate-400">{d.downloads || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Card>
            <Card
              icon={<Moon className="h-4 w-4" />}
              title="Least viewed documents"
              sub="Published docs nobody is finding — candidates to refresh, promote, or retire"
            >
              {data.least.length === 0 ? (
                <Empty note="No published documents match these filters." />
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs uppercase tracking-wide text-slate-400">
                      <th className="pb-2 font-medium">Document</th>
                      <th className="pb-2 text-right font-medium">Views</th>
                      <th className="pb-2 text-right font-medium">Updated</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {data.least.map((d: any) => (
                      <tr key={d.id} onClick={() => setDrill(d.id)} className="cursor-pointer hover:bg-slate-50/60">
                        <td className="max-w-0 truncate py-2 pr-2 font-medium text-slate-700">
                          {d.space_icon} {d.title}
                        </td>
                        <td className={`py-2 text-right ${d.views === 0 ? "font-semibold text-amber-600" : "text-slate-600"}`}>
                          {d.views}
                        </td>
                        <td className="py-2 text-right text-slate-400">{d.updated}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Card>
          </div>

          {/* Search analytics */}
          <div className="grid gap-5 lg:grid-cols-2">
            <Card icon={<Search className="h-4 w-4" />} title="Top searches" sub="Includes Ask AI questions">
              {data.searches.length === 0 ? (
                <Empty note="No searches recorded in this period." />
              ) : (
                <BarList
                  rows={data.searches.map((s: any) => ({
                    label: s.query,
                    value: s.count,
                    hint: `${s.avg_results} results avg`,
                  }))}
                />
              )}
            </Card>
            <Card
              icon={<SearchX className="h-4 w-4" />}
              title="Searches with no results"
              sub="Content gaps — what people looked for and didn't find"
            >
              {data.zeroSearches.length === 0 ? (
                <Empty note="Every search found something. Nice." />
              ) : (
                <ul className="divide-y divide-slate-100 text-sm">
                  {data.zeroSearches.map((s: any) => (
                    <li key={s.query} className="flex items-center justify-between py-2">
                      <Link
                        href={`/search?q=${encodeURIComponent(s.query)}`}
                        className="truncate text-slate-700 hover:text-compass-700 hover:underline"
                      >
                        {s.query}
                      </Link>
                      <span className="shrink-0 text-xs text-slate-400">
                        ×{s.count} · last {s.last}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>

          {/* Engagement + authors */}
          <div className="grid gap-5 lg:grid-cols-2">
            <Card icon={<Users className="h-4 w-4" />} title="Most engaged readers">
              {data.readers.length === 0 ? (
                <Empty note="No signed-in reading activity yet." />
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs uppercase tracking-wide text-slate-400">
                      <th className="pb-2 font-medium">Reader</th>
                      <th className="pb-2 text-right font-medium">Views</th>
                      <th className="pb-2 text-right font-medium">Docs</th>
                      <th className="pb-2 text-right font-medium">Time</th>
                      <th className="pb-2 text-right font-medium">Last active</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {data.readers.map((r: any) => (
                      <tr key={r.id}>
                        <td className="py-2 pr-2 font-medium text-slate-700">{r.name || r.username}</td>
                        <td className="py-2 text-right text-slate-600">{r.views}</td>
                        <td className="py-2 text-right text-slate-400">{r.docs}</td>
                        <td className="py-2 text-right text-slate-400">{fmtDuration(r.seconds)}</td>
                        <td className="py-2 text-right text-slate-400">{r.last_active}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Card>
            <Card
              icon={<UserPen className="h-4 w-4" />}
              title="Author analytics"
              sub="Reach of each author's published documents"
            >
              {data.authors.length === 0 ? (
                <Empty note="No published documents match these filters." />
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs uppercase tracking-wide text-slate-400">
                      <th className="pb-2 font-medium">Author</th>
                      <th className="pb-2 text-right font-medium">Docs</th>
                      <th className="pb-2 text-right font-medium">Views</th>
                      <th className="pb-2 text-right font-medium">Views/doc</th>
                      <th className="pb-2 text-right font-medium">Avg time</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {data.authors.map((a: any) => (
                      <tr key={a.author}>
                        <td className="py-2 pr-2 font-medium text-slate-700">{a.author}</td>
                        <td className="py-2 text-right text-slate-400">{a.docs}</td>
                        <td className="py-2 text-right text-slate-600">{a.views}</td>
                        <td className="py-2 text-right text-slate-400">{a.views_per_doc}</td>
                        <td className="py-2 text-right text-slate-400">{fmtDuration(a.avg_seconds)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Card>
          </div>

          {/* Activity feed */}
          <Card icon={<MousePointerClick className="h-4 w-4" />} title="Recent activity">
            {data.activity.length === 0 ? (
              <Empty note="Nothing yet — activity appears as people read, search, and download." />
            ) : (
              <ul className="divide-y divide-slate-100 text-sm">
                {data.activity.map((a: any, i: number) => (
                  <li key={i} className="flex items-center gap-2.5 py-2">
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-slate-100 text-slate-500 dark:bg-slate-800">
                      {a.kind === "view" ? (
                        <Eye className="h-3 w-3" />
                      ) : a.kind === "search" ? (
                        <Search className="h-3 w-3" />
                      ) : (
                        <Download className="h-3 w-3" />
                      )}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-slate-600">
                      <span className="font-medium text-slate-700">
                        {a.user_name || (a.source === "public" ? "Public visitor" : "Someone")}
                      </span>{" "}
                      {a.kind === "view" ? (
                        <>
                          viewed{" "}
                          <button onClick={() => setDrill(a.doc_id)} className="text-compass-700 hover:underline">
                            {a.doc_title}
                          </button>
                        </>
                      ) : a.kind === "search" ? (
                        <>searched for “{a.detail?.replace(/ \(\d+\)$/, "")}”</>
                      ) : (
                        <>
                          downloaded {a.detail} from{" "}
                          <button onClick={() => setDrill(a.doc_id)} className="text-compass-700 hover:underline">
                            {a.doc_title}
                          </button>
                        </>
                      )}
                    </span>
                    <span className="shrink-0 text-xs text-slate-400">
                      {new Date(a.at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      )}

      {drill !== null && <DocDrilldown docId={drill} days={days} onClose={() => setDrill(null)} />}
    </div>
  );
}
