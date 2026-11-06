"use client";

// Desk reports (1.19.0): one dashboard widget, a card that runs its own
// query (the dashboard's filters with the widget's overrides on top) and
// draws its chart. States, in order: loading (a skeleton the chart's
// shape), the server's error with Try again, "nothing yet" (no tickets in
// the period) or "nothing matches" (filters exclude everything, with
// Clear filters), then the chart. The ⋯ menu: Show as table / chart,
// Download CSV (tickets.export), Open in Explore. A Time logged widget also
// has Export (1.19.1): its time entries as CSV, one row per entry. In edit
// mode the card also carries Move earlier / later (the keyboard path for
// reordering; a pointer drags the card), Narrower / Wider, Configure and
// Remove.

import { useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  ChartColumn,
  ChevronsLeftRight,
  ChevronsRightLeft,
  Compass,
  Download,
  Ellipsis,
  GripVertical,
  RefreshCw,
  Settings2,
  Table2,
  Trash2,
} from "lucide-react";
import { CARD_CLASS } from "@/components/Card";
import { Button, iconButtonClass } from "@/components/Button";
import { MenuItem, MenuSeparator, Popover } from "@/components/Popover";
import { SectionEmpty } from "@/components/form";
import { Skeleton } from "@/components/Skeleton";
import { toast } from "@/components/Toasts";
import {
  HD_FILTER_KEYS,
  HD_MEASURES,
  drillHref,
  filtersEmpty,
  mergeFilters,
  type HdAnalyticsQuery,
  type HdRangeInput,
  type HdWidget,
} from "@/lib/helpdesk/analytics/shared";
import type { ReportViewState } from "@/lib/helpdesk/analytics/url-state";
import { ChartFor, DataTable } from "./charts";
import { downloadQueryCsv, downloadTimeCsv, timeExportUrl, useReportQuery } from "./data";

// The grid is two columns on a phone (numbers pair up), four from @5xl.
export const SPAN: Record<HdWidget["size"], string> = {
  1: "",
  2: "col-span-2",
  3: "col-span-2 @5xl:col-span-3",
  4: "col-span-2 @5xl:col-span-4",
};

/** The query a widget runs under a view. */
export function widgetQuery(w: Pick<HdWidget, "measure" | "groupBy" | "filters" | "type">, state: ReportViewState): HdAnalyticsQuery {
  return {
    measure: w.measure,
    groupBy: w.groupBy,
    filters: mergeFilters(state.filters, w.filters),
    range: state.range,
    compare: w.type === "live" ? null : state.compare,
    limit: w.type === "table" ? 200 : 50,
    automated: state.automated,
  };
}

function sparkDim(range: HdRangeInput): "day" | "week" | "month" {
  if ("preset" in range) return range.preset === "last_12_months" || range.preset === "this_year" ? "month" : range.preset === "last_90" || range.preset === "this_quarter" ? "week" : "day";
  const days = (Date.parse(range.to) - Date.parse(range.from)) / 86_400_000 + 1;
  return days > 366 ? "month" : days > 92 ? "week" : "day";
}

function BodySkeleton({ type }: { type: HdWidget["type"] }) {
  if (type === "kpi" || type === "live" || type === "gauge")
    return (
      <div aria-hidden>
        <Skeleton className="h-8 w-28" />
        <Skeleton className="mt-2 h-3 w-40" />
        <Skeleton className="mt-4 h-6 w-full" />
      </div>
    );
  if (type === "bar" || type === "leaderboard" || type === "table" || type === "donut")
    return (
      <div className="space-y-2.5" aria-hidden>
        {["w-11/12", "w-3/4", "w-1/2", "w-2/5", "w-1/4"].map((w) => (
          <Skeleton key={w} className={`h-4 ${w}`} />
        ))}
      </div>
    );
  return <Skeleton className="h-48 w-full" />;
}

export interface WidgetEditControls {
  index: number;
  count: number;
  onMove: (to: number) => void;
  onResize: (size: HdWidget["size"]) => void;
  onConfigure: () => void;
  onRemove: () => void;
}

