// Helpdesk 1.19.0 reports (agent K): a dashboard's filter bar in the
// address, so a link opens the same view (and an export or a digest link
// carries it). Pure, safe in client components.
//
//   /desk/reports?d=3&range=last_7&cmp=previous_year&team=2,5&priority=high&auto=1
//   /desk/reports?from=2026-10-01&to=2026-10-31&cmp=none
//
// d = dashboard id · range = a preset, or from + to · cmp = previous_period
// | previous_year | none · auto=1 counts automated tickets (alerts, API) ·
// every filter key (team, assignee, request_type, priority, channel,
// status, category, tag, workflow) as a comma list. Absent keys keep the
// dashboard's own defaults.

import {
  HD_FILTER_KEYS,
  isDate,
  isPreset,
  parseFilters,
  type HdCompare,
  type HdDashboardLayout,
  type HdFilters,
  type HdRangeInput,
} from "./shared";

export interface ReportViewState {
  filters: HdFilters;
  range: HdRangeInput;
  compare: HdCompare | null;
  automated: boolean;
}

type Params = { get(name: string): string | null };

export function defaultState(layout?: Pick<HdDashboardLayout, "filters" | "range" | "compare" | "automated"> | null): ReportViewState {
  return {
    filters: layout?.filters ?? {},
    range: layout?.range ?? { preset: "last_30" },
    compare: layout ? layout.compare : "previous_period",
    automated: layout?.automated === true,
  };
}

/** The view in an address, over the dashboard's defaults. Bad values are ignored, never fatal. */
export function stateFromParams(sp: Params, defaults: ReportViewState): ReportViewState {
  const out: ReportViewState = { ...defaults, filters: { ...defaults.filters } };
  const range = sp.get("range");
  const from = sp.get("from");
  const to = sp.get("to");
  if (isPreset(range)) out.range = { preset: range };
  else if (isDate(from) && isDate(to)) out.range = from <= to ? { from, to } : { from: to, to: from };
  const cmp = sp.get("cmp");
  if (cmp === "previous_period" || cmp === "previous_year") out.compare = cmp;
  else if (cmp === "none") out.compare = null;
  const auto = sp.get("auto");
  if (auto === "1") out.automated = true;
  else if (auto === "0") out.automated = false;
  const raw: Record<string, string[]> = {};
  let any = false;
  for (const k of HD_FILTER_KEYS) {
    const v = sp.get(k);
    if (v === null) continue;
    any = true;
    raw[k] = v === "" ? [] : v.split(",").slice(0, 50).map((x) => decodeURIComponent(x));
  }
  if (any) {
    const parsed = parseFilters({ ...out.filters, ...raw });
    if (parsed.ok) out.filters = parsed.value;
  }
  return out;
}

/** The address query for a view: only what differs from the dashboard's defaults. */
export function stateToParams(state: ReportViewState, defaults: ReportViewState, extra: Record<string, string> = {}): URLSearchParams {
  const p = new URLSearchParams(extra);
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  if (!same(state.range, defaults.range)) {
    if ("preset" in state.range) p.set("range", state.range.preset);
    else {
      p.set("from", state.range.from);
      p.set("to", state.range.to);
    }
  }
  if (state.compare !== defaults.compare) p.set("cmp", state.compare ?? "none");
  if (state.automated !== defaults.automated) p.set("auto", state.automated ? "1" : "0");
  for (const k of HD_FILTER_KEYS) {
    const a = state.filters[k] ?? [];
    const b = defaults.filters[k] ?? [];
    if (!same(a, b)) p.set(k, (a as (string | number)[]).map((x) => encodeURIComponent(String(x))).join(","));
  }
  return p;
}
