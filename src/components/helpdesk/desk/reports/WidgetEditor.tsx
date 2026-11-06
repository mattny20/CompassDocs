"use client";

// Desk reports (1.19.0): building widgets. The gallery (Add widget) shows
// one ready-made starting point per widget type, each drawn live with the
// dashboard's filters, so people pick by what they see. The side panel
// configures one widget: title, type, measure (grouped, with what it
// means), up to two splits, the widget's own filters, its width and a
// target, with a live preview that redraws as the choices change. A choice
// that cannot work says why (widgetProblem) and Apply waits for it.

import { useMemo, useState } from "react";
import { Plus, X } from "lucide-react";
import { Modal } from "@/components/Modal";
import { Button, iconButtonClass } from "@/components/Button";
import { Field, Select, TextInput } from "@/components/form";
import { Segmented } from "@/components/Segmented";
import { HD_WIDGET_GALLERY } from "@/lib/helpdesk/analytics/builtins";
import {
  HD_DIMENSIONS,
  HD_MEASURES,
  HD_MEASURE_GROUPS,
  HD_MEASURE_KEYS,
  HD_WIDGET_TYPES,
  HD_WIDGET_TYPE_KEYS,
  dimensionsFor,
  newWidgetId,
  widgetProblem,
  type HdDimension,
  type HdDimensionDef,
  type HdMeasureDef,
  type HdMeasureKey,
  type HdWidget,
  type HdWidgetType,
} from "@/lib/helpdesk/analytics/shared";
import type { ReportViewState } from "@/lib/helpdesk/analytics/url-state";
import { FilterChips } from "./FilterBar";
import { WidgetCard } from "./Widget";
import type { ReportOptions } from "./data";

