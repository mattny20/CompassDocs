"use client";

// The compliance portal's bulk bars (F5, 1.14.0; STYLEGUIDE §Tables' bulk
// bar recipe, AckRoster is the worked example): one bar above the Policies
// list ("{n} policies selected") and one above the People table ("{n}
// people selected") while anything is checked, each offering the actions
// over the checked ids through POST /api/admin/compliance/bulk, which
// composes the programme's existing writes and queues every notice as an
// outbox row (nothing waits on mail). Sending mail asks first with a
// confirmDialog (Remind, Remind about everything outstanding); the re-asks
// take their reason in ONE formDialog; the deadline, owner, reminders,
// set and exemption forms are small Modals; the extension is the roster's
// extendDialog. Every reversible action tells and offers Undo (STYLEGUIDE
// §Feedback): the deadline, the owner and the reminders re-send what each
// policy held (the answer's `previous`), the exemption and the extension
// are the inverse call on the assignments route over the answer's
// `changed` ids, as the roster's are, in calls of the assignments route's
// cap. A successful action clears the selection, reloads the payload and
// moves focus to the header checkbox the bar grew from (`focusAfter`: the
// bar unmounts with the selection, and the button that had focus with it).

import { useCallback, useEffect, useId, useState, type ReactNode } from "react";
import { BellRing, CalendarClock, CalendarPlus, Download, Layers, RotateCcw, UserCog, UserMinus, X } from "lucide-react";
import { Button, iconButtonClass } from "@/components/Button";
import { confirmDialog, formDialog } from "@/components/Dialog";
import { EntityPicker, type PickerOption } from "@/components/EntityPicker";
import { Field, Select, Textarea, TextInput } from "@/components/form";
import { Modal } from "@/components/Modal";
import { Tooltip } from "@/components/Tooltip";
import { toast } from "@/components/Toasts";
import { LoadingRow } from "@/components/Spinner";
import {
  DeadlineFields,
  ReminderFields,
  REMINDER_KEYS,
  deadlineDaysError,
  deadlineRuleFrom,
  reminderError,
  type DeadlineFormValue,
  type ReminderKey,
} from "@/components/PolicyFields";
import { extendDialog, reaskDialog, today } from "@/components/AckRoster";
import { RECONFIRM_REASON_TOO_SHORT } from "@/components/ReconfirmButton";
import { people } from "@/components/compliance/copy";
import { ASSIGNMENT_IDS_MAX, EXEMPT_REASON_MAX, REASK_REASON_MIN } from "@/lib/ack-assignments";
import { DUE_FIELDS } from "@/lib/ack-due";
import { useAction } from "@/lib/use-action";
import type { DocRow, PersonRow } from "./use-portal";

/** The server's cap (lib/ack-bulk BULK_IDS_MAX = ASSIGNMENT_IDS_MAX). */
export const BULK_POLICIES_CAP_TOOLTIP = `Up to ${ASSIGNMENT_IDS_MAX} policies at a time.`;
export const BULK_PEOPLE_CAP_TOOLTIP = `Up to ${ASSIGNMENT_IDS_MAX} people at a time.`;

/** The portal's per-policy Remind window, as the server tests it (documents.ack_last_reminded_at within the hour). */
const HOUR = 60 * 60 * 1000;

// ── What the bulk route answers (lib/ack-bulk BulkAnswer; mirrored, since that module is server-only) ──

interface BulkSkipped {
  id: number;
  title: string;
  reason: string;
}
interface BulkPrevious {
  id: number;
  due_days?: number | null;
  due_at?: string | null;
  owner_id?: number | null;
  remind_before_days?: number | null;
  remind_every_days?: number | null;
  escalate_after_days?: number | null;
  nudge_every_days?: number | null;
}
interface BulkAnswer {
  done: number;
  queued: number;
  skipped: BulkSkipped[];
  previous?: BulkPrevious[];
  changed?: number[];
  people?: number;
  reset?: number;
}

/** "3 policies" / "1 policy" (people() is the people count, STYLEGUIDE §Vocabulary). */
export const policies = (n: number) => `${n} ${n === 1 ? "policy" : "policies"}`;

/** " · 1 policy skipped" / " · 2 people skipped", or nothing. */
function skippedNote(skipped: BulkSkipped[], noun: "policies" | "people"): string {
  const n = skipped.length;
  if (n === 0) return "";
  return ` · ${noun === "policies" ? policies(n) : people(n)} skipped`;
}

/** The error toast when the server changed nothing: the first skipped item says why. */
function nothingChanged(r: BulkAnswer): void {
  const first = r.skipped[0];
  toast("error", first ? `Nothing changed. ${first.title}: ${first.reason}.` : "Nothing changed.");
}

const withinHour = (iso: string | null | undefined) => Boolean(iso) && Date.now() - new Date(iso!).getTime() < HOUR;

/** Ids in calls of the assignments route's cap: an Undo over an answer's `changed` (up to 200 people across several policies) can exceed it. */
function chunked(ids: number[]): number[][] {
  const out: number[][] = [];
  for (let i = 0; i < ids.length; i += ASSIGNMENT_IDS_MAX) out.push(ids.slice(i, i + ASSIGNMENT_IDS_MAX));
  return out;
}

