"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import {
  CalendarClock,
  GitBranch,
  History,
  LayoutTemplate,
  Pencil,
  Share2,
  ShieldCheck,
  Trash2,
  LoaderCircle,
} from "lucide-react";
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
  ack,
  sharePanel,
  reviewPanel,
  reviewOverdue = false,
}: {
  id: number;
  spaceSlug: string;
  role: Role;
  isPublished: boolean;
  /** Server-resolved per-space edit rights (role alone isn't enough). */
  hasEditRights: boolean;
  /** Branches can't be branched again. */
  isBranch?: boolean;
  /** Approver-side read-confirmation toggle (enterprise); omit to hide. */
  ack?: { required: boolean };
  /** Share-link controls, shown in a toolbar popover; omit to hide. */
  sharePanel?: React.ReactNode;
  /** Review-schedule controls, shown in a toolbar popover; omit to hide. */
  reviewPanel?: React.ReactNode;
  /** Tints the review icon when the doc is overdue. */
  reviewOverdue?: boolean;
}) {
  const router = useRouter();
  const [deleting, setDeleting] = useState(false);
  const [branching, setBranching] = useState(false);
  const [templating, setTemplating] = useState(false);
  const [ackRequired, setAckRequired] = useState(ack?.required ?? false);
  const [ackBusy, setAckBusy] = useState(false);
  const [popover, setPopover] = useState<null | "share" | "review">(null);
  const rowRef = useRef<HTMLDivElement>(null);

  // Popovers close on outside click or Escape.
  useEffect(() => {
    if (!popover) return;
    const onClick = (e: MouseEvent) => {
      if (rowRef.current && !rowRef.current.contains(e.target as Node)) setPopover(null);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setPopover(null);
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [popover]);

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

  async function onToggleAck() {
    const next = !ackRequired;
    setAckBusy(true);
    const res = await fetch(`/api/documents/${id}/ack`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ required: next }),
    });
    setAckBusy(false);
    if (res.ok) {
      setAckRequired(next);
      router.refresh();
    } else {
      alert((await res.json().catch(() => ({}))).error || "Could not update.");
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
  const popoverBox =
    "absolute right-0 top-full z-40 mt-2 w-80 rounded-xl border border-slate-200 bg-surface p-4 text-left shadow-xl";

  return (
    <div ref={rowRef} className="relative flex items-center gap-2 print:hidden">
      {sharePanel && (
        <>
          <button
            onClick={() => setPopover((p) => (p === "share" ? null : "share"))}
            title="Share link"
            aria-label="Share link"
            aria-expanded={popover === "share"}
            className={
              popover === "share"
                ? "inline-flex items-center rounded-lg border border-compass-300 bg-compass-50 p-2 text-compass-600 dark:bg-compass-950/40"
                : iconBtn
            }
          >
            <Share2 className="h-4 w-4" />
          </button>
          {popover === "share" && <div className={popoverBox}>{sharePanel}</div>}
        </>
      )}
      {reviewPanel && (
        <>
          <button
            onClick={() => setPopover((p) => (p === "review" ? null : "review"))}
            title={reviewOverdue ? "Review schedule — overdue" : "Review schedule"}
            aria-label="Review schedule"
            aria-expanded={popover === "review"}
            className={
              popover === "review"
                ? "inline-flex items-center rounded-lg border border-compass-300 bg-compass-50 p-2 text-compass-600 dark:bg-compass-950/40"
                : reviewOverdue
                  ? "inline-flex items-center rounded-lg border border-amber-300 bg-amber-50 p-2 text-amber-700 hover:bg-amber-100 dark:bg-amber-950/40"
                  : iconBtn
            }
          >
            <CalendarClock className="h-4 w-4" />
          </button>
          {popover === "review" && <div className={popoverBox}>{reviewPanel}</div>}
        </>
      )}
      {ack && (
        <button
          onClick={onToggleAck}
          disabled={ackBusy || !isPublished}
          title={
            !isPublished
              ? "Publish first to require read confirmation"
              : ackRequired
                ? "Read confirmation required — click to turn off"
                : "Require read confirmation"
          }
          aria-label="Toggle required read confirmation"
          aria-pressed={ackRequired}
          className={`inline-flex items-center rounded-lg border p-2 disabled:opacity-50 ${
            ackRequired
              ? "border-compass-300 bg-compass-50 text-compass-600 hover:bg-compass-100 dark:bg-compass-950/40"
              : "border-slate-200 bg-surface text-slate-500 hover:bg-slate-50 hover:text-slate-700"
          }`}
        >
          {ackBusy ? (
            <LoaderCircle className="h-4 w-4 animate-spin" />
          ) : (
            <ShieldCheck className="h-4 w-4" />
          )}
        </button>
      )}
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
