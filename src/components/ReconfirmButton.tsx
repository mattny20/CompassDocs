"use client";

// "Ask everyone to re-confirm…" (A7, 1.10.1): the one deliberate re-ask
// without an edit. The same control sits in the shield popover
// (AckSettings), in the Read confirmation page header beside Export CSV and
// in the compliance portal's policy row beside Remind, so the label, the
// question and the toast cannot drift between them.
//
// Click -> formDialog with the standing ("42 of 50 people have confirmed
// version 12") and one required reason of at least 10 characters, awaited
// before anything is busy so Cancel leaves the control idle. The POST is one
// atomic claim on the server (one re-ask per policy per hour, shared with
// Remind); its refusal is the toast, never a silent failure. When nobody has
// confirmed the current version there is nothing to reset: the button is
// disabled inside <Tooltip> ("Use Remind.") and Remind is the live control.

import { RotateCcw } from "lucide-react";
import { Button, type ButtonSize } from "@/components/Button";
import { Tooltip } from "@/components/Tooltip";
import { formDialog } from "@/components/Dialog";
import { toast } from "@/components/Toasts";
import { people } from "@/components/RequireAckDialog";
import { useAction } from "@/lib/use-action";

/** The control's label, everywhere (STYLEGUIDE §Vocabulary): never "Re-request" or "Reset confirmations". */
export const RECONFIRM_LABEL = "Ask everyone to re-confirm…";
/** The disabled state's tooltip when nobody has confirmed the current version. */
export const RECONFIRM_NOBODY = "Nobody has confirmed this version yet. Use Remind.";
/** The inline validation line; the server answers the same rule with 400. */
export const RECONFIRM_REASON_TOO_SHORT = "Give a reason of at least 10 characters.";

/** The slice of ackSummary (or a portal row) the question needs. */
export interface ReconfirmSummary {
  /** Confirmations current against the marker: how many will be reset. */
  current: number;
  /** Everyone who can see the document. */
  eligible: number;
  /** The marker version's number ("v12"); null when the version row is gone. */
  rev: number | null;
}

/** What POST /api/documents/[id]/ack/reconfirm answers. */
export interface ReconfirmResult {
  reset: number;
  queued: number;
}

export function ReconfirmButton({
  docId,
  title,
  summary,
  size = "sm",
  className,
  onDone,
}: {
  docId: number;
  /** The document's title for the question; "this document" when the caller has none. */
  title?: string;
  summary: ReconfirmSummary;
  size?: ButtonSize;
  className?: string;
  /** After a successful ask. Without it the route is refreshed (a server-rendered page). */
  onDone?: (result: ReconfirmResult) => void;
}) {
  const { run, isBusy } = useAction();
  const key = `reconfirm-${docId}`;
  const nobody = summary.current <= 0;
  const busy = isBusy(key);

  async function ask() {
    const version = summary.rev ? `version ${summary.rev}` : "the current version";
    // Awaited before any busy state (STYLEGUIDE §Overlays): Cancel leaves the
    // control idle.
    const values = await formDialog({
      title: title ? `Ask everyone to re-confirm "${title}"?` : "Ask everyone to re-confirm this document?",
      body: `${summary.current} of ${summary.eligible} people have confirmed ${version}. This resets those confirmations, notifies everyone who can see the document, and shows them your reason.`,
      fields: [
        {
          key: "reason",
          label: "Why are readers being asked again?",
          type: "textarea",
          required: true,
          placeholder: "e.g. Section 4 now applies to contractors too",
          validate: (v) => (v.trim().length < 10 ? RECONFIRM_REASON_TOO_SHORT : undefined),
        },
      ],
      confirmLabel: `Ask ${people(summary.current)} to re-confirm`,
    });
    if (!values) return;

    const box: { result?: ReconfirmResult } = {};
    const ok = await run(
      key,
      async () => {
        const res = await fetch(`/api/documents/${docId}/ack/reconfirm`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reason: values.reason.trim() }),
        });
        if (res.ok) box.result = (await res.clone().json().catch(() => ({}))) as ReconfirmResult;
        return res;
      },
      { fallback: "Couldn't ask everyone to re-confirm.", refresh: !onDone }
    );
    if (!ok) return;
    const result = { reset: Number(box.result?.reset ?? summary.current), queued: Number(box.result?.queued ?? 0) };
    toast("ok", `${people(result.reset)} will be asked to re-confirm.`);
    onDone?.(result);
  }

  const button = (
    <Button
      variant="secondary"
      size={size}
      icon={<RotateCcw />}
      onClick={() => void ask()}
      disabled={nobody || busy}
      busy={busy}
      className={className}
      data-tt={nobody ? undefined : "Reset every confirmation and tell readers why"}
      data-tt-wrap={nobody ? undefined : ""}
    >
      {RECONFIRM_LABEL}
    </Button>
  );
  // A disabled button does not fire hover reliably: the wrapper carries the
  // tooltip (components/Tooltip is the recipe for exactly this).
  return nobody ? <Tooltip label={RECONFIRM_NOBODY} className={className}>{button}</Tooltip> : button;
}