/** One POST through useAction (the server's error or the fallback is toasted); the answer comes back on success. */
function useBulkPost() {
  const { run, busy } = useAction();
  const post = useCallback(
    async <T,>(key: string, url: string, body: Record<string, unknown>, fallback: string): Promise<T | null> => {
      const box: { result?: T } = {};
      const ok = await run(
        key,
        async () => {
          const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
          if (res.ok) box.result = (await res.clone().json().catch(() => ({}))) as T;
          return res;
        },
        { fallback, refresh: false }
      );
      return ok ? (box.result ?? ({} as T)) : null;
    },
    [run]
  );
  const bulk = useCallback(
    (key: string, body: Record<string, unknown>, fallback: string) => post<BulkAnswer>(key, "/api/admin/compliance/bulk", body, fallback),
    [post]
  );
  const assignments = useCallback(
    (key: string, body: Record<string, unknown>, fallback: string) =>
      post<{ changed?: number[]; skipped?: number[] }>(key, "/api/admin/compliance/assignments", body, fallback),
    [post]
  );
  return { bulk, assignments, busy };
}

/** A bulk-bar action: a `secondary` `sm` Button, disabled inside the cap's tooltip past the server's cap. */
function BulkButton({
  icon,
  label,
  count,
  cap,
  busy,
  onClick,
  tip,
}: {
  icon: ReactNode;
  label: string;
  count: number;
  cap: string;
  busy: boolean;
  onClick: () => void;
  tip?: string;
}) {
  const tooMany = count > ASSIGNMENT_IDS_MAX;
  const button = (
    <Button variant="secondary" size="sm" icon={icon} onClick={onClick} disabled={busy || tooMany} data-tt={tooMany ? undefined : tip}>
      {label}
    </Button>
  );
  return tooMany ? <Tooltip label={cap}>{button}</Tooltip> : button;
}

/** The bar itself: the count, Clear selection, a hairline, then the actions (print:hidden). */
function Bar({ label, count, onClear, busy, children }: { label: string; count: string; onClear: () => void; busy: boolean; children: ReactNode }) {
  return (
    <div
      role="region"
      aria-label={label}
      className="flex flex-wrap items-center gap-2 rounded-lg border border-compass-200 bg-compass-50/70 px-3 py-2 print:hidden"
    >
      <span className="text-sm font-semibold text-compass-800">{count}</span>
      <Button variant="ghost" size="sm" onClick={onClear} disabled={busy}>
        Clear selection
      </Button>
      <span className="mx-1 h-4 w-px bg-compass-200" aria-hidden />
      {children}
    </div>
  );
}

/**
 * A small form in a Modal (STYLEGUIDE §Overlays): the question as its
 * heading, one sentence under it, the fields, then Cancel and the primary
 * that says what it does. Enter submits, Escape cancels, focus returns to
 * the bar's button.
 */
function BulkModal({
  open,
  onClose,
  title,
  description,
  children,
  actions,
  onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  children: ReactNode;
  /** The primary (and any secondary) beside Cancel. */
  actions: ReactNode;
  onSubmit: () => void;
}) {
  const titleId = useId();
  const bodyId = useId();
  return (
    <Modal
      open={open}
      onClose={onClose}
      labelledBy={titleId}
      describedBy={description ? bodyId : undefined}
      className="w-full max-w-lg rounded-xl border border-slate-200 bg-surface p-5 shadow-modal"
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit();
        }}
      >
        <h2 id={titleId} className="text-base font-semibold text-slate-900">
          {title}
        </h2>
        {description && (
          <p id={bodyId} className="mt-1 text-sm text-slate-600">
            {description}
          </p>
        )}
        <div className="mt-4 space-y-4">{children}</div>
        <div className="mt-5 flex flex-wrap items-center justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          {actions}
        </div>
      </form>
    </Modal>
  );
}

// ── The Policies bar ─────────────────────────────────────────────────────────

type PolicyModal = "deadline" | "owner" | "reminders" | "set" | null;

