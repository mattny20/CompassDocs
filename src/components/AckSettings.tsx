"use client";

// The Read confirmation popover on the document shield (A5, 1.10.1): the
// four controls and nothing else (STYLEGUIDE §Overlays): the "Require
// readers to confirm" Toggle, the status line with its "View record" link,
// the "When the text changes" Select, and "Ask everyone to re-confirm…".
// Audience, deadline, reminders, the interval, the statement and signature
// go to the document's Read confirmation Settings page when it exists (C2),
// never here.
//
// The Toggle is never flipped optimistically. Switching on puts the shared
// question first (requireAckDialog, awaited before any busy state, so Cancel
// leaves the switch off and idle); the answer runs the portal's request
// sequence through PATCH /api/documents/[id]/ack, so the shield and the
// portal share one path and one outbox. Switching off is reversible, so it
// tells and offers Undo (which re-requires quietly). Every PATCH goes
// through useAction(), whose refresh brings the server's counts back.

import { useState } from "react";
import Link from "next/link";
import { ShieldCheck } from "lucide-react";
import { Field, Select, Toggle } from "@/components/form";
import { EYEBROW_TEXT } from "@/components/Heading";
import { Spinner } from "@/components/Spinner";
import { toast } from "@/components/Toasts";
import { requireAckDialog, people } from "@/components/RequireAckDialog";
import { ReconfirmButton } from "@/components/ReconfirmButton";
import { EDIT_DEFAULT_OPTIONS } from "@/components/compliance/ProgramSettingsPanel";
import { useFormatDate } from "@/components/SettingsProvider";
import { useAction } from "@/lib/use-action";
import type { EditDefault } from "@/lib/compliance-settings";

export interface AckSettingsProps {
  docId: number;
  isPublished: boolean;
  required: boolean;
  /** documents.ack_edit_default. */
  editDefault: EditDefault;
  /** The workspace's value (E4): its option is suffixed "(workspace default)". */
  workspaceDefault: EditDefault;
  /** The audience at render time: the question's count and the re-ask's standing. */
  summary: { eligible: number; current: number; rev: number | null };
  /** Server-formatted "42 of 50 confirmed · v12 · asked 3 Mar 2026 by Matt"; null while the requirement is off. */
  statusLine: string | null;
  /** document.ack_roster_read: shows the "View record" link. */
  canViewRecord: boolean;
  /** The signed-in person, named on the line after a quiet switch-on. */
  viewerName: string;
}

/** What PATCH answers (the parts the popover reads). */
interface PatchResult {
  ok?: boolean;
  ack_required?: boolean;
  edit_default?: EditDefault;
  queued?: number;
  eligible?: number;
}

export const ACK_SETTINGS_TITLE = "Read confirmation";
export const REQUIRE_TOGGLE_LABEL = "Require readers to confirm";
export const EDIT_DEFAULT_LABEL = "When the text changes";

