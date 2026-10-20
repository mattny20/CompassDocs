"use client";

// Shared bits for the directory admin panels: an ordered key list (columns in
// order, with move/remove/add) and the small helpers every panel needs.

import { useState } from "react";
import { ArrowDown, ArrowUp, X } from "lucide-react";
import { iconButtonClass } from "@/components/Button";
import { Select } from "@/components/form";

export interface KeyOption {
  key: string;
  label: string;
}

/**
 * An ordered list of keys with move up/down, remove, and an add menu.
 * `extra` renders a per-row control between the label and the row's
 * buttons (the export preset's "Wrap after" input); the row keeps its
 * recipe, so the list columns card and the preset editor stay one list.
 * `removable={false}` is the same list for a set that is only reordered,
 * never added to or taken from (the export's Section order): no Remove, no
 * add menu.
 */
export function OrderedKeyList({
  value,
  onChange,
  available,
  minimum = 1,
  addLabel = "+ Add a column…",
  extra,
  removable = true,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  available: KeyOption[];
  minimum?: number;
  addLabel?: string;
  /** A small control for one row, given its key and label. */
  extra?: (key: string, label: string) => React.ReactNode;
  /** Whether rows can be removed and others added; false for a fixed set in an order. */
  removable?: boolean;
}) {
  const label = (k: string) => available.find((a) => a.key === k)?.label ?? k;
  const unused = available.filter((a) => !value.includes(a.key));
  function move(i: number, dir: -1 | 1) {
    const next = [...value];
    const j = i + dir;
    if (j < 0 || j >= next.length) return;
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  }
  return (
    <div>
      <div className="space-y-1">
        {value.map((k, i) => (
          // flex-wrap: on a phone the row's extra control and its buttons
          // drop under the label instead of pushing the card sideways.
          <div key={k} className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 px-3 py-1.5 text-sm">
            <span className="flex-1 font-medium text-slate-700">{label(k)}</span>
            {extra?.(k, label(k))}
            {/* Icon-only row actions (STYLEGUIDE §Buttons): the 28px quiet box sizes the glyph. */}
            <span className="ml-auto flex items-center gap-1">
              <button type="button" onClick={() => move(i, -1)} disabled={i === 0} data-tt="Move up" aria-label={`Move ${label(k)} up`} className={iconButtonClass("quiet", "sm")}>
                <ArrowUp />
              </button>
              <button type="button" onClick={() => move(i, 1)} disabled={i === value.length - 1} data-tt="Move down" aria-label={`Move ${label(k)} down`} className={iconButtonClass("quiet", "sm")}>
                <ArrowDown />
              </button>
              {removable && (
                <button
                  type="button"
                  onClick={() => onChange(value.filter((c) => c !== k))}
                  disabled={value.length <= minimum}
                  data-tt="Remove"
                  aria-label={`Remove ${label(k)}`}
                  className={iconButtonClass("quiet", "sm")}
                >
                  <X />
                </button>
              )}
            </span>
          </div>
        ))}
      </div>
      {removable && unused.length > 0 && (
        // hasError={false}: a wrapping Field's error belongs to one row's
        // extra control, not to the add menu. w-full max-w-64: 16rem, but
        // never wider than a phone's card.
        <Select value="" onChange={(e) => e.target.value && onChange([...value, e.target.value])} className="mt-2 w-full max-w-64" aria-label={addLabel} hasError={false}>
          <option value="">{addLabel}</option>
          {unused.map((a) => (
            <option key={a.key} value={a.key}>
              {a.label}
            </option>
          ))}
        </Select>
      )}
    </div>
  );
}

/** A collapsible admin section: a title row that opens a body. */
export function Disclosure({
  title,
  summary,
  children,
  defaultOpen = false,
}: {
  title: React.ReactNode;
  summary?: React.ReactNode;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="rounded-lg border border-slate-200">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm"
      >
        <span className="font-medium text-slate-800">{title}</span>
        <span className="truncate text-xs text-slate-500">{summary}</span>
      </button>
      {open && <div className="border-t border-slate-100 p-3">{children}</div>}
    </div>
  );
}

export async function jsonFetch<T = any>(url: string, init?: RequestInit): Promise<{ ok: boolean; status: number; data: T }> {
  const res = await fetch(url, {
    ...init,
    headers: { ...(init?.body ? { "Content-Type": "application/json" } : {}), ...(init?.headers ?? {}) },
  });
  const data = (await res.json().catch(() => ({}))) as T;
  return { ok: res.ok, status: res.status, data };
}