export function WidgetGallery({ open, onClose, onPick, state }: { open: boolean; onClose: () => void; onPick: (w: HdWidget) => void; state: ReportViewState }) {
  return (
    <Modal open={open} onClose={onClose} labelledBy="hd-gallery-title" className="max-h-[90vh] w-full max-w-5xl overflow-y-auto rounded-xl border border-slate-200 bg-canvas p-5 shadow-modal">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h2 id="hd-gallery-title" className="text-lg font-semibold text-slate-900">
            Add a widget
          </h2>
          <p className="mt-0.5 text-sm text-slate-500">Each one shows your own numbers. Pick one, then change what it measures in the next step.</p>
        </div>
        <button type="button" onClick={onClose} className={iconButtonClass("quiet", "md")} data-tt="Close" aria-label="Close">
          <X aria-hidden />
        </button>
      </div>
      <ul className="card-grid [--card-min:17rem] gap-4">
        {HD_WIDGET_GALLERY.map(({ type, widget }) => {
          const w: HdWidget = { ...widget, id: `g-${type}`, size: 1 };
          return (
            <li key={type} className="flex flex-col rounded-xl border border-slate-200 bg-surface shadow-xs">
              <div className="border-b border-slate-100 px-4 py-3">
                <p className="text-sm font-semibold text-slate-800">{HD_WIDGET_TYPES[type].label}</p>
                <p className="mt-0.5 text-xs text-slate-500">{HD_WIDGET_TYPES[type].description}</p>
              </div>
              <div className="pointer-events-none flex-1 [&>section]:border-0 [&>section]:shadow-none" inert>
                <WidgetCard widget={w} state={state} canExport={false} preview />
              </div>
              <div className="border-t border-slate-100 px-4 py-3">
                <Button size="sm" variant="secondary" icon={<Plus />} onClick={() => onPick({ ...widget, id: newWidgetId() })} aria-label={`Add ${HD_WIDGET_TYPES[type].label.toLowerCase()}`}>
                  Add
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
    </Modal>
  );
}

const SIZE_OPTIONS = [
  { value: "1", label: "¼" , hint: "A quarter of the row" },
  { value: "2", label: "½", hint: "Half the row" },
  { value: "3", label: "¾", hint: "Three quarters of the row" },
  { value: "4", label: "Full", hint: "The whole row" },
] as const;

/** A sensible split for a type when the measure changes under it. */
function fixSplits(type: HdWidgetType, measure: HdMeasureKey, groupBy: HdDimension[]): HdDimension[] {
  const allowed = dimensionsFor(measure);
  const kept = groupBy.filter((d) => allowed.includes(d));
  if (!widgetProblem({ type, measure, groupBy: kept })) return kept;
  const guesses: Record<HdWidgetType, HdDimension[]> = {
    kpi: [],
    live: [],
    gauge: [],
    line: ["day"],
    area: ["day"],
    bar: ["team"],
    leaderboard: ["assignee"],
    stacked: ["week", "team"],
    table: ["team"],
    donut: ["channel"],
    heatmap: ["weekday", "hour"],
  };
  const g = guesses[type].filter((d) => allowed.includes(d));
  return g.length === guesses[type].length ? g : kept;
}

export function WidgetPanel({
  initial,
  onApply,
  onClose,
  state,
  options,
}: {
  initial: HdWidget;
  onApply: (w: HdWidget) => void;
  onClose: () => void;
  state: ReportViewState;
  options: ReportOptions | null;
}) {
  const [w, setW] = useState<HdWidget>(initial);
  const def: HdMeasureDef = HD_MEASURES[w.measure];
  const allowed = dimensionsFor(w.measure);
  const problem = widgetProblem(w);
  const set = (patch: Partial<HdWidget>) => setW((cur) => ({ ...cur, ...patch }));
  const minutes = def.unit === "minutes";
  const targetIn = (v: number | undefined) => (v === undefined ? "" : String(minutes ? Math.round((v / 60) * 100) / 100 : v));
  const targetOut = (s: string) => (s === "" ? undefined : minutes ? Math.round(Number(s) * 60) : Number(s));
  const previewWidget = useMemo(() => ({ ...w, size: 4 as const }), [w]);
  const dimHint = (d: HdDimension | undefined) => (d ? (HD_DIMENSIONS[d] as HdDimensionDef).hint : undefined);

  return (
    <Modal open onClose={onClose} layout="fill" labelledBy="hd-widget-panel-title" closeOnBackdrop={false}>
      <div className="flex h-full justify-end" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
        <div className="flex h-full w-full max-w-xl flex-col border-l border-slate-200 bg-surface shadow-modal">
          <div className="flex items-center justify-between gap-2 border-b border-slate-100 px-5 py-3">
            <h2 id="hd-widget-panel-title" className="text-base font-semibold text-slate-900">
              Configure widget
            </h2>
            <button type="button" onClick={onClose} className={iconButtonClass("quiet", "md")} data-tt="Close" aria-label="Close">
              <X aria-hidden />
            </button>
          </div>
          <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
            <div className="rounded-xl bg-canvas p-3" aria-label="Preview">
              <p className="mb-2 text-2xs font-semibold uppercase tracking-wider text-slate-500">Preview</p>
              {problem ? (
                <p className="notice-warn rounded-lg border px-3 py-2 text-sm">{problem}</p>
              ) : (
                <WidgetCard widget={previewWidget} state={state} canExport={false} preview />
              )}
            </div>
            <Field label="Title">
              <TextInput value={w.title} maxLength={80} onChange={(e) => set({ title: e.target.value })} data-autofocus />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Shown as" help={HD_WIDGET_TYPES[w.type].description}>
                <Select
                  value={w.type}
                  onChange={(e) => {
                    const type = e.target.value as HdWidgetType;
                    set({ type, groupBy: fixSplits(type, w.measure, w.groupBy) });
                  }}
                >
                  {HD_WIDGET_TYPE_KEYS.map((t) => (
                    <option key={t} value={t}>
                      {HD_WIDGET_TYPES[t].label}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Measure" help={def.description}>
                <Select
                  value={w.measure}
                  onChange={(e) => {
                    const measure = e.target.value as HdMeasureKey;
                    const old = HD_MEASURES[w.measure].label;
                    set({ measure, groupBy: fixSplits(w.type, measure, w.groupBy), title: w.title === old || !w.title ? HD_MEASURES[measure].label : w.title });
                  }}
                >
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
              <Field label="Split by" help={dimHint(w.groupBy[0])}>
                <Select
                  value={w.groupBy[0] ?? ""}
                  onChange={(e) => {
                    const v = e.target.value as HdDimension | "";
                    set({ groupBy: v ? [v, ...w.groupBy.slice(1).filter((d) => d !== v)] : [] });
                  }}
                >
                  <option value="">Nothing (one total)</option>
                  {allowed.map((d) => (
                    <option key={d} value={d}>
                      {HD_DIMENSIONS[d].label}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Then by" help={dimHint(w.groupBy[1])}>
                <Select
                  value={w.groupBy[1] ?? ""}
                  disabled={!w.groupBy[0]}
                  onChange={(e) => {
                    const v = e.target.value as HdDimension | "";
                    set({ groupBy: v ? [w.groupBy[0], v] : w.groupBy.slice(0, 1) });
                  }}
                >
                  <option value="">Nothing</option>
                  {allowed
                    .filter((d) => d !== w.groupBy[0])
                    .map((d) => (
                      <option key={d} value={d}>
                        {HD_DIMENSIONS[d].label}
                      </option>
                    ))}
                </Select>
              </Field>
            </div>
            <div>
              <p className="mb-1 block text-xs font-medium text-slate-500">This widget's own filters</p>
              <p className="mb-2 text-xs text-slate-500">They replace the dashboard's filters for the same field, for this widget only.</p>
              <div className="flex flex-wrap items-center gap-2">
                <FilterChips filters={w.filters} onChange={(filters) => set({ filters })} options={options} always={[]} />
              </div>
            </div>
            <div>
              <p className="mb-1 block text-xs font-medium text-slate-500">Width</p>
              <Segmented
                label="Width"
                size="sm"
                value={String(w.size) as "1" | "2" | "3" | "4"}
                onChange={(v) => set({ size: Number(v) as HdWidget["size"] })}
                options={SIZE_OPTIONS.map((o) => ({ value: o.value, label: o.label, hint: o.hint }))}
              />
            </div>
            {def.unit !== "ratio" && (
              <div className="grid gap-4 sm:grid-cols-2">
                <Field
                  label={minutes ? "Target (hours)" : def.unit === "percent" ? "Target (%)" : "Target"}
                  help={def.good === "down" ? "On target at or below this." : def.good === "up" ? "On target at or above this." : "Shown as a line; neither way is better."}
                >
                  <TextInput
                    type="number"
                    min={0}
                    step="any"
                    inputMode="decimal"
                    value={targetIn(w.target?.value)}
                    onChange={(e) => {
                      const value = targetOut(e.target.value);
                      set({ target: value === undefined ? null : { value, warn: w.target?.warn } });
                    }}
                  />
                </Field>
                <Field label={minutes ? "Close to target within (hours)" : "Close to target within"} help="Optional: amber instead of red when this close.">
                  <TextInput
                    type="number"
                    min={0}
                    step="any"
                    inputMode="decimal"
                    disabled={!w.target}
                    value={targetIn(w.target?.warn)}
                    onChange={(e) => w.target && set({ target: { value: w.target.value, warn: targetOut(e.target.value) } })}
                  />
                </Field>
              </div>
            )}
          </div>
          <div className="flex justify-end gap-2 border-t border-slate-100 px-5 py-3">
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button disabled={Boolean(problem) || !w.title.trim()} onClick={() => onApply({ ...w, title: w.title.trim() })}>
              Apply
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