export function PolicyBulkBar({
  selected,
  users,
  canExport,
  onClear,
  onDone,
}: {
  /** The live rows checked, in the list's order. */
  selected: DocRow[];
  /** Every account the payload knows (the owner picker's options). */
  users: PersonRow[];
  canExport: boolean;
  onClear: () => void;
  /** After a successful action: the page reloads its payload. */
  onDone: () => Promise<void> | void;
  /** After the reload: where focus goes (the header checkbox the bar grew from), since clearing the selection unmounts the bar and the button that had it. */
  focusAfter: () => void;
}) {
  const { bulk, busy } = useBulkPost();
  const [modal, setModal] = useState<PolicyModal>(null);
  const ids = selected.map((d) => d.id);
  const n = selected.length;
  const close = () => setModal(null);
  // STYLEGUIDE §Settings pages: focus never falls to <body>. The selection
  // clears first (the bar goes), the payload reloads, then the control the
  // bar grew from takes focus.
  const finished = async () => {
    onClear();
    await onDone();
    focusAfter();
  };

  // Remind: the question carries the counts the server will act on (from
  // the rows' own hour stamp, which is what the server's claim tests, so no
  // dry run is needed), ends "This cannot be undone." (mail), and the toast
  // reports what was queued and skipped.
  async function remind() {
    const hour = selected.filter((d) => withinHour(d.ack_last_reminded_at));
    const complete = selected.filter((d) => !hour.includes(d) && d.required - d.acked <= 0);
    const eligible = selected.filter((d) => !hour.includes(d) && !complete.includes(d));
    if (eligible.length === 0) {
      toast("error", "Nothing to remind: every selected policy was reminded within the hour or has nobody pending.");
      return;
    }
    const pending = eligible.reduce((s, d) => s + Math.max(0, d.required - d.acked), 0);
    const body = [
      `Across ${policies(eligible.length)}.`,
      hour.length > 0
        ? `${policies(hour.length)} ${hour.length === 1 ? "is" : "are"} skipped because ${hour.length === 1 ? "it was" : "they were"} reminded within the hour.`
        : "",
      complete.length > 0 ? `${policies(complete.length)} with nobody pending ${complete.length === 1 ? "is" : "are"} left out.` : "",
      "This cannot be undone.",
    ]
      .filter(Boolean)
      .join(" ");
    const ok = await confirmDialog({ title: `Remind ${people(pending)}?`, body, confirmLabel: "Send reminders" });
    if (ok !== true) return;
    const r = await bulk("bulk-remind", { action: "remind", doc_ids: ids }, "Couldn't send reminders.");
    if (!r) return;
    if (r.done === 0) return nothingChanged(r);
    toast("ok", `Reminders queued for ${people(r.queued)}${skippedNote(r.skipped, "policies")}`);
    await finished();
  }

  // Ask everyone to re-confirm…: ONE question with the titles and the
  // numbers, the reason inside it (ten characters, judged inline), the
  // button naming the people; never a second dialog. No Undo: the notice
  // is on its way.
  async function reask() {
    const titles = selected.map((d) => d.title);
    const named = titles.slice(0, 3).join(", ") + (titles.length > 3 ? ` and ${policies(titles.length - 3)} more` : "");
    const confirmations = selected.reduce((s, d) => s + d.acked, 0);
    const audience = selected.reduce((s, d) => s + d.required, 0);
    const values = await formDialog({
      title: `Ask people to re-confirm ${policies(n)}?`,
      body: `${named}. This resets ${confirmations} ${confirmations === 1 ? "confirmation" : "confirmations"} and notifies ${people(audience)}.`,
      fields: [
        {
          key: "reason",
          label: "Why are readers being asked again?",
          type: "textarea",
          required: true,
          validate: (v) => (v.trim().length < REASK_REASON_MIN ? RECONFIRM_REASON_TOO_SHORT : undefined),
        },
      ],
      confirmLabel: `Ask ${people(audience)} to re-confirm`,
    });
    if (!values) return;
    const r = await bulk("bulk-reask", { action: "reask", doc_ids: ids, params: { reason: values.reason.trim() } }, "Couldn't ask to re-confirm.");
    if (!r) return;
    if (r.done === 0) return nothingChanged(r);
    toast("ok", `${people(r.queued)} will be asked to re-confirm${skippedNote(r.skipped, "policies")}`);
    await finished();
  }

  // The three reversible writes: the toast's Undo re-sends what each policy
  // held, one call per distinct previous value.
  async function setDeadline(rule: { due_days: number | null; due_at: string | null }, moveExisting: boolean) {
    const r = await bulk(
      "bulk-deadline",
      { action: "set_deadline", doc_ids: ids, params: { due_days: rule.due_days, due_at: rule.due_at, move_existing: moveExisting } },
      "Couldn't set the deadline."
    );
    if (!r) return;
    if (r.done === 0) return nothingChanged(r);
    close();
    const moved = moveExisting || rule.due_at !== null;
    toast("ok", `Deadline set on ${policies(r.done)}${skippedNote(r.skipped, "policies")}`, {
      action: { label: "Undo", onClick: () => void undoDeadline(r.previous ?? [], moved) },
    });
    await finished();
  }

  async function undoDeadline(previous: BulkPrevious[], moved: boolean) {
    const groups = new Map<string, { rule: { due_days: number | null; due_at: string | null }; ids: number[] }>();
    for (const p of previous) {
      const rule = { due_days: p.due_days ?? null, due_at: p.due_at ?? null };
      const key = `${rule.due_days ?? ""}|${rule.due_at ?? ""}`;
      const g = groups.get(key) ?? { rule, ids: [] };
      g.ids.push(p.id);
      groups.set(key, g);
    }
    let restored = 0;
    for (const g of groups.values()) {
      const r = await bulk(
        `bulk-deadline-undo-${g.ids[0]}`,
        { action: "set_deadline", doc_ids: g.ids, params: { due_days: g.rule.due_days, due_at: g.rule.due_at, move_existing: moved } },
        "Couldn't restore the deadlines."
      );
      if (r) restored += r.done;
    }
    if (restored > 0) toast("ok", `Deadline restored on ${policies(restored)}`);
    await onDone();
    focusAfter();
  }

  async function setOwner(ownerId: number | null, ownerName: string | null) {
    const r = await bulk("bulk-owner", { action: "set_owner", doc_ids: ids, params: { owner_id: ownerId } }, "Couldn't set the owner.");
    if (!r) return;
    if (r.done === 0) return nothingChanged(r);
    close();
    toast(
      "ok",
      ownerId === null ? `Owner cleared on ${policies(r.done)}${skippedNote(r.skipped, "policies")}` : `${ownerName} now owns ${policies(r.done)}${skippedNote(r.skipped, "policies")}`,
      { action: { label: "Undo", onClick: () => void undoOwner(r.previous ?? []) } }
    );
    await finished();
  }

  async function undoOwner(previous: BulkPrevious[]) {
    const groups = new Map<number | null, number[]>();
    for (const p of previous) groups.set(p.owner_id ?? null, [...(groups.get(p.owner_id ?? null) ?? []), p.id]);
    let restored = 0;
    for (const [ownerId, docIds] of groups) {
      const r = await bulk(`bulk-owner-undo-${docIds[0]}`, { action: "set_owner", doc_ids: docIds, params: { owner_id: ownerId } }, "Couldn't restore the owners.");
      if (r) restored += r.done;
    }
    if (restored > 0) toast("ok", `Owner restored on ${policies(restored)}`);
    await onDone();
    focusAfter();
  }

  async function setReminders(cadence: Partial<Record<ReminderKey, number | null>>) {
    const r = await bulk("bulk-reminders", { action: "set_reminders", doc_ids: ids, params: cadence }, "Couldn't set the reminders.");
    if (!r) return;
    if (r.done === 0) return nothingChanged(r);
    close();
    toast("ok", `Reminders set on ${policies(r.done)}${skippedNote(r.skipped, "policies")}`, {
      action: { label: "Undo", onClick: () => void undoReminders(r.previous ?? []) },
    });
    await finished();
  }

  async function undoReminders(previous: BulkPrevious[]) {
    const groups = new Map<string, { cadence: Partial<Record<ReminderKey, number | null>>; ids: number[] }>();
    for (const p of previous) {
      const cadence: Partial<Record<ReminderKey, number | null>> = {};
      for (const key of REMINDER_KEYS) if (key in p) cadence[key] = p[key] ?? null;
      const k = JSON.stringify(cadence);
      const g = groups.get(k) ?? { cadence, ids: [] };
      g.ids.push(p.id);
      groups.set(k, g);
    }
    let restored = 0;
    for (const g of groups.values()) {
      const r = await bulk(`bulk-reminders-undo-${g.ids[0]}`, { action: "set_reminders", doc_ids: g.ids, params: g.cadence }, "Couldn't restore the reminders.");
      if (r) restored += r.done;
    }
    if (restored > 0) toast("ok", `Reminders restored on ${policies(restored)}`);
    await onDone();
    focusAfter();
  }

  async function addToSet(set: { id: number; name: string }) {
    const r = await bulk("bulk-set", { action: "add_to_set", doc_ids: ids, params: { set_id: set.id } }, "Couldn't add to the set.");
    if (!r) return;
    if (r.done === 0) return nothingChanged(r);
    close();
    toast("ok", `Added ${policies(r.done)} to "${set.name}"${skippedNote(r.skipped, "policies")}`);
    await finished();
  }

  const exportSelected = () => {
    window.location.assign(`/api/admin/compliance?format=csv&doc_ids=${ids.join(",")}`);
  };

  const cap = BULK_POLICIES_CAP_TOOLTIP;
  const anyPending = selected.some((d) => d.required - d.acked > 0);
  const anyConfirmed = selected.some((d) => d.acked > 0);
  return (
    <>
      <Bar label="Selected policies" count={`${policies(n)} selected`} onClear={onClear} busy={busy}>
        {anyPending && (
          <BulkButton icon={<BellRing />} label="Remind" count={n} cap={cap} busy={busy} onClick={() => void remind()} tip="Notify everyone who hasn't confirmed these policies yet" />
        )}
        <BulkButton icon={<CalendarClock />} label="Set deadline…" count={n} cap={cap} busy={busy} onClick={() => setModal("deadline")} />
        <BulkButton icon={<UserCog />} label="Set owner…" count={n} cap={cap} busy={busy} onClick={() => setModal("owner")} />
        <BulkButton icon={<BellRing />} label="Set reminders…" count={n} cap={cap} busy={busy} onClick={() => setModal("reminders")} />
        {anyConfirmed && (
          <BulkButton icon={<RotateCcw />} label="Ask everyone to re-confirm…" count={n} cap={cap} busy={busy} onClick={() => void reask()} />
        )}
        <BulkButton icon={<Layers />} label="Add to set…" count={n} cap={cap} busy={busy} onClick={() => setModal("set")} />
        {canExport && (
          <Button variant="secondary" size="sm" icon={<Download />} onClick={exportSelected} disabled={busy} data-tt="The matrix CSV for the selected policies only">
            Export CSV (selected)
          </Button>
        )}
      </Bar>
      <DeadlineModal open={modal === "deadline"} count={n} busy={busy} onClose={close} onSubmit={setDeadline} />
      <OwnerModal open={modal === "owner"} count={n} busy={busy} users={users} onClose={close} onSubmit={setOwner} />
      <RemindersModal open={modal === "reminders"} count={n} busy={busy} onClose={close} onSubmit={setReminders} />
      <AddToSetModal open={modal === "set"} count={n} busy={busy} onClose={close} onSubmit={addToSet} />
    </>
  );
}

