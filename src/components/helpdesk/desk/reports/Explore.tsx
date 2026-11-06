"use client";

// /desk/reports/explore (1.19.0): any measure split by up to two
// dimensions, as a chart and a table side by side, with the same filter
// bar as the dashboards; then "Add to dashboard" puts it on one you can
// edit (or a new one). The question travels in the address (?q=…), so an
// exploration can be shared like a dashboard view.

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Compass, Download, LayoutDashboard, Plus } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { PageContainer } from "@/components/PageWidth";
import { Button, buttonClass } from "@/components/Button";
import { Field, Select } from "@/components/form";
import { MenuItem, MenuSeparator, Popover } from "@/components/Popover";
import { promptDialog } from "@/components/Dialog";
import { toast } from "@/components/Toasts";
import { CARD_CLASS } from "@/components/Card";
import {
  HD_DIMENSIONS,
  HD_MEASURES,
  HD_MEASURE_GROUPS,
  HD_MEASURE_KEYS,
  HD_WIDGET_TYPES,
  dimensionsFor,
  isMeasure,
  newWidgetId,
  parseFilters,
  parseRangeInput,
  widgetProblem,
  type HdDashboard,
  type HdDimension,
  type HdMeasureDef,
  type HdMeasureKey,
  type HdWidget,
  type HdWidgetType,
} from "@/lib/helpdesk/analytics/shared";
import type { ReportViewState } from "@/lib/helpdesk/analytics/url-state";
import { FilterBar } from "./FilterBar";
import { WidgetCard } from "./Widget";
import { DataTable } from "./charts";
import { createDashboard, downloadQueryCsv, listDashboards, saveDashboard, useReportOptions, useReportQuery } from "./data";
import { widgetQuery } from "./Widget";

interface Question {
  measure: HdMeasureKey;
  groupBy: HdDimension[];
  type: HdWidgetType;
  title?: string;
}

/** The chart that best fits a question, when the person has not picked one. */
function autoType(measure: HdMeasureKey, groupBy: HdDimension[]): HdWidgetType {
  const def: HdMeasureDef = HD_MEASURES[measure];
  if (!groupBy.length) return def.basis === "live" ? "live" : def.unit === "percent" ? "gauge" : "kpi";
  const k0 = HD_DIMENSIONS[groupBy[0]].kind;
  if (groupBy[0] === "weekday" && groupBy[1] === "hour") return "heatmap";
  if (k0 === "time") return groupBy.length === 2 && def.unit === "count" ? "stacked" : "line";
  if (groupBy.length === 2) return def.unit === "count" ? "stacked" : "table";
  return groupBy[0] === "assignee" ? "leaderboard" : "bar";
}

function readQuestion(sp: URLSearchParams | null): { q: Question; view: Partial<ReportViewState> } {
  const fallback: Question = { measure: "created", groupBy: ["day"], type: "line" };
  const raw = sp?.get("q");
  if (!raw) return { q: fallback, view: {} };
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    const measure = isMeasure(v.measure) ? v.measure : "created";
    const allowed = dimensionsFor(measure);
    const groupBy = (Array.isArray(v.groupBy) ? v.groupBy : []).filter((d): d is HdDimension => typeof d === "string" && allowed.includes(d as HdDimension)).slice(0, 2);
    const type = typeof v.type === "string" && v.type in HD_WIDGET_TYPES && !widgetProblem({ type: v.type as HdWidgetType, measure, groupBy }) ? (v.type as HdWidgetType) : autoType(measure, groupBy);
    const f = parseFilters(v.filters);
    const range = parseRangeInput(v.range);
    return {
      q: { measure, groupBy, type, title: typeof v.title === "string" ? v.title.slice(0, 80) : undefined },
      view: {
        ...(f.ok ? { filters: f.value } : {}),
        ...(range ? { range } : {}),
        ...(v.compare === "previous_period" || v.compare === "previous_year" || v.compare === null ? { compare: v.compare as ReportViewState["compare"] } : {}),
        ...(typeof v.automated === "boolean" ? { automated: v.automated } : {}),
      },
    };
  } catch {
    return { q: fallback, view: {} };
  }
}

