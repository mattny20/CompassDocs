"use client";

import { useState } from "react";
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
  "auth.lockout": "Login lockout engaged",
  "ack.requested": "Acknowledgement requested",
  "ack.reminder_sent": "Acknowledgement reminder sent",
  "scim.user_create": "SCIM provisioned user",
  "scim.user_update": "SCIM updated user",
  "scim.user_disable": "SCIM deactivated user",
  "scim.user_enable": "SCIM reactivated user",
  "scim.token_generated": "SCIM token generated",
  "scim.enabled": "SCIM provisioning enabled",
  "scim.disabled": "SCIM provisioning disabled",
  "document.restore_version": "Restored previous version",
  "document.branch_create": "Created draft branch",
  "document.branch_merge": "Merged draft branch",
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
  "settings.email_template": "Edited email template",
  "settings.email_template_reset": "Reset email template",
  "settings.section_access": "Changed section access",
  "settings.template_created": "Created document template",
  "settings.template_updated": "Edited document template",
  "settings.template_reset": "Reset document template",
  "settings.template_deleted": "Deleted document template",
  "document.review_schedule": "Changed review schedule",
  "document.reviewed": "Marked document reviewed",
  "document.share_created": "Created share link",
  "document.share_revoked": "Revoked share link",
  "settings.semantic_search": "Updated semantic search settings",
  "settings.semantic_reindex": "Rebuilt semantic index",
  "settings.backup_destination_removed": "Removed backup destination",
  "backup.create": "Created backup",
  "backup.delete": "Deleted backup",
  "backup.restore": "Restored backup",
  "audit.export": "Exported audit log",
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
  const pages = Math.max(1, Math.ceil(total / limit));

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
    const res = await fetch(`/api/admin/audit?${params}`);
    if (res.ok) {
      const data = await res.json();
      setRows(data.rows);
      setTotal(data.total);
      setPage(data.page);
    }
    setLoading(false);
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
              className="rounded-lg border border-slate-200 bg-surface px-2 py-1.5 text-sm text-slate-700 outline-hidden focus:border-compass-400"
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
              className="rounded-lg border border-slate-200 bg-surface px-2 py-1.5 text-sm text-slate-700 outline-hidden focus:border-compass-400"
            />
          </label>
          <select
            value={category}
            onChange={(e) => {
              setCategory(e.target.value);
              load(0, e.target.value);
            }}
            className="rounded-lg border border-slate-200 bg-surface px-3 py-2 text-sm outline-hidden focus:border-compass-400"
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
              title="Audit-log export is an enterprise feature."
              className="cursor-not-allowed rounded-lg border border-dashed border-slate-200 px-3 py-2 text-sm font-medium text-slate-300"
            >
              Export · Enterprise
            </span>
          )}
        </div>
      </div>

      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-surface shadow-xs">
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
                    {fmt.dateTime(row.at)}
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
