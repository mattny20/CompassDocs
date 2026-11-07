"use client";

// "Move to the recycle bin?" (1.19.4, area C7; mock-up v1). One dialog for
// the ticket's … menu (one ticket) and the queue's bulk bar (up to 200).
// It asks the server first (POST /api/helpdesk/recycle-bin action
// "preview"), which checks each ticket on its own, and lists them: the ones
// that go, and the ones that stay with a chip saying why ("Legal hold,
// stays"). The primary says how many go. Nothing is sent to anyone; the
// toast that follows offers Undo (./actions movedToast).

import { useEffect, useId, useState } from "react";
import { Trash2, Undo2 } from "lucide-react";
import { Button } from "@/components/Button";
import { chipClass } from "@/components/Chip";
import { Modal } from "@/components/Modal";
import { LoadingRow } from "@/components/Spinner";
import { toast } from "@/components/Toasts";
import { BIN_DAYS, type HdBinResult } from "@/lib/helpdesk/recycle-bin-shared";
import { binRequest, movedToast } from "./actions";

export interface DeleteCandidate {
  number: number;
  subject: string;
}

export function DeleteTicketsDialog({
  open,
  tickets,
  onClose,
  onDeleted,
  onRestored,
}: {
  open: boolean;
  tickets: DeleteCandidate[];
  onClose: () => void;
  /** After the move, with the numbers that went. */
  onDeleted: (numbers: number[]) => void;
  /** After the toast's Undo put them back (default: onDeleted, to refresh). */
  onRestored?: (numbers: number[]) => void;
}) {
  const titleId = useId();
  const [checks, setChecks] = useState<HdBinResult[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const numbers = tickets.map((t) => t.number);
  const key = numbers.join(",");

  useEffect(() => {
    if (!open) return;
    let live = true;
    setChecks(null);
    setError("");
    binRequest("preview", key.split(",").map(Number))
      .then((r) => live && setChecks(r))
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [open, key]);

  const going = (checks ?? []).filter((c) => c.ok);
  const n = tickets.length;
  const title =
    n === 1
      ? `Move #${numbers[0]} to the recycle bin?`
      : checks && going.length < n
        ? `Move ${going.length} of ${n} tickets to the recycle bin?`
        : `Move ${n} tickets to the recycle bin?`;
  const primary = going.length === 1 && n === 1 ? "Move to the recycle bin" : `Move ${going.length} to the recycle bin`;

  async function go() {
    if (!going.length || busy) return;
    setBusy(true);
    try {
      const res = await binRequest(
        "bin",
        going.map((c) => c.number)
      );
      // A ticket refused only now (a hold placed meanwhile) counts as stayed too.
      const moved = res.filter((r) => r.ok).map((r) => r.number);
      const stayed = n - moved.length;
      if (!moved.length) toast("error", res.find((r) => !r.ok)?.error ?? "Nothing was deleted.");
      else movedToast(moved, () => (onRestored ?? onDeleted)(moved), stayed);
      onClose();
      if (moved.length) onDeleted(moved);
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} labelledBy={titleId} className="max-h-[calc(100vh-2rem)] w-full max-w-lg overflow-y-auto rounded-xl border border-slate-200 bg-surface p-5 shadow-modal">
      <div className="flex gap-3">
        <span className="mt-0.5 shrink-0 text-red-600 dark:text-red-400" aria-hidden>
          <Trash2 className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 id={titleId} className="text-base font-semibold text-slate-900">
            {title}
          </h2>
          <p className="mt-1 text-sm text-slate-600">
            {n === 1
              ? "It leaves every queue, view and report, and its requester no longer sees it. Nothing is sent to anyone."
              : "They leave every queue, view and report, and their requesters no longer see them. Nothing is sent to anyone."}
          </p>
        </div>
      </div>

      {error && <p className="notice-error mt-4 rounded-lg border px-3 py-2 text-sm">{error}</p>}
      {!checks && !error && <LoadingRow className="py-6" />}
      {checks && (
        <ul className="mt-4 max-h-72 divide-y divide-slate-100 overflow-y-auto rounded-lg border border-slate-200" aria-label="Tickets">
          {checks.map((c) => {
            const subject = c.subject ?? tickets.find((t) => t.number === c.number)?.subject ?? "";
            return (
              <li key={c.number} className={`flex items-center gap-3 px-3 py-2 text-sm ${c.ok ? "text-slate-800" : "text-slate-500"}`}>
                <span className="w-14 shrink-0 self-start font-semibold tabular-nums">#{c.number}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{subject}</span>
                  {/* Its task tickets: which go with it, which stay and why. */}
                  {c.note && <span className="block text-xs text-slate-500">{c.note}</span>}
                </span>
                {!c.ok && (
                  <span className={chipClass("warn", "md", "shrink-0")} data-tt={c.error} data-tt-wrap="">
                    {c.chip ?? "Stays"}
                    <span className="sr-only">: {c.error}</span>
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <p className="mt-3 flex items-start gap-1.5 text-xs text-slate-500">
        <Undo2 className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
        <span>
          {n === 1 ? "You can restore it" : "You can restore them"} from the recycle bin for {BIN_DAYS} days. After that{" "}
          {n === 1 ? "it's" : "they're"} deleted for good, with {n === 1 ? "its" : "their"} attachments.
        </span>
      </p>

      <div className="mt-5 flex flex-wrap items-center justify-end gap-2">
        {/* Destructive: focus starts on Cancel so Enter can't delete by reflex (STYLEGUIDE §Overlays). */}
        <Button type="button" variant="ghost" onClick={onClose} data-autofocus="">
          Cancel
        </Button>
        <Button type="button" variant="danger" icon={<Trash2 />} busy={busy} disabled={!checks || going.length === 0} onClick={() => void go()}>
          {checks && going.length === 0 ? "Nothing to move" : primary}
        </Button>
      </div>
    </Modal>
  );
}