/** Set deadline…: the Settings tab's Deadline cards over every selected policy, and whether to move the open deadlines now. */
function DeadlineModal({
  open,
  count,
  busy,
  onClose,
  onSubmit,
}: {
  open: boolean;
  count: number;
  busy: boolean;
  onClose: () => void;
  onSubmit: (rule: { due_days: number | null; due_at: string | null }, moveExisting: boolean) => void;
}) {
  const id = useId();
  const [value, setValue] = useState<DeadlineFormValue>({ due_mode: "inherit", due_days: "", due_at: "" });
  const [move, setMove] = useState(true);
  const [tried, setTried] = useState(false);
  useEffect(() => {
    if (open) {
      setValue({ due_mode: "inherit", due_days: "", due_at: "" });
      setMove(true);
      setTried(false);
    }
  }, [open]);
  const floor = today();
  const errors = {
    due_days: deadlineDaysError(value),
    due_at: value.due_mode === "fixed" ? (!value.due_at ? "Enter a date." : value.due_at < floor ? "The deadline cannot be in the past." : undefined) : undefined,
  };
  const invalid = Boolean(errors.due_days || errors.due_at);
  return (
    <BulkModal
      open={open}
      onClose={onClose}
      title={`Set the deadline for ${policies(count)}`}
      description="Each policy takes this rule. A fixed date moves every open deadline; a number of days applies to future assignments unless you also move the existing ones."
      onSubmit={() => {
        setTried(true);
        if (invalid) return;
        onSubmit(deadlineRuleFrom(value), move);
      }}
      actions={
        <Button type="submit" busy={busy} disabled={busy}>
          Set deadline
        </Button>
      }
    >
      <DeadlineFields
        name={`${id}-due`}
        value={value}
        onChange={(key, v) => setValue((prev) => ({ ...prev, [key]: v }))}
        errors={tried ? errors : {}}
        inheritLabel="Inherit"
        inheritDescription="Each policy follows its space's or the workspace's rule, and moves with it when that changes."
        today={floor}
      />
      <label className="flex cursor-pointer items-start gap-2.5 text-sm text-slate-800">
        <input type="checkbox" className="mt-0.5 shrink-0" checked={move} onChange={(e) => setMove(e.target.checked)} />
        <span className="min-w-0">
          <span className="block">Also move existing deadlines</span>
          <span className="block text-xs text-slate-500">Every open deadline on these policies is recomputed from the rule above.</span>
        </span>
      </label>
    </BulkModal>
  );
}

