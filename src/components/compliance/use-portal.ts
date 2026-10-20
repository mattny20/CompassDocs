// The compliance portal's state, shared by its routed pages (B4, 1.12.0):
// the one fetch of /api/admin/compliance, every action through useAction()
// with its toast, the per-policy roster cache behind the expand rows and
// the candidate picker behind Request read confirmation. Until 1.12.0 all
// of this lived in one CompliancePanel with hand-rolled tabs; the split
// into Overview, Policies and People moved the views into routes and the
// state in here, and changed no action, dialog, toast or string. Each page
// mounts the hook once, so a visit costs one GET, as the panel did.
//
// Request and Remind ask first (A8): the shared requireAckDialog with the
// audience count, and a "Remind N people?" confirmDialog, because sending
// mail cannot be undone. Stop requiring tells rather than asks (STYLEGUIDE
// §Feedback): the record is kept, and Undo re-requests quietly.
//
// Retire and Un-retire (G3, 1.12.0) both ask: retiring takes a reason of at
// least 10 characters through the formDialog items/G3.md spells out, and
// resuming a retired policy asks once because it puts the policy back on
// everyone's list. Each posts to the policy's own route
// (/api/documents/[id]/ack/retire, …/unretire), not to the portal's POST.
//
// The Needs attention queue (F1, 1.14.0) acts per row through the
// assignments route (/api/admin/compliance/assignments, the roster's
// dispatcher): Extend 7 days, Snooze and Exempt… tell and offer Undo as the
// inverse call; Remove exemption likewise. Remind is the portal's own
// per-policy reminder (it asks "Remind N people?" because mail cannot be
// undone): no route reminds one person for a programme manager yet, so the
// row's Remind reaches everyone still pending on that policy, this person
// among them.

