"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";
import { useState } from "react";
import { roleAtLeast } from "@/lib/types";
import type { Role } from "@/lib/types";
import { PrintButton } from "./PrintButton";

export function DocActions({
  id,
  spaceSlug,
  role,
  isPublished,
  hasEditRights,
}: {
  id: number;
  spaceSlug: string;
  role: Role;
  isPublished: boolean;
  /** Server-resolved per-space edit rights (role alone isn't enough). */
  hasEditRights: boolean;
}) {
  const router = useRouter();
  const [deleting, setDeleting] = useState(false);

  const canEdit = roleAtLeast(role, "editor") && hasEditRights;
  const canDelete =
    hasEditRights &&
    (roleAtLeast(role, "approver") || (roleAtLeast(role, "editor") && !isPublished));

  async function onDelete() {
    if (!confirm("Move this document to the Trash? You can restore it later.")) return;
    setDeleting(true);
    const res = await fetch(`/api/documents/${id}`, { method: "DELETE" });
    if (res.ok) {
      router.push(`/spaces/${spaceSlug}`);
      router.refresh();
    } else {
      const data = await res.json().catch(() => ({}));
      setDeleting(false);
      alert(data?.error || "Failed to delete.");
    }
  }

  return (
    <div className="flex items-center gap-2 print:hidden">
      <PrintButton />
      <Link
        href={`/doc/${id}/history`}
        className="rounded-lg border border-slate-200 bg-surface px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-50"
      >
        History
      </Link>
      {canEdit && (
        <Link
          href={`/doc/${id}/edit`}
          className="rounded-lg border border-slate-200 bg-surface px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-50"
        >
          Edit
        </Link>
      )}
      {canDelete && (
        <button
          onClick={onDelete}
          disabled={deleting}
          className="rounded-lg border border-red-200 bg-surface px-3 py-1.5 text-sm font-medium text-red-600 hover:bg-red-50 disabled:opacity-50"
        >
          {deleting ? "Deleting…" : "Delete"}
        </button>
      )}
    </div>
  );
}