/** Set owner…: one account for every selected policy, or nobody (each policy falls back to whoever switched it on, then its space's approvers). */
function OwnerModal({
  open,
  count,
  busy,
  users,
  onClose,
  onSubmit,
}: {
  open: boolean;
  count: number;
  busy: boolean;
  users: PersonRow[];
  onClose: () => void;
  onSubmit: (ownerId: number | null, ownerName: string | null) => void;
}) {
  const [picked, setPicked] = useState<number | null>(null);
  useEffect(() => {
    if (open) setPicked(null);
  }, [open]);
  const options: PickerOption[] = users.map((u) => ({ id: u.id, label: u.name || u.username, sublabel: `${u.username} · ${u.role}` }));
  const pickedName = picked === null ? null : (options.find((o) => o.id === picked)?.label ?? `User #${picked}`);
  return (
    <BulkModal
      open={open}
      onClose={onClose}
      title={`Set the owner of ${policies(count)}`}
      description="The owner hears when people are overdue. Only an active account that can see each policy's space can own it; the rest are skipped."
      onSubmit={() => {
        if (picked !== null) onSubmit(picked, pickedName);
      }}
      actions={
        <>
          <Button type="button" variant="secondary" disabled={busy} onClick={() => onSubmit(null, null)}>
            Clear owner
          </Button>
          <Button type="submit" busy={busy} disabled={busy || picked === null}>
            Set owner
          </Button>
        </>
      }
    >
      {/* A composite picker keeps its own markup (STYLEGUIDE §Forms): the
          Reminders card's recipe, a chip with its clear button once someone
          is chosen. */}
      <div>
        <span className="mb-1 block text-xs font-medium text-slate-500">Policy owner</span>
        {picked !== null ? (
          <span className="inline-flex items-center gap-1.5 rounded-lg border border-compass-200 bg-compass-50 px-3 py-1.5 text-sm font-medium text-compass-800">
            {pickedName}
            <button type="button" onClick={() => setPicked(null)} data-tt="Clear owner" aria-label="Clear owner" className={iconButtonClass("quiet", "sm", "-mr-1")}>
              <X />
            </button>
          </span>
        ) : (
          <EntityPicker options={options} onPick={setPicked} label="Policy owner" placeholder="Search people…" emptyText="No people match." maxVisible={10} />
        )}
        <span className="mt-1 block text-xs text-slate-500">Clear owner leaves each policy to whoever switched the requirement on, else its space&apos;s approvers.</span>
      </div>
    </BulkModal>
  );
}

