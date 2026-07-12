"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { TypeBadge } from "./Badges";
import { formatDate, formatDateTime } from "@/lib/format";
import type { AppSettings } from "@/lib/settings";
import type { DocType, DocStatus } from "@/lib/types";

interface TrashedDoc {
  id: number;
  title: string;
  type: DocType;
  status: DocStatus;
  space_name: string;
  space_icon: string;
  deleted_at: string | null;
}

export function TrashClient({
  docs,
  isAdmin,
  settings,
  retentionDays,
}: {
  docs: TrashedDoc[];
  isAdmin: boolean;
  settings: AppSettings;
  retentionDays: number;
}) {
  const router = useRouter();
  const [busyId, setBusyId] = useState<number | null>(null);

  async function restore(d: TrashedDoc) {
    setBusyId(d.id);
    const res = await fetch(`/api/trash/${d.id}`, { method: "POST" });
    setBusyId(null);
    if (res.ok) router.refresh();
    else alert((await res.json().catch(() => ({})))?.error || "Restore failed.");
  }

  async function purge(d: TrashedDoc) {
    if (
      !confirm(
        `Permanently delete "${d.title}"? This cannot be undone — all versions are removed.`
      )
    )
      return;
    setBusyId(d.id);
    const res = await fetch(`/api/trash/${d.id}`, { method: "DELETE" });
    setBusyId(null);
    if (res.ok) router.refresh();
    else alert((await res.json().catch(() => ({})))?.error || "Delete failed.");
  }

  function purgeOn(deletedAt: string | null): string {
    if (!deletedAt || retentionDays <= 0) return "";
    const due = new Date(new Date(deletedAt).getTime() + retentionDays * 86_400_000);
    return formatDate(due.toISOString(), settings);
  }

  if (docs.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-slate-200 bg-surface px-6 py-16 text-center">
        <div className="text-3xl">🗑️</div>
        <p className="mt-2 font-medium text-slate-700">Trash is empty</p>
        <p className="text-sm text-slate-500">Deleted documents will appear here.</p>
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-surface shadow-sm">
      <table className="w-full text-sm">
        <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-400">
          <tr>
            <th className="px-4 py-2 font-medium">Document</th>
            <th className="px-4 py-2 font-medium">Deleted</th>
            <th className="px-4 py-2 text-right font-medium">Actions</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {docs.map((d) => (
            <tr key={d.id} className={busyId === d.id ? "opacity-50" : ""}>
              <td className="px-4 py-3">
                <div className="flex items-center gap-2">
                  <TypeBadge type={d.type} />
                  <span className="font-medium text-slate-800">{d.title}</span>
                </div>
                <div className="mt-0.5 text-xs text-slate-400">
                  {d.space_icon} {d.space_name}
                  {d.status === "draft" && " · draft"}
                </div>
              </td>
              <td className="px-4 py-3 align-top text-slate-500">
                <div title={formatDateTime(d.deleted_at, settings)}>
                  {d.deleted_at ? formatDate(d.deleted_at, settings) : "—"}
                </div>
                {retentionDays > 0 && d.deleted_at && (
                  <div className="text-xs text-slate-400">purges {purgeOn(d.deleted_at)}</div>
                )}
              </td>
              <td className="px-4 py-3">
                <div className="flex justify-end gap-1.5 text-xs">
                  <button
                    onClick={() => restore(d)}
                    disabled={busyId === d.id}
                    className="rounded-md border border-slate-200 px-2 py-1 font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50"
                  >
                    Restore
                  </button>
                  {isAdmin && (
                    <button
                      onClick={() => purge(d)}
                      disabled={busyId === d.id}
                      className="rounded-md border border-red-200 px-2 py-1 font-medium text-red-600 hover:bg-red-50 disabled:opacity-50"
                    >
                      Delete forever
                    </button>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