import { useCallback, useEffect, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { confirmDialog, formDialog } from "@/components/Dialog";
import { toast } from "@/components/Toasts";
import { requireAckDialog } from "@/components/RequireAckDialog";
import { askReconfirm, RECONFIRM_LABEL, RECONFIRM_REASON_TOO_SHORT } from "@/components/ReconfirmButton";
import { exemptDialog, type AckRosterRow } from "@/components/AckRoster";
import { useFormatDate } from "@/components/SettingsProvider";
import { people } from "@/components/compliance/copy";
import type { EditDefault } from "@/lib/compliance-settings";
import { EXTEND_DAYS_DEFAULT, SNOOZE_DAYS_DEFAULT } from "@/lib/ack-assignments";
import type { PolicyAttentionReason, PolicyAttentionRow } from "@/lib/types";
import { useAction } from "@/lib/use-action";

export type { PolicyAttentionReason, PolicyAttentionRow };

// ── The GET payload, as src/app/api/admin/compliance/route.ts answers it ────

export interface DocRow {
  id: number;
  title: string;
  space_name: string;
  space_icon: string;
  /** 'draft' is a paused policy (G2): unpublished with the requirement on; it is out of the tiles and has no actions. */
  status: "draft" | "published";
  updated_at: string;
  ack_last_reminded_at: string | null;
  required: number;
  acked: number;
  /** The marker version's number ("v12"). */
  ack_rev?: number | null;
  /** The ledger (C1, 1.10.0): the newest decision of either outcome, and the newest reset (who last asked everyone, and why). */
  last_decision?: DecisionBrief | null;
  last_reset?: DecisionBrief | null;
  /** Kept edits since everyone was last asked, and how far the text has drifted from the version they confirmed. */
  kept_since_reset?: number;
  drift_pct?: number | string | null;
  /** How the policy treats a text edit (A5): the "Asks editor" / "Asks when material" / "Always re-asks" chip. */
  ack_edit_default?: EditDefault;
  /**
   * Retirement (G3, 1.12.0): set on a retired policy, which the Policies
   * page lists in its collapsed Retired group with `required` / `acked`
   * frozen at that moment and `retired_rev` the version people had been
   * asked to confirm. `superseded_by_title` is null when no replacement was
   * named or it was trashed.
   */
  ack_retired_at: string | null;
  ack_retired_by_name: string;
  ack_retired_reason: string;
  ack_superseded_by: number | null;
  superseded_by_title: string | null;
  retired_rev: number | null;
  /** Periodic re-confirmation (G1, 1.12.0): the interval, the stored next date and the effective date ('YYYY-MM-DD'). */
  ack_recert_months: number | null;
  ack_next_recert_at: string | null;
  ack_effective_at: string | null;
  /** Audiences (D1, 1.13.0): people whose assignment row was opened in the last seven days ("+6 enrolled this week"). */
  enrolled_week?: number;
  /** Deadlines (E1, 1.13.0): open rows past their due date and the grace with no current confirmation ("· 12 overdue"). */
  overdue?: number;
  /**
   * The policy's deadline rule (E1): its own days or fixed date ('YYYY-MM-DD'),
   * both null when it inherits, and the days the cascade resolves (policy,
   * space, workspace, built-in): portalDueLine reads "Due 29 Oct 2026" or
   * "Due 14 days after assignment" from it. Null from a server without one.
   */
  due_rule?: { due_days: number | null; due_at: string | null; resolved_days: number } | null;
  /**
   * Reminders (E2, 1.13.0): when the policy's people were last reminded (the
   * manual Remind or the sweep, whichever is later) and when the sweep next
   * reminds someone; reminderSubtitle words it. Null on a paused or retired
   * row, which reminds nobody.
   */
  reminder?: { last_reminded_at: string | null; next_reminder_at: string | null } | null;
  /**
   * The stacked bar's four numbers (F1, 1.14.0): `confirmed` (= acked) and
   * `pending` (= required - acked, the overdue rows included) partition
   * `required`; `overdue` above is the late part of `pending`; `exempt`
   * counts the policy's exempt rows, outside the denominator.
   */
  confirmed?: number;
  pending?: number;
  exempt?: number;
  /** When the policy's people were last reminded: the manual Remind or the sweep's newest stamp, whichever is later. */
  last_reminded_at?: string | null;
  /** The policy's owner for the row subtitle ("owner Priya Shah"): its own, else the space's, else whoever switched it on; null when none is an active account. */
  owner_user_id?: number | null;
  owner_name?: string | null;
  /** The resolved edit default once more under the 1.14.0 name (the same values as ack_edit_default). */
  edit_default?: EditDefault;
  /** The grace the overdue count applied (the space's, else the workspace's, else 0). */
  overdue_grace_days?: number;
  /** The policy sets this policy belongs to (D3, 1.14.0), by name; empty when none. */
  set_names?: string[];
}

export interface DecisionBrief {
  decided_at: string;
  decided_by_name: string;
  reason: string;
  outcome: string;
  source: string;
}

export interface PersonRow {
  id: number;
  name: string;
  username: string;
  role: string;
  required: number;
  acked: number;
  /** Of the required policies, those past their due date and the grace with no current confirmation (E1, 1.13.0). */
  overdue?: number;
  /** The person's exempt rows on live policies (F1, 1.14.0); outside `required`. */
  exempt?: number;
}

/** The Needs attention queue (F1, 1.14.0): `rows` cut at 200, `total` counted before the cut, `snoozed` the rows a running snooze hides. */
export interface AttentionQueue {
  rows: PolicyAttentionRow[];
  total: number;
  snoozed: number;
}

export interface CandidateDoc {
  id: number;
  title: string;
  space_name: string;
  space_icon: string;
}

export interface CompliancePayload {
  kpis: {
    policies: number;
    required: number;
    acked: number;
    outstanding: number;
    pct: number;
    users_compliant: number;
    users_total: number;
    /** Live policies whose next re-confirmation falls within 30 days (G1, 1.12.0). */
    recert_due_30: number;
    /** Open rows past their due date and the grace with no current confirmation, over the live policies (E1, 1.13.0). */
    overdue?: number;
    /**
     * The six tiles of 1.14.0 (F1), all over the live policies: the people
     * with an overdue row (the Overdue tile's sub-line), the rows due inside
     * seven days, pending (the new name of outstanding), the exempt rows,
     * the rows whose escalation fired, the rows under a running snooze and
     * the policies whose confirmed text drifted past the re-ask threshold.
     */
    overdue_people?: number;
    due_7d?: number;
    pending?: number;
    exempt?: number;
    escalated?: number;
    snoozed?: number;
    drifted?: number;
  };
  /** The Needs attention queue (F1, 1.14.0); absent from a server without it. */
  attention?: AttentionQueue;
  docs: DocRow[];
  users: PersonRow[];
  candidates: CandidateDoc[];
  /** What the viewer may do (F6): manage = request, remind, stop; export = the CSVs. */
  can: { manage: boolean; export: boolean };
}

/**
 * One row of GET /api/documents/{id}/acknowledgements (the roster expand):
 * AckStatusRow as the route spreads it, which is the shape AckRoster takes
 * (C4, 1.12.0), so the expand row mounts the Record tab's roster as is.
 */
export type RosterRow = AckRosterRow;

/** A policy's cached roster: its rows and the resolved grace the Overdue chip and filter read (E1, 1.13.0; the route's `defaults`). */
export interface RosterCache {
  rows: RosterRow[];
  grace: number;
}

/** The POST answers the portal reads back. */
interface PostResult {
  ok?: boolean;
  queued?: number;
  eligible?: number;
  acked?: number;
  required?: number;
  /** POST /ack/retire: the marker version's number; POST /ack/unretire: the confirmations current after the switch. */
  rev?: number | null;
  current?: number;
  /** The assignments route (D2): the rows it changed and skipped, and a snooze's end. */
  changed?: number[];
  skipped?: number[];
  until?: string | null;
}

/** The queue's per-person reasons: the rows whose actions are Remind, Extend 7 days, Snooze and Exempt…. */
export const ATTENTION_PERSON_REASONS: ReadonlySet<PolicyAttentionReason> = new Set([
  "overdue",
  "escalated",
  "never_opened",
  "opened_not_confirmed",
]);

/** The error toast when the assignments route changed nothing for the row (it came back skipped). */
export const QUEUE_NOTHING_CHANGED = "Nothing changed: this row was skipped (exempt, removed or already in that state).";

/** The props every routed portal page takes from its server page. */
export interface PortalPageProps {
  licensed: boolean;
  /** Whether the viewer can open Settings → License (the gate's button). Passed from the server. */
  canManageLicense?: boolean;
}

export function pageOf<T>(rows: T[], page: number, size: number): T[] {
  return rows.slice(page * size, (page + 1) * size);
}

/**
 * The checkbox columns' selection behind the Policies and People bulk bars
 * (F5, 1.14.0): a set of ids, a row toggle with shift-click range selection
 * (the range runs between the last row clicked and this one in the list's
 * current order, so it respects the filter and the sort), a header toggle
 * over the rows shown, and Clear. The selection only ever names rows that
 * are still on the page: a reload prunes it (a successful action clears it
 * explicitly). `existing` is every selectable id the page holds right now.
 */
export function useBulkSelection(existing: number[]) {
  const [selected, setSelected] = useState<Set<number>>(() => new Set());
  const anchor = useRef<number | null>(null);
  const shift = useRef(false);
  const existingKey = existing.join(",");
  useEffect(() => {
    const keep = new Set(existingKey ? existingKey.split(",").map(Number) : []);
    setSelected((s) => {
      let dropped = false;
      const next = new Set<number>();
      for (const id of s) {
        if (keep.has(id)) next.add(id);
        else dropped = true;
      }
      return dropped ? next : s;
    });
  }, [existingKey]);

  /** On the checkbox's click, before its change: whether Shift was held. */
  const markShift = useCallback((e: ReactMouseEvent) => {
    shift.current = e.shiftKey;
  }, []);

  /** Toggle one row; with Shift held, every row between the last one clicked and this one (in `ordered`) takes this row's new state. */
  const toggle = useCallback((id: number, ordered: number[]) => {
    setSelected((s) => {
      const next = new Set(s);
      const on = !s.has(id);
      let range = [id];
      const from = anchor.current;
      if (shift.current && from != null && from !== id) {
        const a = ordered.indexOf(from);
        const b = ordered.indexOf(id);
        if (a >= 0 && b >= 0) range = ordered.slice(Math.min(a, b), Math.max(a, b) + 1);
      }
      for (const x of range) {
        if (on) next.add(x);
        else next.delete(x);
      }
      return next;
    });
    anchor.current = id;
    shift.current = false;
  }, []);

  /** The header checkbox: select every id shown, or clear them when they all are. */
  const toggleAll = useCallback((ids: number[]) => {
    setSelected((s) => {
      const next = new Set(s);
      const all = ids.length > 0 && ids.every((id) => s.has(id));
      for (const id of ids) {
        if (all) next.delete(id);
        else next.add(id);
      }
      return next;
    });
    anchor.current = null;
  }, []);

  const clear = useCallback(() => {
    setSelected(new Set());
    anchor.current = null;
  }, []);

  return {
    selected,
    size: selected.size,
    has: (id: number) => selected.has(id),
    allOf: (ids: number[]) => ids.length > 0 && ids.every((id) => selected.has(id)),
    someOf: (ids: number[]) => ids.some((id) => selected.has(id)),
    markShift,
    toggle,
    toggleAll,
    clear,
  };
}

export type BulkSelection = ReturnType<typeof useBulkSelection>;

export function usePortal(licensed: boolean) {
  const { run, isBusy, busy } = useAction();
  const fmt = useFormatDate();
  const [data, setData] = useState<CompliancePayload | null>(null);
  const [loadError, setLoadError] = useState("");
  const [open, setOpen] = useState<number | null>(null);
  const [rosters, setRosters] = useState<Record<number, RosterCache>>({});
  const [rosterPage, setRosterPage] = useState(0);
  const [candidate, setCandidate] = useState<number | null>(null);
  const [previewing, setPreviewing] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/compliance");
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d?.error || "Couldn't load the compliance portal.");
      setData(d as CompliancePayload);
      setLoadError("");
    } catch (e) {
      setLoadError(e instanceof Error && e.message ? e.message : "Couldn't load the compliance portal.");
    }
  }, []);
  useEffect(() => {
    if (licensed) void load();
  }, [licensed, load]);

  /** Forget a policy's cached roster so the next expand reloads it. */
  const dropRoster = useCallback((docId: number) => {
    setRosters((prev) => {
      if (!(docId in prev)) return prev;
      const next = { ...prev };
      delete next[docId];
      return next;
    });
  }, []);

  /** One POST through useAction: the server's error or the fallback is toasted; the body comes back on success. */
  async function postTo(key: string, url: string, body: Record<string, unknown>, fallback: string): Promise<PostResult | null> {
    const box: { result?: PostResult } = {};
    const ok = await run(
      key,
      async () => {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (res.ok) box.result = (await res.clone().json().catch(() => ({}))) as PostResult;
        return res;
      },
      { fallback, refresh: false }
    );
    return ok ? (box.result ?? {}) : null;
  }

  /** The portal's own POST (request, remind, stop). */
  function post(key: string, body: Record<string, unknown>, fallback: string): Promise<PostResult | null> {
    return postTo(key, "/api/admin/compliance", body, fallback);
  }

  async function requestConfirmation() {
    if (candidate == null || !data) return;
    const doc = data.candidates.find((c) => c.id === candidate);
    if (!doc) return;
    // The count shown is the audience at that moment.
    setPreviewing(true);
    let eligible = 0;
    try {
      const res = await fetch(`/api/admin/compliance?preview=${doc.id}`);
      const d = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast("error", d?.error || "Couldn't count who would be asked.");
        return;
      }
      eligible = Number(d?.eligible ?? 0);
    } catch {
      toast("error", "Couldn't count who would be asked.");
      return;
    } finally {
      setPreviewing(false);
    }
    const choice = await requireAckDialog({ title: doc.title, count: eligible });
    if (!choice) return;
    const r = await post(
      `request-${doc.id}`,
      { docId: doc.id, action: "request", notify: choice === "notify" },
      "Couldn't request a read confirmation."
    );
    if (!r) return;
    toast(
      "ok",
      choice === "notify"
        ? `Read confirmation required: ${people(r.queued ?? eligible)} will be notified.`
        : `Read confirmation required for "${doc.title}". No notice sent.`
    );
    setCandidate(null);
    dropRoster(doc.id);
    await load();
  }

  async function remind(d: DocRow) {
    const pending = Math.max(0, d.required - d.acked);
    const answer = await confirmDialog({
      title: `Remind ${people(pending)}?`,
      body: `Everyone who has not confirmed "${d.title}" yet gets a notice and, unless they opted out, an email. This cannot be undone.`,
      confirmLabel: "Send reminders",
    });
    if (answer !== true) return;
    const r = await post(`remind-${d.id}`, { docId: d.id, action: "remind" }, "Couldn't send reminders.");
    if (!r) return;
    toast("ok", `Reminders queued for ${people(r.queued ?? pending)}.`);
    dropRoster(d.id);
    await load();
  }

  // Reversible, so it tells rather than asks (STYLEGUIDE §Feedback): the
  // record is kept, and Undo re-requests quietly.
  async function stopRequiring(d: DocRow) {
    const r = await post(
      `stop-${d.id}`,
      { docId: d.id, action: "stop" },
      "Couldn't stop requiring a read confirmation."
    );
    if (!r) return;
    dropRoster(d.id);
    toast("ok", `Read confirmation no longer required for "${d.title}"`, {
      action: { label: "Undo", onClick: () => void undoStop(d) },
    });
    await load();
  }

  async function undoStop(d: DocRow) {
    const r = await post(
      `request-${d.id}`,
      { docId: d.id, action: "request", notify: false },
      "Couldn't restore the requirement."
    );
    if (!r) return;
    dropRoster(d.id);
    toast("ok", `Read confirmation required again for "${d.title}". No notice sent.`);
    await load();
  }

  // Retire (G3): the question carries the standing (the row's counts and the
  // marker's version) and one required reason, awaited before anything is
  // busy so Cancel leaves the row idle (STYLEGUIDE §Overlays). The server
  // freezes the counts, keeps every confirmation and moves the policy to
  // the Retired group on the next load; the toast says what is on record.
  // Resolves with the policy's id once the list has reloaded, so the page
  // can move focus to the row's new place; null when cancelled or refused.
  async function retire(d: DocRow): Promise<number | null> {
    const version = d.ack_rev ? `version ${d.ack_rev}` : "the current version";
    const values = await formDialog({
      title: `Retire "${d.title}"?`,
      body: `${d.acked} of ${d.required} people have confirmed ${version}. Retiring stops asking anyone to confirm, keeps every confirmation on record, and lists the policy under Retired in Compliance. The document itself stays as it is; unpublish it separately if people should no longer read it.`,
      fields: [
        {
          key: "reason",
          label: "Why is this policy being retired?",
          type: "textarea",
          required: true,
          help: "Shown on the compliance record and in exports",
          validate: (v) => (v.trim().length < 10 ? RECONFIRM_REASON_TOO_SHORT : undefined),
        },
      ],
      confirmLabel: "Retire policy",
    });
    if (!values) return null;
    const r = await postTo(
      `retire-${d.id}`,
      `/api/documents/${d.id}/ack/retire`,
      { reason: values.reason.trim() },
      "Couldn't retire the policy."
    );
    if (!r) return null;
    dropRoster(d.id);
    toast("ok", `Policy retired: ${r.acked ?? d.acked} of ${r.required ?? d.required} confirmations on record`);
    await load();
    return d.id;
  }

  // Un-retire (G3): one question, because resuming puts the policy back on
  // everyone's list; the toast carries the standing the server answers
  // with and, while any confirmation is still current, offers the deliberate
  // re-ask (A7) as its action: the button's own question and POST through
  // askReconfirm, with the list reloaded after a successful ask. Resolves
  // with the policy's id once the list has reloaded (see retire).
  async function unretire(d: DocRow): Promise<number | null> {
    const answer = await confirmDialog({
      title: `Resume read confirmation for "${d.title}"?`,
      body: "Confirmations made before it was retired stay on record. If the text changed while it was retired, people whose confirmation is older than the current version are asked again.",
      confirmLabel: "Resume",
    });
    if (answer !== true) return null;
    const r = await postTo(`unretire-${d.id}`, `/api/documents/${d.id}/ack/unretire`, {}, "Couldn't resume the policy.");
    if (!r) return null;
    dropRoster(d.id);
    const current = r.current ?? 0;
    const eligible = r.eligible ?? 0;
    const reload = () => {
      dropRoster(d.id);
      void load();
    };
    toast(
      "ok",
      `Policy resumed: ${current} of ${eligible} confirmations still current`,
      current > 0
        ? {
            action: {
              label: RECONFIRM_LABEL,
              onClick: () =>
                void askReconfirm({
                  docId: d.id,
                  title: d.title,
                  summary: { current, eligible, rev: d.ack_rev ?? null },
                  run,
                  refresh: false,
                }).then((asked) => asked && reload()),
            },
          }
        : {}
    );
    await load();
    return d.id;
  }

  // ── The Needs attention queue's row actions (F1, 1.14.0) ──────────────────
  //
  // Each takes the queue row, posts to the assignments route with its
  // assignment id, toasts the roster's sentence for one person and reloads
  // the payload (the row leaves the queue or changes reason). Every one
  // resolves true when something changed, false when cancelled, refused or
  // skipped, so the page can move focus to the row's neighbour only when
  // the row is gone. The reversible ones carry Undo as the inverse call.

  /** One POST to the assignments route; null when refused (already toasted) or when the row came back skipped (toasted here). */
  async function assignment(key: string, body: Record<string, unknown>, fallback: string): Promise<PostResult | null> {
    const r = await postTo(key, "/api/admin/compliance/assignments", body, fallback);
    if (!r) return null;
    if (!r.changed || r.changed.length === 0) {
      toast("error", QUEUE_NOTHING_CHANGED);
      return null;
    }
    return r;
  }

  const nameOf = (row: PolicyAttentionRow) => row.user_name || people(1);

  /** Remind: the portal's per-policy reminder for the row's policy (the question and the hour apply). */
  async function remindFor(row: PolicyAttentionRow): Promise<boolean> {
    const d = data?.docs.find((x) => x.id === row.document_id);
    if (!d) {
      toast("error", "This policy is no longer on the list.");
      return false;
    }
    await remind(d);
    return true;
  }

  /** Extend 7 days: the deadline pushed out a week (escalation and snooze cleared), with Undo. */
  async function extendWeek(row: PolicyAttentionRow): Promise<boolean> {
    if (row.assignment_id == null) return false;
    const id = row.assignment_id;
    const r = await assignment(`extend-${id}`, { action: "extend", assignment_ids: [id], days: EXTEND_DAYS_DEFAULT }, "Couldn't extend the due date.");
    if (!r) return false;
    toast("ok", `Extended the deadline for ${nameOf(row)} by ${EXTEND_DAYS_DEFAULT} days`, {
      action: { label: "Undo", onClick: () => void undoExtendFor(row, r.changed!) },
    });
    await load();
    return true;
  }

  async function undoExtendFor(row: PolicyAttentionRow, ids: number[]) {
    const r = await assignment(`undo-extend-${ids[0]}`, { action: "undo_extend", assignment_ids: ids }, "Couldn't undo the extension.");
    if (!r) return;
    toast("ok", `Extension undone: the deadline for ${nameOf(row)} is back to its previous date.`);
    await load();
  }

  /** Snooze: out of this queue and no automatic reminders for a week; nothing else moves (the D2 invariant). With Undo. */
  async function snoozeWeek(row: PolicyAttentionRow): Promise<boolean> {
    if (row.assignment_id == null) return false;
    const id = row.assignment_id;
    const r = await assignment(`snooze-${id}`, { action: "snooze", assignment_ids: [id], days: SNOOZE_DAYS_DEFAULT }, "Couldn't snooze this row.");
    if (!r) return false;
    const until = r.until ? fmt.date(r.until) : `${SNOOZE_DAYS_DEFAULT} days from now`;
    toast("ok", `Snoozed ${nameOf(row)} until ${until}: out of this queue, automatic reminders paused.`, {
      action: { label: "Undo", onClick: () => void unsnoozeFor(row, r.changed!) },
    });
    await load();
    return true;
  }

  async function unsnoozeFor(row: PolicyAttentionRow, ids: number[]) {
    const r = await assignment(`unsnooze-${ids[0]}`, { action: "unsnooze", assignment_ids: ids }, "Couldn't resume reminders.");
    if (!r) return;
    toast("ok", `Snooze undone: ${nameOf(row)} is back in the queue and reminders resume.`);
    await load();
  }

  /** Exempt…: the roster's question (a reason, an optional end date; the queue spans policies, so it names this one), then the row leaves every count. With Undo. */
  async function exemptFor(row: PolicyAttentionRow): Promise<boolean> {
    if (row.assignment_id == null) return false;
    const id = row.assignment_id;
    // Awaited before anything is busy (STYLEGUIDE §Overlays): Cancel leaves the row idle.
    const values = await exemptDialog(nameOf(row), `"${row.title}"`);
    if (!values) return false;
    return exemptWith(row, [id], values.reason, values.until);
  }

  async function exemptWith(row: PolicyAttentionRow, ids: number[], reason: string, until: string | null, opts: { undo?: boolean } = {}): Promise<boolean> {
    const r = await assignment(`exempt-${ids[0]}`, { action: "exempt", assignment_ids: ids, reason, until }, "Couldn't record the exemption.");
    if (!r) return false;
    const text = `Exempted ${nameOf(row)} from "${row.title}"`;
    if (opts.undo) toast("ok", text);
    else toast("ok", text, { action: { label: "Undo", onClick: () => void unexemptWith(row, r.changed!, { undo: true }) } });
    await load();
    return true;
  }

  /** Remove exemption (a standing exemption under review): pending again with a fresh due date; Undo exempts again with the same reason. */
  async function unexemptFor(row: PolicyAttentionRow): Promise<boolean> {
    if (row.assignment_id == null) return false;
    return unexemptWith(row, [row.assignment_id]);
  }

  async function unexemptWith(row: PolicyAttentionRow, ids: number[], opts: { undo?: boolean } = {}): Promise<boolean> {
    const r = await assignment(`unexempt-${ids[0]}`, { action: "unexempt", assignment_ids: ids }, "Couldn't remove the exemption.");
    if (!r) return false;
    if (opts.undo) {
      toast("ok", `Exemption undone: ${nameOf(row)} is pending again.`);
    } else {
      // The exemption's reason travels on a standing-exemption row as its
      // detail (an exemption needs a reason; the date was open-ended).
      const reason = row.detail || "Exemption restored";
      toast("ok", `Removed the exemption for ${nameOf(row)}: pending again with a fresh due date.`, {
        action: { label: "Undo", onClick: () => void exemptWith(row, r.changed!, reason, null, { undo: true }) },
      });
    }
    await load();
    return true;
  }

  /** One read of a policy's roster JSON: the rows and the resolved grace (the route's `defaults`, 1.13.0). */
  const fetchRoster = useCallback(async (docId: number): Promise<RosterCache> => {
    const res = await fetch(`/api/documents/${docId}/acknowledgements`);
    const d = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(d?.error || "");
    return { rows: (d?.rows ?? []) as RosterRow[], grace: Number(d?.defaults?.overdue_grace_days ?? 0) };
  }, []);

  /**
   * Re-read one policy's roster after a row or bulk action in the expand
   * row (1.13.0: extend, exempt, snooze, a per-person re-ask, and each Undo),
   * and the counts with it. The row stays open; a failed read is a toast,
   * never a stale table presented as fresh.
   */
  const reloadRoster = useCallback(
    async (docId: number) => {
      try {
        const next = await fetchRoster(docId);
        setRosters((prev) => ({ ...prev, [docId]: next }));
      } catch (e) {
        toast("error", (e instanceof Error && e.message) || "Couldn't reload the roster.");
      }
      void load();
    },
    [fetchRoster, load]
  );

  /** Open a policy's roster without ever folding it: the escalation notice's `?policy=` link (E2). */
  async function openRoster(docId: number) {
    if (open === docId) return;
    await toggleRoster(docId);
  }

  async function toggleRoster(docId: number) {
    if (open === docId) {
      setOpen(null);
      return;
    }
    setOpen(docId);
    setRosterPage(0);
    if (rosters[docId]) return;
    try {
      const next = await fetchRoster(docId);
      setRosters((prev) => ({ ...prev, [docId]: next }));
    } catch (e) {
      // Never a permanent spinner: say why, and fold the row back.
      toast("error", (e instanceof Error && e.message) || "Couldn't load the roster.");
      setOpen((cur) => (cur === docId ? null : cur));
    }
  }

  return {
    data,
    loadError,
    load,
    isBusy,
    busy,
    open,
    rosters,
    rosterPage,
    setRosterPage,
    candidate,
    setCandidate,
    previewing,
    dropRoster,
    reloadRoster,
    requestConfirmation,
    remind,
    stopRequiring,
    retire,
    unretire,
    toggleRoster,
    openRoster,
    /** The Needs attention queue's row actions (F1, 1.14.0). */
    attention: { remind: remindFor, extendWeek, snoozeWeek, exempt: exemptFor, unexempt: unexemptFor },
  };
}

export type Portal = ReturnType<typeof usePortal>;