export function AckSettings({
  docId,
  isPublished,
  required,
  editDefault: initialEditDefault,
  workspaceDefault,
  summary,
  statusLine,
  canViewRecord,
  viewerName,
  onRequiredChange,
}: AckSettingsProps & {
  /** The trigger follows the requirement (compass tint while required). */
  onRequiredChange?: (required: boolean) => void;
}) {
  const fmt = useFormatDate();
  const { run, isBusy, busy } = useAction();
  const [editDefault, setEditDefault] = useState<EditDefault>(initialEditDefault);
  // The server's value wins when it changes under us: the first switch-on
  // applies the workspace default (setAckRequired), and the refresh after a
  // PATCH brings it back through the props.
  const [seenEditDefault, setSeenEditDefault] = useState(initialEditDefault);
  if (initialEditDefault !== seenEditDefault) {
    setSeenEditDefault(initialEditDefault);
    setEditDefault(initialEditDefault);
  }
  // What this session did to the requirement, for the status line until the
  // server's sentence takes over on the next open: when it was switched on
  // and whether anyone was told.
  const [switchedOn, setSwitchedOn] = useState<{ at: string; notified: number | null } | null>(null);

  /** One PATCH through useAction: the server's error or the fallback is toasted; the body comes back on success. */
  async function patch(key: string, body: Record<string, unknown>, fallback: string): Promise<PatchResult | null> {
    const box: { result?: PatchResult } = {};
    const ok = await run(
      key,
      async () => {
        const res = await fetch(`/api/documents/${docId}/ack`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (res.ok) box.result = (await res.clone().json().catch(() => ({}))) as PatchResult;
        return res;
      },
      { fallback }
    );
    return ok ? (box.result ?? {}) : null;
  }

  async function onToggle(next: boolean) {
    if (busy) return;
    if (next) {
      // The question comes before any busy state (STYLEGUIDE §Overlays):
      // Cancel leaves the switch off and idle. No title: on the document
      // page "this document" is enough.
      const choice = await requireAckDialog({ count: summary.eligible });
      if (!choice) return;
      const notify = choice === "notify";
      const r = await patch("required", { required: true, notify }, "Couldn't require a read confirmation.");
      if (!r) return;
      onRequiredChange?.(true);
      // A first switch-on applies the workspace edit default: show it now.
      if (r.edit_default) setEditDefault(r.edit_default);
      const queued = r.queued ?? summary.eligible;
      setSwitchedOn({ at: new Date().toISOString(), notified: notify ? queued : null });
      toast(
        "ok",
        notify
          ? `Read confirmation required: ${people(queued)} will be notified.`
          : "Read confirmation required. No notice sent."
      );
      return;
    }
    // Reversible, so it tells rather than asks (STYLEGUIDE §Feedback): the
    // record is kept, and Undo re-requires quietly.
    const r = await patch("required", { required: false }, "Couldn't stop requiring a read confirmation.");
    if (!r) return;
    onRequiredChange?.(false);
    setSwitchedOn(null);
    toast("ok", "Read confirmation no longer required for this document", {
      action: { label: "Undo", onClick: () => void undoSwitchOff() },
    });
  }

  async function undoSwitchOff() {
    const r = await patch("required", { required: true, notify: false }, "Couldn't restore the requirement.");
    if (!r) return;
    onRequiredChange?.(true);
    if (r.edit_default) setEditDefault(r.edit_default);
    setSwitchedOn({ at: new Date().toISOString(), notified: null });
    toast("ok", "Read confirmation required again. No notice sent.");
  }

  async function onEditDefault(value: EditDefault) {
    if (busy || value === editDefault) return;
    const previous = editDefault;
    setEditDefault(value);
    const r = await patch("edit_default", { edit_default: value }, "Couldn't change the edit setting.");
    if (!r) {
      setEditDefault(previous);
      return;
    }
    toast("ok", "Setting saved.");
  }

  const option = EDIT_DEFAULT_OPTIONS.find((o) => o.value === editDefault) ?? EDIT_DEFAULT_OPTIONS[0];
  const saving = isBusy("required");
  const toggleHelp = saving ? (
    <span className="inline-flex items-center gap-1">
      <Spinner size="sm" /> Saving…
    </span>
  ) : !isPublished ? (
    "Publish first"
  ) : undefined;

  // The status line: the server's sentence, or what this session just did
  // ("Required 3 Oct 2026 by Matt (no notice sent)") until the next open.
  let status: string | null = null;
  if (required) {
    if (switchedOn) {
      status =
        switchedOn.notified === null
          ? `Required ${fmt.date(switchedOn.at)} by ${viewerName} (no notice sent)`
          : `0 of ${summary.eligible} confirmed · asked ${fmt.date(switchedOn.at)} by ${viewerName}`;
    } else {
      status = statusLine ?? `${summary.current} of ${summary.eligible} confirmed`;
    }
  }

  return (
    <section>
      <h2 className={`mb-3 flex items-center gap-1.5 ${EYEBROW_TEXT}`}>
        <ShieldCheck className="h-3.5 w-3.5" aria-hidden /> {ACK_SETTINGS_TITLE}
      </h2>

      <Toggle
        label={REQUIRE_TOGGLE_LABEL}
        help={toggleHelp}
        checked={required}
        onChange={(next) => void onToggle(next)}
        disabled={!isPublished || saving}
        size="full"
      />

      {status && (
        <p className="mt-2 text-xs text-slate-500">
          {status}
          {canViewRecord && (
            <>
              {" · "}
              <Link href={`/doc/${docId}/acknowledgements`} className="font-medium text-compass-700 hover:underline">
                View record
              </Link>
            </>
          )}
        </p>
      )}

      <Field label={EDIT_DEFAULT_LABEL} help={option.help} className="mt-4">
        <Select
          value={editDefault}
          onChange={(e) => void onEditDefault(e.target.value as EditDefault)}
          disabled={isBusy("edit_default")}
          dense
        >
          {EDIT_DEFAULT_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.value === workspaceDefault ? `${o.label} (workspace default)` : o.label}
            </option>
          ))}
        </Select>
      </Field>

      {required && isPublished && (
        <div className="mt-4">
          {/* The deliberate re-ask (A7): disabled with its tooltip until
              someone has confirmed the current version. */}
          <ReconfirmButton
            docId={docId}
            summary={{ current: summary.current, eligible: summary.eligible, rev: summary.rev }}
          />
        </div>
      )}
    </section>
  );
}