/** Set reminders…: the Reminders card's four numbers over every selected policy; a blank field is left as each policy has it, or cleared to inherit. */
function RemindersModal({
  open,
  count,
  busy,
  onClose,
  onSubmit,
}: {
  open: boolean;
  count: number;
  busy: boolean;
  onClose: () => void;
  onSubmit: (cadence: Partial<Record<ReminderKey, number | null>>) => void;
}) {
  const blank = (): Record<ReminderKey, string> => ({ remind_before_days: "", remind_every_days: "", escalate_after_days: "", nudge_every_days: "" });
  const [values, setValues] = useState<Record<ReminderKey, string>>(blank);
  const [clearBlank, setClearBlank] = useState(false);
  const [tried, setTried] = useState(false);
  useEffect(() => {
    if (open) {
      setValues(blank());
      setClearBlank(false);
      setTried(false);
    }
  }, [open]);
  const helpByKey = Object.fromEntries(DUE_FIELDS.map((f) => [f.key, f.help])) as Record<string, string>;
  const errors = Object.fromEntries(REMINDER_KEYS.map((k) => [k, reminderError(k, values[k])])) as Partial<Record<ReminderKey, string | undefined>>;
  const invalid = Object.values(errors).some(Boolean);
  const filled = REMINDER_KEYS.filter((k) => values[k] !== "");
  const nothing = filled.length === 0 && !clearBlank;
  return (
    <BulkModal
      open={open}
      onClose={onClose}
      title={`Set reminders for ${policies(count)}`}
      description="Each policy takes the numbers you enter. A blank field is left as each policy has it, unless you clear the blanks so they inherit the space's or the workspace's number again."
      onSubmit={() => {
        setTried(true);
        if (invalid || nothing) return;
        const cadence: Partial<Record<ReminderKey, number | null>> = {};
        for (const k of REMINDER_KEYS) {
          if (values[k] !== "") cadence[k] = Number(values[k]);
          else if (clearBlank) cadence[k] = null;
        }
        onSubmit(cadence);
      }}
      actions={
        <Button type="submit" busy={busy} disabled={busy}>
          Set reminders
        </Button>
      }
    >
      <ReminderFields values={values} onChange={(k, v) => setValues((prev) => ({ ...prev, [k]: v }))} errors={tried ? errors : {}} help={(k) => helpByKey[k]} />
      <label className="flex cursor-pointer items-start gap-2.5 text-sm text-slate-800">
        <input type="checkbox" className="mt-0.5 shrink-0" checked={clearBlank} onChange={(e) => setClearBlank(e.target.checked)} />
        <span className="min-w-0">
          <span className="block">Clear the blank fields so they inherit again</span>
          <span className="block text-xs text-slate-500">A policy&apos;s own number in a blank field is removed; the space&apos;s or the workspace&apos;s applies.</span>
        </span>
      </label>
      {tried && nothing && (
        <p role="alert" className="text-xs text-red-600">
          Enter at least one number, or clear the blank fields.
        </p>
      )}
    </BulkModal>
  );
}

