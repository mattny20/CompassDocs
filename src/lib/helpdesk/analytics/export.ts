// Helpdesk 1.19.0 reports (agent K): a whole dashboard computed for one
// viewer (the export, the digest), and its CSV. Each widget runs through
// runQuery in the viewer's own scope with the dashboard's filters and the
// widget's overrides, so an export never holds a number its reader could
// not see on screen. The PDF is ./export-pdf. Server-only.

import "server-only";
import { csvCell } from "../../csv";
import { AnalyticsError, reportScope, runQuery, type Viewer } from "./engine";
import {
  HD_COMPARE_LABEL,
  HD_DIMENSIONS,
  HD_MEASURES,
  formatDelta,
  headline,
  mergeFilters,
  type HdCompare,
  type HdDashboard,
  type HdFilters,
  type HdQueryResult,
  type HdRangeInput,
  type HdWidget,
} from "./shared";

export interface DashboardState {
  filters: HdFilters;
  range: HdRangeInput;
  compare: HdCompare | null;
  /** Include automated tickets (alerts, API). */
  automated?: boolean;
}

export interface WidgetResult {
  widget: HdWidget;
  result: HdQueryResult | null;
  error?: string;
}

/** Every widget of a dashboard for one viewer (sequentially: the engine already caps concurrency). */
export async function runDashboard(d: HdDashboard, viewer: Viewer, state: DashboardState, opts: { now?: number; fresh?: boolean } = {}): Promise<WidgetResult[]> {
  const scope = await reportScope(viewer);
  if (!scope) throw new AnalyticsError("You don't have permission to read reports.", 403);
  const out: WidgetResult[] = [];
  for (const w of d.layout.widgets) {
    try {
      const result = await runQuery(
        { measure: w.measure, groupBy: w.groupBy, filters: mergeFilters(state.filters, w.filters), range: state.range, compare: state.compare, limit: 50, automated: state.automated === true },
        viewer,
        { scope, now: opts.now, fresh: opts.fresh }
      );
      out.push({ widget: w, result });
    } catch (e) {
      out.push({ widget: w, result: null, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return out;
}

// Numbers go out bare (a number cannot be a formula); text through csvCell, which also defuses =, +, - and @.
const line = (cells: unknown[]) => cells.map((c) => (typeof c === "number" && Number.isFinite(c) ? String(c) : csvCell(c))).join(",");

/** One widget's result as CSV rows: a header naming the splits, then a row per group; or the total. */
export function resultCsvLines(title: string, r: HdQueryResult): string[] {
  const def = HD_MEASURES[r.measure];
  const unitNote = r.unit === "minutes" ? " (minutes)" : r.unit === "percent" ? " (%)" : "";
  const out: string[] = [];
  const valueCol = `${def.label}${unitNote}`;
  const rawValue = (v: number | null) => (v === null ? "" : r.unit === "minutes" ? Math.round(v) : v);
  if (!r.groupBy.length) {
    out.push(line(["Widget", "From", "To", valueCol, "Based on", ...(r.compare ? [`${HD_COMPARE_LABEL[r.compare.kind]}`, "Change", "Change (%)"] : [])]));
    out.push(
      line([
        title,
        r.range.from,
        r.range.to,
        rawValue(r.total.value),
        r.total.n,
        ...(r.compare ? [rawValue(r.compare.total.value), r.compare.delta === null ? "" : r.unit === "minutes" ? Math.round(r.compare.delta) : r.compare.delta, r.compare.delta_pct ?? ""] : []),
      ])
    );
    return out;
  }
  out.push(line([title]));
  out.push(line([...r.groupBy.map((g) => HD_DIMENSIONS[g].label), valueCol, "Based on"]));
  for (const row of r.rows) out.push(line([...row.labels, rawValue(row.value), row.n]));
  out.push(line(["Total", ...r.groupBy.slice(1).map(() => ""), rawValue(r.total.value), r.total.n]));
  return out;
}

/** The dashboard as one CSV: a header block, then each widget separated by a blank line. */
export function dashboardCsv(d: HdDashboard, results: WidgetResult[], state: DashboardState): string {
  const first = results.find((x) => x.result)?.result;
  const out: string[] = [];
  out.push(line(["Dashboard", d.name]));
  if (first) {
    out.push(line(["From", first.range.from]));
    out.push(line(["To", first.range.to]));
    out.push(line(["Time zone", first.range.timezone]));
  }
  if (state.compare) out.push(line(["Compared with", HD_COMPARE_LABEL[state.compare]]));
  for (const { widget, result, error } of results) {
    out.push("");
    if (!result) {
      out.push(line([widget.title, error ?? "Not available"]));
      continue;
    }
    out.push(...resultCsvLines(widget.title, result));
  }
  return out.join("\r\n") + "\r\n";
}

export { headline } from "./shared";

/** Escape a typed name for a markdown table cell. */
export function mdCell(s: string): string {
  return s.replace(/[\\`*_{}[\]()#+!|<>~]/g, (c) => `\\${c}`).replace(/[\r\n]+/g, " ");
}

/** The digest's summary table: one row per widget (its total), at most 24. */
export function digestSummary(results: WidgetResult[]): string {
  const rows = results.filter((x) => x.result);
  if (!rows.length) return "No numbers for this period.";
  const out = ["| Measure | Value | Change |", "| --- | --- | --- |"];
  const seen = new Set<string>();
  for (const { widget, result } of rows) {
    const key = JSON.stringify([widget.measure, widget.filters]);
    if (seen.has(key)) continue;
    seen.add(key);
    const h = headline(result!);
    out.push(`| ${mdCell(widget.title)} | ${mdCell(h.value)} | ${mdCell(h.change || "–")} |`);
  }
  return out.join("\n");
}
