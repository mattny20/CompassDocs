"use client";

import { useState } from "react";
import { formatDateTime } from "@/lib/format";
import type { AppSettings } from "@/lib/settings";

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

// Human-friendly labels for known actions; anything else falls back to the key.
const LABELS: Record<string, string> = {
  "auth.login": "Signed in",
  "auth.logout": "Signed out",
  "auth.login_failed": "Failed sign-in",
  "user.create": "Created user",
  "user.role_change": "Changed role",
  "user.reset_password": "Reset password",
  "user.enable": "Enabled user",
  "user.disable": "Disabled user",
  "user.delete": "Deleted user",
  "document.create": "Created document",
  "document.update": "Edited document",
  "document.publish": "Published document",
  "document.delete": "Deleted document",
  "document.restore": "Restored document",
  "document.purge": "Purged document",
  "change_request.submit": "Submitted for review",
  "change_request.approve": "Approved change",
  "change_request.reject": "Rejected change",
  "space.create": "Created space",
  "space.update": "Edited space",
  "space.delete": "Deleted space",
  "settings.workspace": "Updated workspace settings",
  "settings.approval_mode": "Changed approval mode",
  "settings.domain": "Updated domain & HTTPS",
  "settings.ai_model": "Changed AI model",
  "settings.ai_key_set": "Set AI API key",
  "settings.ai_key_removed": "Removed AI API key",
  "settings.backup_destination": "Updated backup destination",
  "settings.backup_destination_removed": "Removed backup destination",
  "backup.create": "Created backup",
  "backup.delete": "Deleted backup",
  "backup.restore": "Restored backup",
};

// Category → chip color.
const CAT_TONE: Record<string, string> = {
  auth: "bg-slate-100 text-slate-600",
  user: "bg-purple-100 text-purple-700",
  document: "bg-compass-100 text-compass-700",
  change_request: "bg-amber-100 text-amber-800",
  space: "bg-teal-100 text-teal-700",
  settings: "bg-blue-100 text-blue-700",
  backup: "bg-green-100 text-green-700",
};

function actionLabel(a: string): string {
  return LABELS[a] || a;
}

function detailText(row: AuditRow): string {
  const d = row.details;
  if (!d) return "";
  if (row.action === "user.role_change" && d.from && d.to) return `${d.from} → ${d.to}`;
  if (Array.isArray((d as any).fields)) return `fields: ${(d as any).fields.join(", ")}`;
  const parts = Object.entries(d)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${k}: ${v}`);
  return parts.join(" · ");
}

export function AuditLog({ initial, settings }: { initial: Initial; settings: AppSettings }) {
  const [rows, setRows] = useState<AuditRow[]>(initial.rows);
  const [total, setTotal] = useState(initial.total);
  const [page, setPage] = useState(0);
  const [category, setCategory] = useState("");
  const [loading, setLoading] = useState(false);

  const limit = initial.limit;
  const pages = Math.max(1, Math.ceil(total / limit));

  async function load(nextPage: number, cat: string) {
    setLoading(true);
    const params = new URLSearchParams({ page: String(nextPage), limit: String(limit) });
    if (cat) params.set("category", cat);
    const res = await fetch(`/api/admin/audit?${params}`);
    if (res.ok) {
      const data = await res.json();
      setRows(data.rows);
      setTotal(data.total);
      setPage(data.page);
    }
    setLoading(false);
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-slate-900">Audit log</h2>
          <p className="mt-1 text-sm text-slate-500">
            A record of security- and content-significant actions. {total} event{total === 1 ? "" : "s"}.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={category}
            onChange={(e) => {
              setCategory(e.target.value);
              load(0, e.target.value);
            }}
            className="rounded-lg border border-slate-200 bg-surface px-3 py-2 text-sm outline-none focus:border-compass-400"
          >
            <option value="">All categories</option>
            {initial.categories.map((c) => (
              <option key={c} value={c}>
                {c.replace(/_/g, " ")}
              </option>
            ))}
          </select>
          <button
            onClick={() => load(page, category)}
            disabled={loading}
            className="rounded-lg border border-slate-200 px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-60"
          >
            {loading ? "…" : "Refresh"}
          </button>
        </div>
      </div>

      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-surface shadow-sm">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-100 text-left text-xs uppercase tracking-wide text-slate-400">
              <th className="px-4 py-2.5 font-medium">When</th>
              <th className="px-4 py-2.5 font-medium">Who</th>
              <th className="px-4 py-2.5 font-medium">Action</th>
              <th className="px-4 py-2.5 font-medium">Target</th>
              <th className="px-4 py-2.5 font-medium">IP</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const cat = row.action.split(".")[0];
              const detail = detailText(row);
              return (
                <tr key={row.id} className="border-b border-slate-50 last:border-0 align-top">
                  <td className="whitespace-nowrap px-4 py-2.5 text-slate-500">
                    {formatDateTime(row.at, settings)}
                  </td>
                  <td className="px-4 py-2.5">
                    <span className="font-medium text-slate-800">{row.actor_name}</span>
                    {row.actor_role && (
                      <span className="ml-1 text-xs text-slate-400">({row.actor_role})</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5">
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-medium ${CAT_TONE[cat] || "bg-slate-100 text-slate-600"}`}
                    >
                      {actionLabel(row.action)}
                    </span>
                    {detail && <div className="mt-1 text-xs text-slate-400">{detail}</div>}
                  </td>
                  <td className="px-4 py-2.5 text-slate-600">
                    {row.target_label || (row.target_id ? `#${row.target_id}` : "—")}
                    {row.target_type && (
                      <span className="ml-1 text-xs text-slate-400">{row.target_type}</span>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-4 py-2.5 font-mono text-xs text-slate-400">
                    {row.ip || "—"}
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-10 text-center text-sm text-slate-400">
                  No audit events yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {pages > 1 && (
        <div className="flex items-center justify-between text-sm text-slate-500">
          <span>
            Page {page + 1} of {pages}
          </span>
          <div className="flex gap-2">
            <button
              onClick={() => load(page - 1, category)}
              disabled={page <= 0 || loading}
              className="rounded-lg border border-slate-200 px-3 py-1.5 font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50"
            >
              ← Newer
            </button>
            <button
              onClick={() => load(page + 1, category)}
              disabled={page >= pages - 1 || loading}
              className="rounded-lg border border-slate-200 px-3 py-1.5 font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50"
            >
              Older →
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