/** Add to set…: a Select of the active sets; adding never assigns anyone (the Sets page's Assign does). */
function AddToSetModal({
  open,
  count,
  busy,
  onClose,
  onSubmit,
}: {
  open: boolean;
  count: number;
  busy: boolean;
  onClose: () => void;
  onSubmit: (set: { id: number; name: string }) => void;
}) {
  const [sets, setSets] = useState<{ id: number; name: string }[] | null>(null);
  const [picked, setPicked] = useState("");
  const [loadError, setLoadError] = useState("");
  useEffect(() => {
    if (!open) return;
    setSets(null);
    setPicked("");
    setLoadError("");
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/admin/compliance/sets");
        const d = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(d?.error || "Couldn't load the sets.");
        if (cancelled) return;
        const rows = ((d?.rows ?? []) as { id: number; name: string; active: number }[]).filter((s) => s.active === 1);
        setSets(rows.map((s) => ({ id: s.id, name: s.name })));
        if (rows[0]) setPicked(String(rows[0].id));
      } catch (e) {
        if (!cancelled) setLoadError(e instanceof Error && e.message ? e.message : "Couldn't load the sets.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);
  const chosen = sets?.find((s) => String(s.id) === picked) ?? null;
  return (
    <BulkModal
      open={open}
      onClose={onClose}
      title={`Add ${policies(count)} to a set`}
      description="The policies join the set in its order. Nobody is assigned here: assign the set from the Sets page."
      onSubmit={() => {
        if (chosen) onSubmit(chosen);
      }}
      actions={
        <Button type="submit" busy={busy} disabled={busy || !chosen}>
          Add to set
        </Button>
      }
    >
      {loadError ? (
        <p role="alert" className="text-sm text-red-600">
          {loadError}
        </p>
      ) : sets === null ? (
        <LoadingRow className="py-2" />
      ) : sets.length === 0 ? (
        <p className="text-sm text-slate-600">No active sets yet. Create one on the Sets page first.</p>
      ) : (
        <Field label="Set" size="md">
          <Select value={picked} onChange={(e) => setPicked(e.target.value)}>
            {sets.map((s) => (
              <option key={s.id} value={String(s.id)}>
                {s.name}
              </option>
            ))}
          </Select>
        </Field>
      )}
    </BulkModal>
  );
}

// ── The People bar ───────────────────────────────────────────────────────────

export function PeopleBulkBar({
  selected,
  onClear,
  onDone,
}: {
  /** The people checked, in the table's order. */
  selected: PersonRow[];
  onClear: () => void;
  onDone: () => Promise<void> | void;
  /** After the reload: the header checkbox the bar grew from (see PolicyBulkBar). */
  focusAfter: () => void;
}) {
  const { bulk, assignments, busy } = useBulkPost();
  const [exemptOpen, setExemptOpen] = useState(false);
  const ids = selected.map((u) => u.id);
  const n = selected.length;
  const finished = async () => {
    onClear();
    await onDone();
    focusAfter();
  };
  const reloadThenFocus = () => void Promise.resolve(onDone()).then(focusAfter);

  /**
   * An Undo over the answer's `changed` ids: the inverse call on the
   * assignments route in calls of its cap (exempt_people / extend_people
   * over 200 people and several policies can change more rows than one
   * call takes), the changed counts summed for the toast. A refused call
   * ends the loop (its sentence is the toast, what went through stays
   * undone); null when nothing was reverted.
   */
  async function revert(action: "unexempt" | "undo_extend", changed: number[], fallback: string): Promise<number | null> {
    let reverted = 0;
    for (const part of chunked(changed)) {
      const u = await assignments(`bulk-${action}-${part[0]}`, { action, assignment_ids: part }, fallback);
      if (!u) return reverted > 0 ? reverted : null;
      reverted += (u.changed ?? []).length;
    }
    return reverted;
  }

  // Remind about everything outstanding: one notice per person listing
  // their open policies (the outbox bundles them), so it asks first (mail).
  async function remindAll() {
    const ok = await confirmDialog({
      title: `Remind ${people(n)} about everything outstanding?`,
      body: "Each person gets one notice listing every policy they still need to confirm. Someone reminded within the hour, or with nothing outstanding, is skipped. This cannot be undone.",
      confirmLabel: "Send reminders",
    });
    if (ok !== true) return;
    const r = await bulk("bulk-remind-people", { action: "remind_people", user_ids: ids }, "Couldn't send reminders.");
    if (!r) return;
    if (r.done === 0) return nothingChanged(r);
    toast("ok", `Reminders queued for ${people(r.queued)} about everything outstanding${skippedNote(r.skipped, "people")}`);
    await finished();
  }

  // Ask to re-confirm…: the roster's question for several people (the
  // reason inside it), over the people's confirmed rows on every policy.
  async function reask() {
    const reason = await reaskDialog({ one: null, count: n });
    if (reason === null) return;
    const r = await bulk("bulk-reask-people", { action: "reask_people", user_ids: ids, params: { reason } }, "Couldn't ask to re-confirm.");
    if (!r) return;
    if (r.done === 0) return nothingChanged(r);
    toast("ok", `${people(r.queued)} will be asked to re-confirm${skippedNote(r.skipped, "people")}`);
    await finished();
  }

  // Exempt from…: the policies picked among the people's open ones, the
  // reason and the optional end date in one form; Undo removes the
  // exemptions again through the assignments route.
  async function exempt(docIds: number[], reason: string, until: string | null) {
    const r = await bulk(
      "bulk-exempt-people",
      { action: "exempt_people", user_ids: ids, doc_ids: docIds, params: { reason, until } },
      "Couldn't record the exemptions."
    );
    if (!r) return;
    if (r.done === 0) return nothingChanged(r);
    setExemptOpen(false);
    const changed = r.changed ?? [];
    toast("ok", `Exempted ${people(r.people ?? 0)} from ${policies(docIds.length)}${skippedNote(r.skipped, "people")}`, {
      action: {
        label: "Undo",
        onClick: () =>
          void revert("unexempt", changed, "Couldn't remove the exemptions.").then((reverted) => {
            if (reverted === null) return;
            toast("ok", `${reverted} ${reverted === 1 ? "exemption" : "exemptions"} undone: pending again with a fresh due date.`);
            reloadThenFocus();
          }),
      },
    });
    await finished();
  }

  // Extend due…: the roster's question (days and an optional reason) over
  // the people's open deadlines; Undo pops the extensions.
  async function extend() {
    const asked = await extendDialog(n);
    if (!asked) return;
    const { days, reason } = asked;
    const r = await bulk("bulk-extend-people", { action: "extend_people", user_ids: ids, params: { days, reason } }, "Couldn't extend the due dates.");
    if (!r) return;
    if (r.done === 0) return nothingChanged(r);
    const changed = r.changed ?? [];
    const by = `${days} ${days === 1 ? "day" : "days"}`;
    toast("ok", `Extended ${r.done} ${r.done === 1 ? "deadline" : "deadlines"} by ${by} for ${people(r.people ?? 0)}${skippedNote(r.skipped, "people")}`, {
      action: {
        label: "Undo",
        onClick: () =>
          void revert("undo_extend", changed, "Couldn't undo the extensions.").then((reverted) => {
            if (reverted === null) return;
            toast("ok", `Extension undone: ${reverted} ${reverted === 1 ? "deadline is" : "deadlines are"} back to the previous date.`);
            reloadThenFocus();
          }),
      },
    });
    await finished();
  }

  const cap = BULK_PEOPLE_CAP_TOOLTIP;
  return (
    <>
      <Bar label="Selected people" count={`${people(n)} selected`} onClear={onClear} busy={busy}>
        <BulkButton icon={<BellRing />} label="Remind about everything outstanding" count={n} cap={cap} busy={busy} onClick={() => void remindAll()} />
        <BulkButton icon={<RotateCcw />} label="Ask to re-confirm…" count={n} cap={cap} busy={busy} onClick={() => void reask()} />
        <BulkButton icon={<UserMinus />} label="Exempt from…" count={n} cap={cap} busy={busy} onClick={() => setExemptOpen(true)} />
        <BulkButton icon={<CalendarPlus />} label="Extend due…" count={n} cap={cap} busy={busy} onClick={() => void extend()} />
      </Bar>
      <ExemptFromModal open={exemptOpen} userIds={ids} busy={busy} onClose={() => setExemptOpen(false)} onSubmit={exempt} />
    </>
  );
}

/** Exempt from…: the live policies the selected people owe (GET /api/admin/compliance/bulk?user_ids=), the reason and the optional end date. */
function ExemptFromModal({
  open,
  userIds,
  busy,
  onClose,
  onSubmit,
}: {
  open: boolean;
  userIds: number[];
  busy: boolean;
  onClose: () => void;
  onSubmit: (docIds: number[], reason: string, until: string | null) => void;
}) {
  const [options, setOptions] = useState<{ id: number; title: string; people: number }[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [picked, setPicked] = useState<Set<number>>(() => new Set());
  const [reason, setReason] = useState("");
  const [until, setUntil] = useState("");
  const [tried, setTried] = useState(false);
  const key = userIds.join(",");
  useEffect(() => {
    if (!open) return;
    setOptions(null);
    setLoadError("");
    setPicked(new Set());
    setReason("");
    setUntil("");
    setTried(false);
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/admin/compliance/bulk?user_ids=${key}`);
        const d = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(d?.error || "Couldn't load the policies.");
        if (!cancelled) setOptions((d?.policies ?? []) as { id: number; title: string; people: number }[]);
      } catch (e) {
        if (!cancelled) setLoadError(e instanceof Error && e.message ? e.message : "Couldn't load the policies.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, key]);
  const errors = {
    policies: picked.size === 0 ? "Choose at least one policy." : undefined,
    reason: !reason.trim() ? "Enter a value." : reason.trim().length > EXEMPT_REASON_MAX ? `Keep the reason under ${EXEMPT_REASON_MAX} characters.` : undefined,
    until: until && until <= today() ? "Pick a date after today." : undefined,
  };
  const invalid = Boolean(errors.policies || errors.reason || errors.until);
  const togglePolicy = (id: number) =>
    setPicked((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  return (
    <BulkModal
      open={open}
      onClose={onClose}
      title={`Exempt ${people(userIds.length)} from…`}
      description="Each person leaves the chosen policies' counts until the exemption is removed or expires. The reason is shown on the compliance record and in exports."
      onSubmit={() => {
        setTried(true);
        if (invalid) return;
        onSubmit([...picked], reason.trim(), until || null);
      }}
      actions={
        <Button type="submit" busy={busy} disabled={busy || options === null || options.length === 0}>
          Exempt
        </Button>
      }
    >
      {loadError ? (
        <p role="alert" className="text-sm text-red-600">
          {loadError}
        </p>
      ) : options === null ? (
        <LoadingRow className="py-2" />
      ) : options.length === 0 ? (
        <p className="text-sm text-slate-600">None of the selected people owes a policy right now.</p>
      ) : (
        <fieldset>
          <legend className="mb-1 block text-xs font-medium text-slate-500">Policies</legend>
          <div className="max-h-56 space-y-1 overflow-y-auto rounded-lg border border-slate-200 p-2">
            {options.map((o) => (
              <label key={o.id} className="flex cursor-pointer items-start gap-2.5 text-sm text-slate-800">
                <input type="checkbox" className="mt-0.5 shrink-0" checked={picked.has(o.id)} onChange={() => togglePolicy(o.id)} />
                <span className="min-w-0">
                  <span className="block">{o.title}</span>
                  <span className="block text-xs text-slate-500">{people(o.people)} among the selected</span>
                </span>
              </label>
            ))}
          </div>
          {tried && errors.policies && (
            <p role="alert" className="mt-1 text-xs text-red-600">
              {errors.policies}
            </p>
          )}
        </fieldset>
      )}
      <Field label="Reason" help="Shown on the compliance record and in exports" error={tried ? errors.reason : undefined}>
        <Textarea value={reason} onChange={(e) => setReason(e.target.value)} className="h-24" />
      </Field>
      <Field label="Until (optional)" size="sm" error={tried ? errors.until : undefined}>
        <TextInput type="date" min={today()} value={until} onChange={(e) => setUntil(e.target.value)} />
      </Field>
    </BulkModal>
  );
}
