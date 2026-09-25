"use client";

// Shared bits for the directory admin panels: an ordered key list (columns in
// order, with move/remove/add) and the small helpers every panel needs.

import { useState } from "react";
import { ArrowDown, ArrowUp, X } from "lucide-react";
import { Select } from "@/components/form";

export interface KeyOption {
  key: string;
  label: string;
}

/** An ordered list of keys with move up/down, remove, and an add menu. */
export function OrderedKeyList({
  value,
  onChange,
  available,
  minimum = 1,
  addLabel = "+ Add a column…",
}: {
  value: string[];
  onChange: (next: string[]) => void;
  available: KeyOption[];
  minimum?: number;
  addLabel?: string;
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
          <div key={k} className="flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-1.5 text-sm">
            <span className="flex-1 font-medium text-slate-700">{label(k)}</span>
            <button type="button" onClick={() => move(i, -1)} disabled={i === 0} data-tt="Move up" aria-label={`Move ${label(k)} up`} className="rounded-sm p-1 text-slate-400 hover:text-slate-600 disabled:opacity-30">
              <ArrowUp className="h-3.5 w-3.5" />
            </button>
            <button type="button" onClick={() => move(i, 1)} disabled={i === value.length - 1} data-tt="Move down" aria-label={`Move ${label(k)} down`} className="rounded-sm p-1 text-slate-400 hover:text-slate-600 disabled:opacity-30">
              <ArrowDown className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => onChange(value.filter((c) => c !== k))}
              disabled={value.length <= minimum}
              data-tt="Remove"
              aria-label={`Remove ${label(k)}`}
              className="rounded-sm p-1 text-slate-400 hover:text-red-600 disabled:opacity-30"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
      </div>
      {unused.length > 0 && (
        <Select value="" onChange={(e) => e.target.value && onChange([...value, e.target.value])} className="mt-2 w-64" aria-label={addLabel}>
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
        <span className="truncate text-xs text-slate-400">{summary}</span>
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