function AddToDashboard({ widget }: { widget: HdWidget }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<HdDashboard[] | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (open && !list) listDashboards().then((d) => setList(d.filter((x) => x.can_edit))).catch((e: Error) => toast("error", e.message));
  }, [open, list]);
  async function addTo(d: HdDashboard) {
    setOpen(false);
    try {
      const saved = await saveDashboard(d.id, { layout: { ...d.layout, widgets: [...d.layout.widgets, { ...widget, id: newWidgetId() }] } });
      toast("ok", `Added to ${saved.name}.`, { action: { label: "Open it", onClick: () => router.push(`/desk/reports?d=${saved.id}`) } });
    } catch (e) {
      toast("error", (e as Error).message);
    }
  }
  async function addToNew() {
    setOpen(false);
    const name = await promptDialog({ title: "New dashboard", label: "Name", initial: "My dashboard", validate: (v) => (v.trim() ? undefined : "Give it a name.") });
    if (!name) return;
    try {
      const d = await createDashboard({ name: name.trim(), visibility: "private", layout: { widgets: [{ ...widget, id: newWidgetId() }], filters: {}, range: { preset: "last_30" }, compare: "previous_period" } });
      router.push(`/desk/reports?d=${d.id}`);
    } catch (e) {
      toast("error", (e as Error).message);
    }
  }
  return (
    <div className="relative">
      <button ref={btn} type="button" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)} className={buttonClass("primary", "md")}>
        <Plus className="h-4 w-4" aria-hidden /> Add to dashboard
      </button>
      <Popover open={open} onClose={() => setOpen(false)} triggerRef={btn} role="menu" label="Add to dashboard" align="end" width="w-64">
        {list === null && <p className="px-2 py-1.5 text-sm text-slate-500">Loading…</p>}
        {list?.length === 0 && <p className="px-2 py-1.5 text-xs text-slate-500">You have no dashboards to change yet.</p>}
        {list?.map((d) => (
          <MenuItem key={d.id} icon={<LayoutDashboard />} onClick={() => addTo(d)}>
            {d.name}
          </MenuItem>
        ))}
        <MenuSeparator />
        <MenuItem icon={<Plus />} onClick={addToNew}>
          A new dashboard
        </MenuItem>
      </Popover>
    </div>
  );
}

