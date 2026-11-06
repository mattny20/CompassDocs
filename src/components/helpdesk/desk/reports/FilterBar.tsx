"use client";

// Desk reports (1.19.0): the dashboard's filter bar, one row above the
// widgets (dataviz: filters in one row above the charts). The date range
// (presets, or custom dates in the helpdesk's time zone), the comparison,
// then a chip per filter in use plus Team, which most desks reach for
// first, and "Add filter" for the rest; "Include alerts and API" when the
// desk has automated tickets. Under sm the bar folds into one Filters
// button that opens the same controls in a sheet.
//
// Every chip is a Popover role="menu" of menuitemcheckbox rows (the house
// picker menu); the state lives in the address (url-state), so a link
// opens the same view.

import { useId, useRef, useState } from "react";
import { CalendarRange, Check, ChevronDown, GitCompareArrows, ListFilter, Plus, X } from "lucide-react";
import { Popover } from "@/components/Popover";
import { Modal } from "@/components/Modal";
import { Button, buttonClass, iconButtonClass } from "@/components/Button";
import { Field, SectionEmpty, TextInput } from "@/components/form";
import { HD_PRIORITIES, HD_PRIORITY_LABEL, HD_STATUSES, HD_STATUS_LABEL } from "@/lib/helpdesk/types";
import {
  HD_CHANNELS,
  HD_CHANNEL_LABEL,
  HD_COMPARE_LABEL,
  HD_FILTER_KEYS,
  HD_FILTER_LABEL,
  HD_PRESETS,
  HD_PRESET_KEYS,
  filtersEmpty,
  type HdCompare,
  type HdFilterKey,
  type HdFilters,
  type HdRangeInput,
} from "@/lib/helpdesk/analytics/shared";
import type { ReportViewState } from "@/lib/helpdesk/analytics/url-state";
import type { ReportOptions } from "./data";

type Choice = { value: string | number; label: string };

/** What each filter offers, from the caller's options. */
export function filterChoices(key: HdFilterKey, o: ReportOptions | null): Choice[] {
  switch (key) {
    case "team":
      return o?.teams.map((t) => ({ value: t.id, label: t.name })) ?? [];
    case "assignee":
      return [{ value: "none", label: "Unassigned" }, ...(o?.agents.map((a) => ({ value: a.id, label: a.name })) ?? [])];
    case "request_type":
      return o?.request_types.map((t) => ({ value: t.id, label: t.name })) ?? [];
    case "workflow":
      return o?.workflows.map((t) => ({ value: t.id, label: t.name })) ?? [];
    case "priority":
      return HD_PRIORITIES.map((p) => ({ value: p, label: HD_PRIORITY_LABEL[p] }));
    case "status":
      return HD_STATUSES.map((p) => ({ value: p, label: HD_STATUS_LABEL[p] }));
    case "channel":
      return HD_CHANNELS.filter((c) => o?.has_automated || (c !== "alert" && c !== "api")).map((c) => ({ value: c, label: HD_CHANNEL_LABEL[c] }));
    case "tag":
      return o?.tags.map((t) => ({ value: t, label: t })) ?? [];
    case "category":
      return o?.categories.map((t) => ({ value: t, label: t })) ?? [];
    case "vip":
      return [
        { value: "yes", label: "VIP requesters" },
        { value: "no", label: "Everyone else" },
      ];
  }
}

function summary(key: HdFilterKey, values: (string | number)[], o: ReportOptions | null): string {
  if (!values.length) return "Any";
  const ch = filterChoices(key, o);
  const names = values.map((v) => ch.find((c) => String(c.value) === String(v))?.label ?? String(v));
  return names.length <= 2 ? names.join(", ") : `${names[0]} +${names.length - 1}`;
}

