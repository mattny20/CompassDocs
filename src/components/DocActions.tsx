"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";
import { useState } from "react";
import { roleAtLeast } from "@/lib/types";
import type { Role } from "@/lib/types";

export function DocActions({
  id,
  spaceSlug,
  role,
  isPublished,
}: {
  id: number;
  spaceSlug: string;
  role: Role;
  isPublished: boolean;
}) {
  const router = useRouter();
  const [deleting, setDeleting] = useState(false);

  const canEdit = roleAtLeast(role, "editor");
  const canDelete = roleAtLeast(role, "approver") || (roleAtLeast(role, "editor") && !isPublished);

  async function onDelete() {
    if (!confirm("Delete this document? This cannot be undone.")) return;
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
    <div className="flex items-center gap-2">
      <Link
        href={`/doc/${id}/history`}
        className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-50"
      >
        History
      </Link>
      {canEdit && (
        <Link
          href={`/doc/${id}/edit`}
          className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-50"
        >
          Edit
        </Link>
      )}
      {canDelete && (
        <button
          onClick={onDelete}
          disabled={deleting}
          className="rounded-lg border border-red-200 bg-white px-3 py-1.5 text-sm font-medium text-red-600 hover:bg-red-50 disabled:opacity-50"
        >
          {deleting ? "Deleting…" : "Delete"}
        </button>
      )}
    </div>
  );
}
