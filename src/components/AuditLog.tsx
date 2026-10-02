"use client";

import { useState } from "react";
import { chipClass } from "@/components/Chip";
import { buttonClass } from "@/components/Button";
import { Table, Th, Td, TABLE_HEAD_ROW, TR } from "@/components/Table";
import { busyClass } from "@/components/Spinner";
import { Pager } from "@/components/Pager";
import { controlClass, SectionEmpty } from "@/components/form";
import { toast } from "@/components/Toasts";
import { actionLabel, humanise } from "@/lib/audit-labels";
import { useFormatDate } from "./SettingsProvider";

interface AuditRow {
  id: string;
  at: string;
  actor_id: number | null;
  actor_name: string;
  actor_role: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  target_label: string | null;
  details: Record<string, unknown> | null;
  ip: string | null;
}

interface Initial {
  rows: AuditRow[];
  total: number;
  categories: string[];
  limit: number;
}

// Action labels live in lib/audit-labels (shared with the export); the
// category chip is a label, not a state, so every one renders neutral. A
// rainbow of seven hues read as seven alert levels.

/** A detail value as words: arrays join, objects are counted, booleans say
 *  yes/no, and anything with underscores reads as a sentence. */
function detailValue(v: unknown): string {
  if (Array.isArray(v)) return v.map(detailValue).join(", ");
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (typeof v === "object" && v !== null) return `${Object.keys(v).length} field${Object.keys(v).length === 1 ? "" : "s"}`;
  const s = String(v);
  return /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/.test(s) ? humanise(s).toLowerCase() : s;
}

function detailText(row: AuditRow): string {
  const d = row.details;
  if (!d) return "";
  if (row.action === "user.role_change" && d.from && d.to) return `${d.from} → ${d.to}`;
  const parts = Object.entries(d)
    .filter(([, v]) => v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && v.length === 0))
    .map(([k, v]) => `${humanise(k)}: ${detailValue(v)}`);
  return parts.join(" · ");
}

export function AuditLog({
  initial,
  exportEnabled = false,
}: {
  initial: Initial;
  exportEnabled?: boolean;
}) {
  const fmt = useFormatDate();
  const [rows, setRows] = useState<AuditRow[]>(initial.rows);
  const [total, setTotal] = useState(initial.total);
  const [page, setPage] = useState(0);
  const [category, setCategory] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [loading, setLoading] = useState(false);

  const limit = initial.limit;

  function filterParams(f: string, t: string, cat: string): URLSearchParams {
    const params = new URLSearchParams();
    if (cat) params.set("category", cat);
    if (f) params.set("from", f);
    if (t) params.set("to", t);
    return params;
  }

  async function load(nextPage: number, cat: string, f = from, t = to) {
    setLoading(true);
    const params = filterParams(f, t, cat);
    params.set("page", String(nextPage));
    params.set("limit", String(limit));
    try {
      const res = await fetch(`/api/admin/audit?${params}`);
      if (!res.ok) throw new Error(String(res.status));
      const data = await res.json();
      setRows(data.rows);
      setTotal(data.total);
      setPage(data.page);
    } catch {
      toast("error", "Couldn't load the audit log.");
    } finally {
      setLoading(false);
    }
  }

  function exportHref(format: "csv" | "json"): string {
    const params = filterParams(from, to, category);
    params.set("format", format);
    return `/api/admin/audit/export?${params}`;
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="mt-1 text-sm text-slate-500">
            A record of security- and content-significant actions. {total} event{total === 1 ? "" : "s"}.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1.5 text-xs text-slate-500">
            From
            <input
              type="date"
              value={from}
              onChange={(e) => {
                setFrom(e.target.value);
                load(0, category, e.target.value, to);
              }}
              className={controlClass(false, "w-auto px-2", true)}
            />
          </label>
          <label className="flex items-center gap-1.5 text-xs text-slate-500">
            To
            <input
              type="date"
              value={to}
              onChange={(e) => {
                setTo(e.target.value);
                load(0, category, from, e.target.value);
              }}
              className={controlClass(false, "w-auto px-2", true)}
            />
          </label>
          <select
            value={category}
            onChange={(e) => {
              setCategory(e.target.value);
              load(0, e.target.value);
            }}
            className={controlClass(false, "w-auto")}
          >
            <option value="">All categories</option>
            {initial.categories.map((c) => (
              <option key={c} value={c}>
                {humanise(c)}
              </option>
            ))}
          </select>
          <button
            onClick={() => load(page, category)}
            disabled={loading}
            className={buttonClass("secondary")}
          >
            {loading ? "…" : "Refresh"}
          </button>
          {exportEnabled ? (
            <div className="flex overflow-hidden rounded-lg border border-slate-200">
              <a
                href={exportHref("csv")}
                download
                className="px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50"
              >
                Export CSV
              </a>
              <a
                href={exportHref("json")}
                download
                className="border-l border-slate-200 px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50"
              >
                JSON
              </a>
            </div>
          ) : (
            <span
              data-tt="Audit-log export is an enterprise feature."
              className="cursor-not-allowed rounded-lg border border-dashed border-slate-200 px-3 py-2 text-sm font-medium text-slate-300"
            >
              Export · Enterprise
            </span>
          )}
        </div>
      </div>

      <Pager page={page} limit={limit} total={total} onPage={(p) => load(p, category)} busy={loading} className="mb-3" />
      <div className={`rounded-xl border border-slate-200 bg-surface shadow-xs ${busyClass(loading)}`} aria-busy={loading}>
        <Table sticky>
          <thead className={TABLE_HEAD_ROW}>
            <tr>
              <Th fit>When</Th>
              <Th>Who</Th>
              <Th>Action</Th>
              <Th>Target</Th>
              <Th fit>IP</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const detail = detailText(row);
              return (
                <tr key={row.id} className={`${TR} align-top`}>
                  <Td fit className="text-slate-500">
                    {fmt.dateTime(row.at)}
                  </Td>
                  <Td>
                    <span className="font-medium text-slate-800">{row.actor_name}</span>
                    {row.actor_role && (
                      <span className="ml-1 text-xs text-slate-500">({row.actor_role})</span>
                    )}
                  </Td>
                  <Td>
                    <span
                      className={chipClass("neutral")}
                    >
                      {actionLabel(row.action)}
                    </span>
                    {detail && <div className="mt-1 text-xs text-slate-500">{detail}</div>}
                  </Td>
                  <Td className="break-all text-slate-600">
                    {row.target_label || (row.target_id ? `#${row.target_id}` : "—")}
                    {row.target_type && (
                      <span className="ml-1 text-xs text-slate-500">{humanise(row.target_type).toLowerCase()}</span>
                    )}
                  </Td>
                  <Td fit className="font-mono text-xs text-slate-500">
                    {row.ip || "—"}
                  </Td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-10 text-center">
                  <SectionEmpty>No audit events yet.</SectionEmpty>
                </td>
              </tr>
            )}
          </tbody>
        </Table>
      </div>

      <Pager page={page} limit={limit} total={total} onPage={(p) => load(p, category)} busy={loading} />
    </div>
  );
}
