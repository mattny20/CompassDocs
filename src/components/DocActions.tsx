"use client";

import { useRouter } from "next/navigation";
import { Spinner } from "@/components/Spinner";
import Link from "next/link";
import { useCallback, useRef, useState } from "react";
import {
  CalendarClock,
  GitBranch,
  History,
  LayoutTemplate,
  Pencil,
  Share2,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { PrintButton } from "./PrintButton";
import { Popover } from "./Popover";
import { toast } from "./Toasts";
import { confirmDialog, promptDialog } from "./Dialog";
import { AckSettings, ACK_SETTINGS_TITLE } from "./AckSettings";
import type { AckSettingsProps } from "./AckSettings";

/** The shield's tooltip and accessible name (A5). */
export const ACK_SHIELD_LABEL = "Read confirmation settings";

export function DocActions({
  id,
  spaceSlug,
  canEdit,
  canDelete,
  canSaveAsTemplate = false,
  isPublished,
  isBranch = false,
  ack,
  sharePanel,
  reviewPanel,
  reviewOverdue = false,
}: {
  id: number;
  spaceSlug: string;
  /**
   * Both resolved on the server from permissions plus per-space edit rights.
   * The client cannot answer either question — grants and space scope are not
   * on the session — and before 1.0 this component guessed from the role rung,
   * so a custom role with authoring rights saw a read-only toolbar.
   */
  canEdit: boolean;
  canDelete: boolean;
  /** Server-resolved `template.manage` — the button POSTs to an admin route. */
  canSaveAsTemplate?: boolean;
  isPublished: boolean;
  /** Branches can't be branched again. */
  isBranch?: boolean;
  /**
   * The Read confirmation popover's props (enterprise, A5), for holders of
   * document.ack_require; omit to hide the shield. The sticky-bar copy omits
   * it on purpose: the requirement's state lives here, and two copies would
   * disagree after a click.
   */
  ack?: Omit<AckSettingsProps, "docId" | "isPublished">;
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
  // The requirement as this toolbar last saw it: the popover reports every
  // switch so the shield's tint follows at once, before the refresh lands.
  const [ackRequired, setAckRequired] = useState(ack?.required ?? false);
  const [popover, setPopover] = useState<null | "share" | "review" | "ack">(null);
  const shareBtn = useRef<HTMLButtonElement>(null);
  const reviewBtn = useRef<HTMLButtonElement>(null);
  const ackBtn = useRef<HTMLButtonElement>(null);
  // Outside click and Escape are handled by Popover (via the overlay stack).
  // A question opened from inside a panel (the shield's "Require read
  // confirmation?", the share card's revoke) is a Modal above it: a click
  // inside that modal is "outside" the panel but must not close it, or the
  // switch the person is answering about vanishes under them. Escape never
  // reaches here while the modal is up (the overlay stack is LIFO).
  const closePopover = useCallback(() => {
    if (typeof document !== "undefined" && document.querySelector('[role="dialog"][aria-modal="true"]')) return;
    setPopover(null);
  }, []);

  async function onBranch() {
    setBranching(true);
    const res = await fetch(`/api/documents/${id}/branch`, { method: "POST" });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      router.push(`/doc/${data.branch.id}/edit`);
      router.refresh();
    } else {
      setBranching(false);
      toast("error", data?.error || "Couldn't create the branch.");
    }
  }

  async function onSaveAsTemplate() {
    const name = await promptDialog({
      title: "Save as a template",
      body: "Writers will see it in the template picker.",
      label: "Template name",
      confirmLabel: "Save template",
    });
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
    else toast("error", data?.error || "Couldn't create the template.");
  }

  // Trashing is reversible, so it does not ask — it tells, with Undo
  // (STYLEGUIDE §Feedback). Restore goes through the Trash API.
  async function onDelete() {
    setDeleting(true);
    const res = await fetch(`/api/documents/${id}`, { method: "DELETE" });
    if (res.ok) {
      router.push(`/spaces/${spaceSlug}`);
      router.refresh();
      toast("ok", "Moved to the Trash.", {
        action: {
          label: "Undo",
          onClick: async () => {
            const r = await fetch(`/api/trash/${id}`, { method: "POST" });
            if (r.ok) {
              toast("ok", "Restored.");
              router.push(`/doc/${id}`);
              router.refresh();
            } else {
              toast("error", (await r.json().catch(() => ({})))?.error || "Couldn't restore the document — look in Settings → Trash.");
            }
          },
        },
      });
    } else {
      const data = await res.json().catch(() => ({}));
      setDeleting(false);
      toast("error", data?.error || "Couldn't move this document to the Trash.");
    }
  }

  // Icon-only actions with tooltips + accessible labels for a cleaner header.
  const iconBtn =
    "inline-flex items-center rounded-lg border border-slate-200 bg-surface p-2 text-slate-500 hover:bg-slate-50 hover:text-slate-700";

  return (
    <div className="relative flex flex-wrap items-center gap-2 print:hidden">
      {sharePanel && (
        <>
          <button
            ref={shareBtn}
            onClick={() => setPopover((p) => (p === "share" ? null : "share"))}
            data-tt="Share link"
            aria-label="Share link"
            aria-expanded={popover === "share"}
            aria-haspopup="dialog"
            className={
              popover === "share"
                ? "inline-flex items-center rounded-lg border border-compass-300 bg-compass-50 p-2 text-compass-600"
                : iconBtn
            }
          >
            <Share2 className="h-4 w-4" />
          </button>
          <Popover
            open={popover === "share"}
            onClose={closePopover}
            triggerRef={shareBtn}
            role="dialog"
            label="Share link"
            align="end"
            width="w-80"
            padding="p-4"
            className="mt-2 rounded-xl text-left"
          >
            {sharePanel}
          </Popover>
        </>
      )}
      {reviewPanel && (
        <>
          <button
            ref={reviewBtn}
            onClick={() => setPopover((p) => (p === "review" ? null : "review"))}
            data-tt={reviewOverdue ? "Review schedule — overdue" : "Review schedule"}
            aria-label="Review schedule"
            aria-expanded={popover === "review"}
            aria-haspopup="dialog"
            className={
              popover === "review"
                ? "inline-flex items-center rounded-lg border border-compass-300 bg-compass-50 p-2 text-compass-600"
                : reviewOverdue
                  ? "inline-flex items-center rounded-lg border border-amber-300 bg-amber-50 p-2 text-amber-700 hover:bg-amber-100 dark:bg-amber-950/40"
                  : iconBtn
            }
          >
            <CalendarClock className="h-4 w-4" />
          </button>
          <Popover
            open={popover === "review"}
            onClose={closePopover}
            triggerRef={reviewBtn}
            role="dialog"
            label="Review schedule"
            align="end"
            width="w-80"
            padding="p-4"
            className="mt-2 rounded-xl text-left"
          >
            {reviewPanel}
          </Popover>
        </>
      )}
      {ack && (
        <>
          {/* The shield opens the Read confirmation popover (A5): compass
              tint while the document requires confirmation, the open state
              like the share and review triggers. The popup trigger keeps
              data-tt and sets aria-expanded (STYLEGUIDE §Tooltips). */}
          <button
            ref={ackBtn}
            onClick={() => setPopover((p) => (p === "ack" ? null : "ack"))}
            data-tt={ACK_SHIELD_LABEL}
            aria-label={ACK_SHIELD_LABEL}
            aria-expanded={popover === "ack"}
            aria-haspopup="dialog"
            className={
              popover === "ack"
                ? "inline-flex items-center rounded-lg border border-compass-300 bg-compass-50 p-2 text-compass-600"
                : ackRequired
                  ? "inline-flex items-center rounded-lg border border-compass-300 bg-compass-50 p-2 text-compass-600 hover:bg-compass-100"
                  : iconBtn
            }
          >
            <ShieldCheck className="h-4 w-4" />
          </button>
          <Popover
            open={popover === "ack"}
            onClose={closePopover}
            triggerRef={ackBtn}
            role="dialog"
            label={ACK_SETTINGS_TITLE}
            align="end"
            width="w-80"
            padding="p-4"
            className="mt-2 rounded-xl text-left"
          >
            <AckSettings
              {...ack}
              docId={id}
              isPublished={isPublished}
              required={ackRequired}
              onRequiredChange={setAckRequired}
            />
          </Popover>
        </>
      )}
      <PrintButton iconOnly />
      <Link
        href={`/doc/${id}/history`}
        data-tt="Version history"
        aria-label="Version history"
        className={iconBtn}
      >
        <History className="h-4 w-4" />
      </Link>
      {canEdit && !isBranch && (
        <button
          onClick={onBranch}
          disabled={branching}
          data-tt="New draft branch"
          aria-label="Create a draft branch"
          className={iconBtn + " disabled:opacity-50"}
        >
          {branching ? (
            <Spinner />
          ) : (
            <GitBranch className="h-4 w-4" />
          )}
        </button>
      )}
      {canSaveAsTemplate && !isBranch && (
        <button
          onClick={onSaveAsTemplate}
          disabled={templating}
          data-tt="Save as template"
          aria-label="Save this document as a template"
          className={iconBtn + " disabled:opacity-50"}
        >
          {templating ? (
            <Spinner />
          ) : (
            <LayoutTemplate className="h-4 w-4" />
          )}
        </button>
      )}
      {canEdit && (
        <Link href={`/doc/${id}/edit`} data-tt="Edit" aria-label="Edit document" className={iconBtn}>
          <Pencil className="h-4 w-4" />
        </Link>
      )}
      {canDelete && (
        <button
          onClick={onDelete}
          disabled={deleting}
          data-tt="Move to Trash"
          aria-label="Move document to Trash"
          className="inline-flex items-center rounded-lg border border-red-200 bg-surface p-2 text-red-600 hover-danger disabled:opacity-50 dark:border-red-800/70"
        >
          {deleting ? <Spinner /> : <Trash2 className="h-4 w-4" />}
        </button>
      )}
    </div>
  );
}