export function WidgetCard({
  widget,
  state,
  canExport,
  edit,
  preview = false,
  onClearFilters,
  className = "",
  dragProps,
}: {
  widget: HdWidget;
  state: ReportViewState;
  canExport: boolean;
  edit?: WidgetEditControls | null;
  /** In the gallery and the config panel: no menu, no drill-down. */
  preview?: boolean;
  onClearFilters?: () => void;
  className?: string;
  /** Edit mode: the pointer drag handlers that reorder the grid. */
  dragProps?: React.HTMLAttributes<HTMLElement> & { draggable?: boolean };
}) {
  const q = useMemo(() => widgetQuery(widget, state), [widget, state]);
  const { result, error, loading, reload } = useReportQuery(q, { refreshMs: widget.type === "live" ? 60_000 : undefined });
  const sparkQ = useMemo(() => (widget.type === "kpi" ? { ...q, groupBy: [sparkDim(state.range)], compare: null } : null), [q, widget.type, state.range]);
  const spark = useReportQuery(sparkQ);
  const [asTable, setAsTable] = useState(false);
  const [menu, setMenu] = useState(false);
  const menuBtn = useRef<HTMLButtonElement>(null);
  const titleId = `w-${widget.id}-title`;
  const def = HD_MEASURES[widget.measure];
  const overrides = HD_FILTER_KEYS.filter((k) => (widget.filters[k]?.length ?? 0) > 0);
  const filtered = !filtersEmpty(q.filters ?? {});

  const drill = useMemo(() => {
    if (preview || !result) return null;
    return (keys: (string | number | null)[]) => drillHref(widget.measure, widget.groupBy, keys, q.filters ?? {}, result.range, { automated: state.automated });
  }, [preview, result, widget.measure, widget.groupBy, q.filters, state.automated]);

  const empty = result && result.total.n === 0 && (result.rows.length === 0 || result.rows.every((r) => !r.n));
  const canTable = widget.groupBy.length > 0;

  let body: React.ReactNode;
  if (error)
    body = (
      <p className="text-sm text-red-600">
        {error}{" "}
        <button type="button" className="link" onClick={reload}>
          Try again
        </button>
      </p>
    );
  else if (!result) body = <BodySkeleton type={widget.type} />;
  else if (empty && widget.type !== "live" && widget.type !== "kpi")
    body = filtered ? (
      <SectionEmpty action={onClearFilters ? { label: "Clear filters", onClick: onClearFilters } : undefined}>Nothing matches these filters in this period.</SectionEmpty>
    ) : (
      <SectionEmpty>No {def.group === "Workflows" ? "workflow activity" : "tickets"} in this period yet. Numbers appear here as the desk works.</SectionEmpty>
    );
  else if (asTable && canTable) body = <DataTable result={result} drill={drill} compact />;
  else body = <ChartFor type={widget.type} result={result} target={widget.target} drill={drill} spark={spark.result?.rows ?? null} />;

  const sub = [overrides.length ? `Own filters: ${overrides.length}` : null, result?.truncated ? "Top values only" : null].filter(Boolean).join(" · ");

  return (
    <section
      aria-labelledby={titleId}
      aria-busy={loading || undefined}
      data-widget={widget.id}
      {...dragProps}
      className={`${CARD_CLASS} flex min-w-0 flex-col p-3 break-inside-avoid sm:p-4 ${SPAN[widget.size]} ${edit ? "ring-1 ring-compass-200" : ""} ${className}`.trim()}
    >
      {edit && (
        <div className="-mx-1 -mt-1 mb-2 flex flex-wrap items-center gap-0.5 border-b border-slate-100 pb-1.5 print:hidden">
          <GripVertical className="mr-auto h-4 w-4 shrink-0 cursor-grab text-slate-400" aria-hidden />
          <button type="button" className={iconButtonClass("quiet", "sm")} disabled={edit.index === 0} onClick={() => edit.onMove(edit.index - 1)} data-tt="Move earlier" aria-label={`Move ${widget.title} earlier`}>
            <ArrowUp aria-hidden />
          </button>
          <button type="button" className={iconButtonClass("quiet", "sm")} disabled={edit.index === edit.count - 1} onClick={() => edit.onMove(edit.index + 1)} data-tt="Move later" aria-label={`Move ${widget.title} later`}>
            <ArrowDown aria-hidden />
          </button>
          <button type="button" className={iconButtonClass("quiet", "sm")} disabled={widget.size === 1} onClick={() => edit.onResize((widget.size - 1) as HdWidget["size"])} data-tt="Narrower" aria-label={`Make ${widget.title} narrower`}>
            <ChevronsRightLeft aria-hidden />
          </button>
          <button type="button" className={iconButtonClass("quiet", "sm")} disabled={widget.size === 4} onClick={() => edit.onResize((widget.size + 1) as HdWidget["size"])} data-tt="Wider" aria-label={`Make ${widget.title} wider`}>
            <ChevronsLeftRight aria-hidden />
          </button>
          <button type="button" className={iconButtonClass("quiet", "sm")} onClick={edit.onConfigure} data-tt="Configure" aria-label={`Configure ${widget.title}`}>
            <Settings2 aria-hidden />
          </button>
          <button type="button" className={iconButtonClass("quiet", "sm", "hover-danger")} onClick={edit.onRemove} data-tt="Remove" aria-label={`Remove ${widget.title}`}>
            <Trash2 aria-hidden />
          </button>
        </div>
      )}
      <div className="mb-3 flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-start gap-1.5">
          <div className="min-w-0">
            <h3 id={titleId} className="line-clamp-2 text-sm font-semibold break-words text-slate-800">
              {widget.title}
            </h3>
            {sub && <p className="mt-0.5 text-xs text-slate-500">{sub}</p>}
          </div>
        </div>
        {!preview && (
          <div className="-mr-1 -mt-1 flex shrink-0 items-center print:hidden">
            {loading && result && <RefreshCw className="mr-1 h-3.5 w-3.5 animate-spin text-slate-400" aria-hidden />}
            {/* Time tracking (1.19.1): the entries behind a Time logged widget, one row each (tickets.export). */}
            {!edit && canExport && widget.measure === "time_logged" && result && (
              <Button
                variant="ghost"
                size="sm"
                icon={<Download />}
                className="mr-0.5"
                data-tt="Download the time entries for this period as CSV. The team, person, request type and category filters apply."
                data-tt-wrap=""
                aria-label={`Export time entries for ${widget.title}`}
                onClick={() => downloadTimeCsv(timeExportUrl(result.range, q.filters ?? {})).catch((e: Error) => toast("error", e.message))}
              >
                Export
              </Button>
            )}
            {!edit && (
              <div className="relative">
                <button ref={menuBtn} type="button" className={iconButtonClass("quiet", "sm")} aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu((m) => !m)} data-tt="More" aria-label={`More for ${widget.title}`}>
                  <Ellipsis aria-hidden />
                </button>
                <Popover open={menu} onClose={() => setMenu(false)} triggerRef={menuBtn} role="menu" label={`More for ${widget.title}`} align="end" width="w-52">
                  {canTable && (
                    <MenuItem
                      icon={asTable ? <ChartColumn /> : <Table2 />}
                      onClick={() => {
                        setAsTable((t) => !t);
                        setMenu(false);
                      }}
                    >
                      {asTable ? "Show as chart" : "Show as table"}
                    </MenuItem>
                  )}
                  {canExport && (
                    <MenuItem
                      icon={<Download />}
                      onClick={() => {
                        setMenu(false);
                        downloadQueryCsv(q, widget.title).catch((e: Error) => toast("error", e.message));
                      }}
                    >
                      Download CSV
                    </MenuItem>
                  )}
                  <MenuSeparator />
                  <MenuItem
                    icon={<Compass />}
                    onClick={() => {
                      const p = new URLSearchParams({ q: JSON.stringify({ ...q, type: widget.type, title: widget.title }) });
                      window.location.href = `/desk/reports/explore?${p.toString()}`;
                    }}
                  >
                    Open in Explore
                  </MenuItem>
                </Popover>
              </div>
            )}
          </div>
        )}
      </div>
      <div className="min-w-0 flex-1">{body}</div>
    </section>
  );
}
