"use client";

import { useState } from "react";
import { buttonClass } from "@/components/Button";
import { Table, Th, Td, TABLE_HEAD_ROW, TR } from "@/components/Table";
import { useRouter } from "next/navigation";
import { Search, Trash2 } from "lucide-react";
import { TypeBadge } from "./Badges";
import { EmptyState } from "./form";
import { toast } from "./Toasts";
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
    else toast("error", (await res.json().catch(() => ({})))?.error || "Couldn't restore that document.");
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
    else
      toast("error", (await res.json().catch(() => ({})))?.error || "Couldn't delete that document.");
  }

  function purgeOn(deletedAt: string | null): string {
    if (!deletedAt || retentionDays <= 0) return "";
    const due = new Date(new Date(deletedAt).getTime() + retentionDays * 86_400_000);
    return formatDate(due.toISOString(), settings);
  }

  if (docs.length === 0) {
    return (
      <EmptyState
        icon={<Trash2 />}
        title="Trash is empty"
        body="Deleted documents will appear here."
        action={{ href: "/search", label: "Search documents", icon: <Search /> }}
      />
    );
  }

  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-surface shadow-xs">
      <Table scroll aria-busy={busyId !== null}>
        <thead className={TABLE_HEAD_ROW}>
          <tr>
            <Th>Document</Th>
            <Th fit>Deleted</Th>
            <Th fit align="right">Actions</Th>
          </tr>
        </thead>
        <tbody>
          {docs.map((d) => (
            <tr key={d.id} className={`${TR} ${busyId === d.id ? "opacity-50" : ""}`.trim()}>
              <Td>
                <div className="flex items-center gap-2">
                  <TypeBadge type={d.type} />
                  <span className="font-medium text-slate-800">{d.title}</span>
                </div>
                <div className="mt-0.5 text-xs text-slate-500">
                  {d.space_icon} {d.space_name}
                  {d.status === "draft" && " · draft"}
                </div>
              </Td>
              <Td fit className="align-top text-slate-500">
                <div title={formatDateTime(d.deleted_at, settings)}>
                  {d.deleted_at ? formatDate(d.deleted_at, settings) : "—"}
                </div>
                {retentionDays > 0 && d.deleted_at && (
                  <div className="text-xs text-slate-500">purges {purgeOn(d.deleted_at)}</div>
                )}
              </Td>
              <Td fit>
                <div className="flex justify-end gap-1.5 text-xs">
                  <button
                    onClick={() => restore(d)}
                    disabled={busyId === d.id}
                    className={buttonClass("secondary", "sm")}
                  >
                    Restore
                  </button>
                  {isAdmin && (
                    <button
                      onClick={() => purge(d)}
                      disabled={busyId === d.id}
                      className={buttonClass("danger", "sm")}
                    >
                      Delete forever
                    </button>
                  )}
                </div>
              </Td>
            </tr>
          ))}
        </tbody>
      </Table>
    </div>
  );
}
