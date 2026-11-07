"use client";

// The recycle bin's client actions (1.19.4, area C7): one POST
// /api/helpdesk/recycle-bin per bin, restore or purge, the "moved to the
// recycle bin · Undo" toast (mock-up v3), and an event the Views nav count
// and the bin view listen for, so every place that shows the bin stays in
// step after a delete anywhere in the desk.

import { toast } from "@/components/Toasts";
import type { HdBinResult } from "@/lib/helpdesk/recycle-bin-shared";
import { sendJson } from "../api";

export const BIN_CHANGED = "hd:recycle-bin-changed";

/** Tell the nav count and the bin view that the bin changed. */
export function binChanged(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(BIN_CHANGED));
}

export type BinAction = "preview" | "bin" | "restore" | "purge";

export async function binRequest(action: BinAction, numbers: number[]): Promise<HdBinResult[]> {
  const fallback =
    action === "restore" ? "Couldn't restore the tickets." : action === "purge" ? "Couldn't delete the tickets for good." : action === "bin" ? "Couldn't delete the tickets." : "Couldn't check the tickets.";
  const r = await sendJson<{ results: HdBinResult[] }>("/api/helpdesk/recycle-bin", "POST", { action, numbers }, fallback);
  if (action !== "preview") binChanged();
  return r.results;
}

/** "1 ticket" / "3 tickets", or "#1047" for a single number. */
export function ticketsPhrase(numbers: number[]): string {
  return numbers.length === 1 ? `#${numbers[0]}` : `${numbers.length} tickets`;
}

/**
 * After a delete: "2 tickets moved to the recycle bin." with Undo, which
 * restores them through the same API (STYLEGUIDE §Feedback: reversible
 * actions tell and offer Undo). `after` runs after the undo too.
 */
export function movedToast(numbers: number[], after: () => void, skipped = 0): void {
  if (!numbers.length) return;
  const lead = numbers.length === 1 ? `#${numbers[0]} moved to the recycle bin.` : `${numbers.length} tickets moved to the recycle bin.`;
  toast("ok", skipped ? `${lead} ${skipped} stayed.` : lead, {
    action: {
      label: "Undo",
      onClick: () => {
        binRequest("restore", numbers)
          .then((res) => {
            const back = res.filter((r) => r.ok).length;
            if (back === numbers.length) toast("ok", numbers.length === 1 ? `#${numbers[0]} restored.` : `${back} tickets restored.`);
            else toast("error", `${back} of ${numbers.length} restored. ${res.find((r) => !r.ok)?.error ?? ""}`.trim());
            after();
          })
          .catch((e: Error) => toast("error", e.message));
      },
    },
  });
}