export function FilterChip({
  k,
  values,
  options,
  onChange,
  onRemove,
}: {
  k: HdFilterKey;
  values: (string | number)[];
  options: ReportOptions | null;
  onChange: (values: (string | number)[]) => void;
  onRemove?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const choices = filterChoices(k, options);
  const on = values.length > 0;
  const toggle = (v: string | number) => {
    const has = values.some((x) => String(x) === String(v));
    onChange(has ? values.filter((x) => String(x) !== String(v)) : [...values, v]);
  };
  return (
    <div className="relative inline-flex">
      <button
        ref={btn}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((x) => !x)}
        className={`inline-flex h-8 max-w-64 items-center gap-1.5 rounded-full border px-3 text-xs ${
          on ? "border-compass-200 bg-compass-50 text-compass-ink-strong" : "border-slate-200 bg-surface text-slate-700 hover:bg-slate-50"
        }`}
      >
        <span className="font-medium">{HD_FILTER_LABEL[k]}</span>
        <span className="truncate text-slate-600">{summary(k, values, options)}</span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-slate-400" aria-hidden />
      </button>
      <Popover open={open} onClose={() => setOpen(false)} triggerRef={btn} role="menu" label={HD_FILTER_LABEL[k]} width="w-64" className="max-h-80 overflow-y-auto">
        {choices.length === 0 && <SectionEmpty className="px-2 py-1.5">Nothing to pick yet.</SectionEmpty>}
        {choices.map((c) => {
          const checked = values.some((x) => String(x) === String(c.value));
          return (
            <button
              key={String(c.value)}
              type="button"
              role="menuitemcheckbox"
              aria-checked={checked}
              onClick={() => toggle(c.value)}
              className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm text-slate-700 hover:bg-slate-50"
            >
              <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${checked ? "border-compass-600 bg-compass-600 text-white" : "border-slate-300"}`} aria-hidden>
                {checked && <Check className="h-3 w-3" />}
              </span>
              <span className="min-w-0 flex-1 truncate">{c.label}</span>
            </button>
          );
        })}
        {(on || onRemove) && (
          <div className="mt-1 flex justify-between border-t border-slate-100 px-1 pt-1">
            {on ? (
              <button type="button" role="menuitem" className="link px-1 py-1 text-xs" onClick={() => onChange([])}>
                Clear
              </button>
            ) : (
              <span />
            )}
            {onRemove && (
              <button
                type="button"
                role="menuitem"
                className="link px-1 py-1 text-xs"
                onClick={() => {
                  setOpen(false);
                  onRemove();
                }}
              >
                Remove filter
              </button>
            )}
          </div>
        )}
      </Popover>
    </div>
  );
}

function RangePicker({ range, onChange, timezone }: { range: HdRangeInput; onChange: (r: HdRangeInput) => void; timezone: string }) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const [from, setFrom] = useState("preset" in range ? "" : range.from);
  const [to, setTo] = useState("preset" in range ? "" : range.to);
  const label = "preset" in range ? HD_PRESETS[range.preset] : `${range.from} to ${range.to}`;
  const bad = Boolean(from && to && from > to);
  return (
    <div className="relative">
      <button ref={btn} type="button" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((x) => !x)} className={buttonClass("secondary", "sm", "gap-1.5")}>
        <CalendarRange className="h-3.5 w-3.5" aria-hidden />
        {label}
        <ChevronDown className="h-3.5 w-3.5 text-slate-400" aria-hidden />
      </button>
      <Popover open={open} onClose={() => setOpen(false)} triggerRef={btn} role="menu" label="Date range" width="w-72">
        {HD_PRESET_KEYS.map((p) => {
          const checked = "preset" in range && range.preset === p;
          return (
            <button
              key={p}
              type="button"
              role="menuitemradio"
              aria-checked={checked}
              onClick={() => {
                onChange({ preset: p });
                setOpen(false);
              }}
              className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm text-slate-700 hover:bg-slate-50"
            >
              <span className="w-4 shrink-0" aria-hidden>
                {checked && <Check className="h-4 w-4 text-compass-600" strokeWidth={3} />}
              </span>
              {HD_PRESETS[p]}
            </button>
          );
        })}
        <div className="mt-1 border-t border-slate-100 px-2 pb-1 pt-2">
          <p className="mb-2 text-xs font-medium text-slate-600">Custom dates ({timezone})</p>
          <div className="grid grid-cols-2 gap-2">
            <Field label="From">
              <TextInput type="date" value={from} onChange={(e) => setFrom(e.target.value)} dense />
            </Field>
            <Field label="To">
              <TextInput type="date" value={to} onChange={(e) => setTo(e.target.value)} dense />
            </Field>
          </div>
          {bad && <p className="mt-1 text-xs text-red-600">The start date is after the end date.</p>}
          <Button
            size="sm"
            variant="secondary"
            className="mt-2 w-full"
            disabled={!from || !to || bad}
            onClick={() => {
              onChange({ from, to });
              setOpen(false);
            }}
          >
            Use these dates
          </Button>
        </div>
      </Popover>
    </div>
  );
}

function ComparePicker({ compare, onChange }: { compare: HdCompare | null; onChange: (c: HdCompare | null) => void }) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const opts: { v: HdCompare | null; label: string }[] = [
    { v: "previous_period", label: HD_COMPARE_LABEL.previous_period },
    { v: "previous_year", label: HD_COMPARE_LABEL.previous_year },
    { v: null, label: "Don't compare" },
  ];
  return (
    <div className="relative">
      <button ref={btn} type="button" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((x) => !x)} className={buttonClass("secondary", "sm", "gap-1.5")}>
        <GitCompareArrows className="h-3.5 w-3.5" aria-hidden />
        {compare ? `vs ${HD_COMPARE_LABEL[compare].toLowerCase()}` : "No comparison"}
        <ChevronDown className="h-3.5 w-3.5 text-slate-400" aria-hidden />
      </button>
      <Popover open={open} onClose={() => setOpen(false)} triggerRef={btn} role="menu" label="Compare with" width="w-60">
        {opts.map((o) => (
          <button
            key={String(o.v)}
            type="button"
            role="menuitemradio"
            aria-checked={compare === o.v}
            onClick={() => {
              onChange(o.v);
              setOpen(false);
            }}
            className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm text-slate-700 hover:bg-slate-50"
          >
            <span className="w-4 shrink-0" aria-hidden>
              {compare === o.v && <Check className="h-4 w-4 text-compass-600" strokeWidth={3} />}
            </span>
            {o.label}
          </button>
        ))}
      </Popover>
    </div>
  );
}

function AddFilter({ shown, onAdd }: { shown: HdFilterKey[]; onAdd: (k: HdFilterKey) => void }) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const rest = HD_FILTER_KEYS.filter((k) => !shown.includes(k));
  if (!rest.length) return null;
  return (
    <div className="relative">
      <button ref={btn} type="button" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((x) => !x)} className={buttonClass("ghost", "sm", "gap-1")}>
        <Plus className="h-3.5 w-3.5" aria-hidden /> Add filter
      </button>
      <Popover open={open} onClose={() => setOpen(false)} triggerRef={btn} role="menu" label="Add filter" width="w-52">
        {rest.map((k) => (
          <button
            key={k}
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onAdd(k);
            }}
            className="flex w-full items-center rounded-sm px-2 py-1.5 text-left text-sm text-slate-700 hover:bg-slate-50"
          >
            {HD_FILTER_LABEL[k]}
          </button>
        ))}
      </Popover>
    </div>
  );
}

/** The filter chips for a filters object (the bar, and a widget's own overrides in the editor). */
export function FilterChips({
  filters,
  onChange,
  options,
  always = ["team"],
}: {
  filters: HdFilters;
  onChange: (f: HdFilters) => void;
  options: ReportOptions | null;
  always?: HdFilterKey[];
}) {
  const [added, setAdded] = useState<HdFilterKey[]>([]);
  const shown = HD_FILTER_KEYS.filter((k) => always.includes(k) || added.includes(k) || (filters[k]?.length ?? 0) > 0);
  const set = (k: HdFilterKey, v: (string | number)[]) => {
    const next = { ...filters } as Record<string, unknown>;
    if (v.length) next[k] = v;
    else delete next[k];
    onChange(next as HdFilters);
  };
  return (
    <>
      {shown.map((k) => (
        <FilterChip
          key={k}
          k={k}
          values={(filters[k] as (string | number)[] | undefined) ?? []}
          options={options}
          onChange={(v) => set(k, v)}
          onRemove={always.includes(k) ? undefined : () => {
            setAdded((a) => a.filter((x) => x !== k));
            set(k, []);
          }}
        />
      ))}
      <AddFilter shown={shown} onAdd={(k) => setAdded((a) => [...a, k])} />
    </>
  );
}

function Controls({ state, onChange, options, stacked }: { state: ReportViewState; onChange: (s: ReportViewState) => void; options: ReportOptions | null; stacked?: boolean }) {
  const autoId = useId();
  return (
    <div className={stacked ? "flex flex-col items-start gap-3" : "flex flex-wrap items-center gap-2"}>
      <RangePicker key={JSON.stringify(state.range)} range={state.range} onChange={(range) => onChange({ ...state, range })} timezone={options?.timezone ?? "the helpdesk's time zone"} />
      <ComparePicker compare={state.compare} onChange={(compare) => onChange({ ...state, compare })} />
      {!stacked && <span className="mx-1 h-5 w-px bg-slate-200" aria-hidden />}
      <div className="flex flex-wrap items-center gap-2">
        <FilterChips filters={state.filters} onChange={(filters) => onChange({ ...state, filters })} options={options} />
      </div>
      {options?.has_automated && (
        <label htmlFor={autoId} className="inline-flex cursor-pointer items-center gap-2 text-xs text-slate-700">
          <input id={autoId} type="checkbox" checked={state.automated} onChange={(e) => onChange({ ...state, automated: e.target.checked })} />
          Include alerts and API tickets
        </label>
      )}
      {!filtersEmpty(state.filters) && (
        <button type="button" className={buttonClass("ghost", "sm", "gap-1")} onClick={() => onChange({ ...state, filters: {} })}>
          <X className="h-3.5 w-3.5" aria-hidden /> Clear filters
        </button>
      )}
    </div>
  );
}

export function FilterBar({ state, onChange, options }: { state: ReportViewState; onChange: (s: ReportViewState) => void; options: ReportOptions | null }) {
  const [sheet, setSheet] = useState(false);
  const active = HD_FILTER_KEYS.filter((k) => (state.filters[k]?.length ?? 0) > 0).length;
  return (
    <div className="print:hidden">
      <div className="hidden sm:block">
        <Controls state={state} onChange={onChange} options={options} />
      </div>
      <div className="flex items-center gap-2 sm:hidden">
        <button type="button" className={buttonClass("secondary", "sm", "gap-1.5")} onClick={() => setSheet(true)} aria-haspopup="dialog">
          <ListFilter className="h-3.5 w-3.5" aria-hidden />
          Filters{active ? ` (${active})` : ""}
        </button>
        <span className="truncate text-xs text-slate-500">{"preset" in state.range ? HD_PRESETS[state.range.preset] : `${state.range.from} to ${state.range.to}`}</span>
      </div>
      <Modal open={sheet} onClose={() => setSheet(false)} labelledBy="hd-report-filters-title" className="max-h-[85vh] w-full max-w-md overflow-y-auto rounded-xl border border-slate-200 bg-surface p-4 shadow-modal">
        <div className="mb-3 flex items-center justify-between">
          <h2 id="hd-report-filters-title" className="text-base font-semibold text-slate-900">
            Filters
          </h2>
          <button type="button" onClick={() => setSheet(false)} className={iconButtonClass("quiet", "sm")} data-tt="Close" aria-label="Close">
            <X aria-hidden />
          </button>
        </div>
        <Controls state={state} onChange={onChange} options={options} stacked />
        <Button className="mt-4 w-full" onClick={() => setSheet(false)} data-autofocus>
          Show results
        </Button>
      </Modal>
    </div>
  );
}