export function Explore() {
  const router = useRouter();
  const sp = useSearchParams();
  const { options } = useReportOptions();
  const initial = useMemo(() => readQuestion(sp), [sp]);
  const [q, setQ] = useState<Question>(initial.q);
  const [view, setView] = useState<ReportViewState>({ filters: {}, range: { preset: "last_30" }, compare: "previous_period", automated: false, ...initial.view });

  // Keep the question in the address (replace, so Back leaves Explore).
  useEffect(() => {
    const p = new URLSearchParams({ q: JSON.stringify({ ...q, ...view }) });
    router.replace(`/desk/reports/explore?${p.toString()}`, { scroll: false });
  }, [q, view, router]);

  const def: HdMeasureDef = HD_MEASURES[q.measure];
  const allowed = dimensionsFor(q.measure);
  const problem = widgetProblem(q);
  const widget: HdWidget = {
    id: "explore",
    type: problem ? autoType(q.measure, q.groupBy) : q.type,
    title: q.title || (q.groupBy.length ? `${def.label} by ${q.groupBy.map((g) => HD_DIMENSIONS[g].label.toLowerCase()).join(" and ")}` : def.label),
    measure: q.measure,
    groupBy: q.groupBy,
    filters: {},
    size: 4,
    target: null,
  };
  const query = useMemo(() => ({ ...widgetQuery(widget, view), limit: 200 }), [widget.measure, widget.groupBy, widget.type, view]); // eslint-disable-line react-hooks/exhaustive-deps
  const table = useReportQuery(q.groupBy.length ? query : null);
  const set = (patch: Partial<Question>) =>
    setQ((cur) => {
      const next = { ...cur, ...patch, title: undefined };
      if (patch.measure || patch.groupBy) next.type = autoType(next.measure, next.groupBy);
      return next;
    });
  const types = (Object.keys(HD_WIDGET_TYPES) as HdWidgetType[]).filter((t) => !widgetProblem({ type: t, measure: q.measure, groupBy: q.groupBy }));

  return (
    <div className="min-w-0 flex-1 overflow-y-auto">
      <PageContainer>
        <PageHeader
          icon={<Compass />}
          title="Explore"
          subtitle="Ask any question of the desk's numbers: pick a measure, split it, then keep it on a dashboard."
          back={{ href: "/desk/reports", label: "Reports" }}
          actions={
            <>
              {options?.can.export && q.groupBy.length > 0 && (
                <Button variant="secondary" icon={<Download />} onClick={() => downloadQueryCsv(query, widget.title).catch((e: Error) => toast("error", e.message))}>
                  Download CSV
                </Button>
              )}
              <AddToDashboard widget={{ ...widget, size: q.groupBy.length ? 2 : 1 }} />
            </>
          }
        />
        <div className={`${CARD_CLASS} mb-4 grid gap-4 p-4 sm:grid-cols-2 lg:grid-cols-4`}>
          <Field label="Measure" help={def.description}>
            <Select value={q.measure} onChange={(e) => set({ measure: e.target.value as HdMeasureKey, groupBy: q.groupBy.filter((d) => dimensionsFor(e.target.value as HdMeasureKey).includes(d)) })}>
              {HD_MEASURE_GROUPS.map((g) => (
                <optgroup key={g} label={g}>
                  {HD_MEASURE_KEYS.filter((k) => (HD_MEASURES[k] as HdMeasureDef).group === g).map((k) => (
                    <option key={k} value={k}>
                      {HD_MEASURES[k].label}
                    </option>
                  ))}
                </optgroup>
              ))}
            </Select>
          </Field>
          <Field label="Split by">
            <Select value={q.groupBy[0] ?? ""} onChange={(e) => set({ groupBy: e.target.value ? [e.target.value as HdDimension, ...q.groupBy.slice(1).filter((d) => d !== e.target.value)] : [] })}>
              <option value="">Nothing (one total)</option>
              {allowed.map((d) => (
                <option key={d} value={d}>
                  {HD_DIMENSIONS[d].label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Then by">
            <Select value={q.groupBy[1] ?? ""} disabled={!q.groupBy[0]} onChange={(e) => set({ groupBy: e.target.value ? [q.groupBy[0], e.target.value as HdDimension] : q.groupBy.slice(0, 1) })}>
              <option value="">Nothing</option>
              {allowed
                .filter((d) => d !== q.groupBy[0])
                .map((d) => (
                  <option key={d} value={d}>
                    {HD_DIMENSIONS[d].label}
                  </option>
                ))}
            </Select>
          </Field>
          <Field label="Shown as">
            <Select value={widget.type} onChange={(e) => setQ((cur) => ({ ...cur, type: e.target.value as HdWidgetType }))}>
              {types.map((t) => (
                <option key={t} value={t}>
                  {HD_WIDGET_TYPES[t].label}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <div className="mb-5">
          <FilterBar state={view} onChange={setView} options={options} />
        </div>
        <div className="@container">
          <div className="grid grid-cols-1 items-start gap-4 @5xl:grid-cols-5">
            <div className={q.groupBy.length ? "@5xl:col-span-3" : "@5xl:col-span-5"}>
              <WidgetCard widget={widget} state={view} canExport={Boolean(options?.can.export)} onClearFilters={() => setView({ ...view, filters: {} })} />
            </div>
            {q.groupBy.length > 0 && (
              <section className={`${CARD_CLASS} p-4 @5xl:col-span-2`} aria-labelledby="explore-table">
                <h3 id="explore-table" className="mb-3 text-sm font-semibold text-slate-800">
                  The numbers
                </h3>
                {table.error && <p className="text-sm text-red-600">{table.error}</p>}
                {!table.error && !table.result && <p className="text-sm text-slate-500">Loading…</p>}
                {table.result && <DataTable result={table.result} drill={null} compact maxRows={100} />}
              </section>
            )}
          </div>
        </div>
      </PageContainer>
    </div>
  );
}
