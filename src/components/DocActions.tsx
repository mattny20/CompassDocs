"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";
import { useState } from "react";
import { GitBranch, History, LayoutTemplate, Pencil, Trash2, LoaderCircle } from "lucide-react";
import { roleAtLeast } from "@/lib/types";
import type { Role } from "@/lib/types";
import { PrintButton } from "./PrintButton";

export function DocActions({
  id,
  spaceSlug,
  role,
  isPublished,
  hasEditRights,
  isBranch = false,
}: {
  id: number;
  spaceSlug: string;
  role: Role;
  isPublished: boolean;
  /** Server-resolved per-space edit rights (role alone isn't enough). */
  hasEditRights: boolean;
  /** Branches can't be branched again. */
  isBranch?: boolean;
}) {
  const router = useRouter();
  const [deleting, setDeleting] = useState(false);
  const [branching, setBranching] = useState(false);
  const [templating, setTemplating] = useState(false);

  const canEdit = roleAtLeast(role, "editor") && hasEditRights;
  const canDelete =
    hasEditRights &&
    (roleAtLeast(role, "approver") || (roleAtLeast(role, "editor") && !isPublished));

  async function onBranch() {
    setBranching(true);
    const res = await fetch(`/api/documents/${id}/branch`, { method: "POST" });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      router.push(`/doc/${data.branch.id}/edit`);
      router.refresh();
    } else {
      setBranching(false);
      alert(data?.error || "Couldn't create the branch.");
    }
  }

  async function onSaveAsTemplate() {
    const name = prompt("Template name — writers will see it in the template picker:");
    if (!name?.trim()) return;
    setTemplating(true);
    const res = await fetch("/api/admin/templates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from_doc_id: id, name: name.trim() }),
    });
    const data = await res.json().catch(() => ({}));
    setTemplating(false);
    if (res.ok) router.push("/admin/templates");
    else alert(data?.error || "Couldn't create the template.");
  }

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

  // Icon-only actions with tooltips + accessible labels for a cleaner header.
  const iconBtn =
    "inline-flex items-center rounded-lg border border-slate-200 bg-surface p-2 text-slate-500 hover:bg-slate-50 hover:text-slate-700";
  return (
    <div className="flex items-center gap-2 print:hidden">
      <PrintButton iconOnly />
      <Link
        href={`/doc/${id}/history`}
        title="Version history"
        aria-label="Version history"
        className={iconBtn}
      >
        <History className="h-4 w-4" />
      </Link>
      {canEdit && !isBranch && (
        <button
          onClick={onBranch}
          disabled={branching}
          title="New draft branch"
          aria-label="Create a draft branch"
          className={iconBtn + " disabled:opacity-50"}
        >
          {branching ? (
            <LoaderCircle className="h-4 w-4 animate-spin" />
          ) : (
            <GitBranch className="h-4 w-4" />
          )}
        </button>
      )}
      {role === "admin" && !isBranch && (
        <button
          onClick={onSaveAsTemplate}
          disabled={templating}
          title="Save as template"
          aria-label="Save this document as a template"
          className={iconBtn + " disabled:opacity-50"}
        >
          {templating ? (
            <LoaderCircle className="h-4 w-4 animate-spin" />
          ) : (
            <LayoutTemplate className="h-4 w-4" />
          )}
        </button>
      )}
      {canEdit && (
        <Link href={`/doc/${id}/edit`} title="Edit" aria-label="Edit document" className={iconBtn}>
          <Pencil className="h-4 w-4" />
        </Link>
      )}
      {canDelete && (
        <button
          onClick={onDelete}
          disabled={deleting}
          title="Move to Trash"
          aria-label="Move document to Trash"
          className="inline-flex items-center rounded-lg border border-red-200 bg-surface p-2 text-red-600 hover:bg-red-50 disabled:opacity-50 dark:border-red-800/70"
        >
          {deleting ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
        </button>
      )}
    </div>
  );
}
