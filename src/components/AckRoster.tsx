"use client";

// The Record tab's roster (C4, 1.12.0): the house Table with the house
// controls over it. "Show" narrows the current view to pending, overdue,
// confirmed or exempt people, "Filter people" narrows what is on the page
// with its live count, the Pager keeps a 400-person space readable, and
// "Current version / All confirmations" switches between the roster (one
// row per person, their confirmation that counts against the marker) and
// the ledger (every confirmation ever recorded for the document, superseded
// rows included). Controls stay off paper (STYLEGUIDE §Print): the record is
// printed as evidence, and the page prints the view and page on screen.
//
// 1.13.0 (D2, D4, E1): each row carries its assignment (lib/db
// ackStatusForDocument): the Due column, the Exemption column (the reason,
// who recorded it and until when; a per-person re-ask's reason; a snooze),
// the Overdue / Exempt / "Asked again {date}" chips, and, for a viewer who
// may act (document.ack_require on the space or compliance.program_manage),
// a leading checkbox column, row actions as icon buttons (Extend due date…,
// Exempt…, Remove exemption, Snooze / Unsnooze, Ask to re-confirm…) and a
// bulk bar "{n} selected" with the same actions, under the same labels,
// over the checked assignment ids (a row's data-tt is its aria-label; a
// snooze's date goes in the toast and the Exemption cell, never the label).
// Every action is one POST to `endpoint` (the space-scoped twin
// /api/documents/{id}/acknowledgements/actions for a steward, the admin
// route /api/admin/compliance/assignments for a program manager; the same
// body and answer), reversible, so it tells and offers Undo as the inverse
// call (STYLEGUIDE §Feedback); the re-ask is a notice already sent and
// offers none. The control is disabled while a request is in flight
// (useAction), and focus returns to the row once the refreshed rows have
// rendered, because the button that opened the dialog may be gone by then
// (Exempt… becomes Remove exemption).
//
// Shared with the compliance portal's expand row: the server page passes
// the rows it already read; the portal passes the JSON roster and may leave
// `ledger` out, which hides the view switch, and passes `onChanged` so it
// can reload its own copy of the rows.
//
// 1.14.0 (F3): the person cell links to the person's compliance record
// (/compliance/person/{id}) when the caller passes `recordLinks`; the three
// questions (Exempt…, Extend due date…, Ask to re-confirm…) are exported as
// `exemptDialog`, `extendDialog` and `reaskDialog`, so the record page asks
// them in the same words.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  BellOff,
  BellRing,
  CalendarPlus,
  Check,
  ChevronDown,
  Download,
  FileSpreadsheet,
  PenLine,
  Printer,
  RotateCcw,
  UserCheck,
  UserMinus,
} from "lucide-react";
import { chipClass } from "@/components/Chip";
import { Segmented } from "@/components/Segmented";
import { ListFilter } from "@/components/ListFilter";
import { Pager } from "@/components/Pager";
import { Popover, MenuItem, MenuSeparator } from "@/components/Popover";
import { SectionEmpty } from "@/components/form";
import { Table, Th, Td, TABLE_HEAD_ROW, TR } from "@/components/Table";
import { Button, buttonClass, iconButtonClass } from "@/components/Button";
import { Tooltip } from "@/components/Tooltip";
import { formDialog } from "@/components/Dialog";
import { toast } from "@/components/Toasts";
import { RECONFIRM_REASON_TOO_SHORT } from "@/components/ReconfirmButton";
import { people } from "@/components/compliance/copy";
import { useAction } from "@/lib/use-action";
import { formatDate, formatDateTime } from "@/lib/format";
import type { AppSettings } from "@/lib/settings";
import { isShortRead, readTimeLabel, SHORT_READ_TOOLTIP } from "@/lib/read-evidence";
import { isOverdue } from "@/lib/ack-due";
import {
  ASSIGNMENT_IDS_MAX,
  EXEMPT_REASON_MAX,
  EXTEND_DAYS_DEFAULT,
  EXTEND_DAYS_MAX,
  REASK_REASON_MIN,
  SNOOZE_DAYS_DEFAULT,
  SNOOZE_DAYS_MAX,
  SNOOZE_INVARIANT,
  exemptionText,
  snoozeText,
} from "@/lib/ack-assignments";
import type { AssignmentAction } from "@/lib/ack-assignments";

/** One person of the current view: AckStatusRow's shape (the C2 and 1.13.0 fields are optional so the portal's JSON rows fit too). */
export interface AckRosterRow {
  id: number;
  name: string;
  username: string;
  email?: string;
  role?: string;
  acknowledged_at: string | null;
  rev: number | null;
  version_source?: "recorded" | "inferred" | null;
  read_seconds?: number | null;
  reached_end?: boolean | null;
  /** The name typed when the policy required a signature (C2); blank or absent on unsigned rows. */
  signed_name?: string | null;
  /**
   * The person's assignment row (D1/D2/D4, 1.13.0): its id (what the
   * actions send), the deadline (null without one), the exemption (then the
   * row is in no count) with its reason, who recorded it, when and until
   * when, the snooze's end, and the per-person re-ask (when, why, by whom).
   */
  assignment_id?: number | null;
  due_at?: string | null;
  exempt?: boolean;
  exempt_reason?: string;
  exempt_by_name?: string;
  exempt_at?: string | null;
  exempt_until?: string | null;
  snoozed_until?: string | null;
  asked_again_at?: string | null;
  asked_again_reason?: string;
  asked_again_by?: string;
}

/** One row of the ledger (the All confirmations view): AckLedgerRow's shape, personal data already blanked by the server. */
export interface AckLedgerViewRow {
  id: number;
  name: string;
  username: string;
  email: string;
  account_removed: boolean;
  acknowledged_at: string;
  superseded: boolean;
  rev: number | null;
  version_source: "recorded" | "inferred" | null;
  signed_name: string | null;
  read_seconds: number | null;
  reached_end: boolean;
  ip: string;
}

type Show = "all" | "pending" | "overdue" | "confirmed" | "exempt";
type View = "current" | "ledger";

/** A row's standing (STYLEGUIDE §Status chips: the closed set). */
type RowState = "confirmed" | "pending" | "overdue" | "exempt";

/** Rows per page: a space of 400 people stays readable. */
export const ROSTER_PAGE = 50;

const SHOW_OPTIONS: { value: Show; label: string }[] = [
  { value: "all", label: "All" },
  { value: "pending", label: "Pending" },
  { value: "overdue", label: "Overdue" },
  { value: "confirmed", label: "Confirmed" },
  { value: "exempt", label: "Exempt" },
];

const VIEW_OPTIONS: { value: View; label: string }[] = [
  { value: "current", label: "Current version" },
  { value: "ledger", label: "All confirmations" },
];

/** The section-level line when the Show choice leaves nobody. */
const EMPTY_BY_SHOW: Record<Show, string> = {
  all: "Nobody is asked to confirm this document.",
  pending: "Nobody is pending: everyone asked has confirmed.",
  overdue: "Nobody is overdue.",
  confirmed: "Nobody has confirmed the current version yet.",
  exempt: "Nobody is exempt from this policy.",
};

/** The sentence the roster shows while nobody is asked yet (also the portal's expand row). */
export const NOBODY_ASKED = "No one is asked to confirm this document yet. Everyone who can see it is listed here once it is published.";

/** The bulk bar's cap, as the server enforces it (ASSIGNMENT_IDS_MAX). */
export const BULK_CAP_TOOLTIP = `Up to ${ASSIGNMENT_IDS_MAX} people at a time.`;

/** The error toast when the server changed none of the rows sent (every id came back skipped). */
export const NOTHING_CHANGED = "Nothing changed: the selected people were skipped (exempt, removed or already in that state).";

/** What the two action routes answer (lib/ack-assignment-actions AssignmentAnswer). */
interface ActionAnswer {
  action: AssignmentAction;
  changed: number[];
  skipped: number[];
  until: string | null;
}

const DAY = 86_400_000;

/** "v12", marked "(inferred)" on rows from before 1.10.0. The explanation is
 *  a footnote under the table, not a tooltip: the table scrolls sideways
 *  inside its card, and a tooltip bubble is clipped by that container. */
export function VersionCell({ row }: { row: { rev: number | null; version_source?: "recorded" | "inferred" | null } }) {
  if (!row.rev) return <>—</>;
  if (row.version_source === "inferred") {
    return (
      <span className="inline-flex items-center gap-1.5">
        v{row.rev}
        <span className="text-xs text-slate-500">(inferred)</span>
      </span>
    );
  }
  return <>v{row.rev}</>;
}

/**
 * "6 min", "under 1 min", blank when the record holds no read time. The
 * warn tone (ink, not a chip: this is a measurement, not a status) applies
 * only below a quarter of a typical read of the document, with the tooltip
 * on a focusable span as the style guide asks of non-interactive elements.
 */
export function ReadTimeCell({ seconds, words }: { seconds: number | null | undefined; words: number }) {
  const label = readTimeLabel(seconds);
  if (!label) return null;
  if (isShortRead(seconds, words)) {
    return (
      <span className="ink-warn" data-tt={SHORT_READ_TOOLTIP} data-tt-wrap tabIndex={0}>
        {label}
      </span>
    );
  }
  return <>{label}</>;
}

/** A check mark when the reader's browser reported the end on screen; nothing otherwise. */
export function ReachedEndCell({ reached }: { reached: boolean | null | undefined }) {
  if (!reached) return null;
  return (
    <>
      <Check className="h-4 w-4 ink-ok" aria-hidden="true" />
      <span className="sr-only">Yes</span>
    </>
  );
}

/** The typed signature (C2): the name in plain text behind a pen, no tooltip; nothing on an unsigned row. */
export function SignedCell({ name }: { name: string | null | undefined }) {
  if (!name) return null;
  return (
    <span className="inline-flex items-center gap-1.5">
      <PenLine className="h-3.5 w-3.5 shrink-0 text-slate-400" aria-hidden />
      {name}
    </span>
  );
}

/** The person: a link to their compliance record (F3) when the caller may open it, plain text otherwise. */
function PersonCell({ name, username, email, href }: { name: string; username: string; email?: string; href?: string }) {
  const label = name || username;
  return (
    <>
      {href ? (
        <Link href={href} className="font-medium text-slate-800 hover:text-compass-700">
          {label}
        </Link>
      ) : (
        <span className="font-medium text-slate-800">{label}</span>
      )}
      {email && <span className="ml-2 text-xs text-slate-500">{email}</span>}
    </>
  );
}

function matches(needle: string, ...values: (string | null | undefined)[]): boolean {
  if (!needle) return true;
  return values.some((v) => (v ?? "").toLowerCase().includes(needle));
}

const nameOf = (r: AckRosterRow) => r.name || r.username;

/** A snooze that has not run out yet (the server reads a passed snoozed_until as no snooze). */
function isSnoozed(r: AckRosterRow, now: Date): boolean {
  return Boolean(r.snoozed_until) && new Date(r.snoozed_until!).getTime() > now.getTime();
}

/** Exempt outranks everything (the row is in no count); then the confirmation; then the deadline (lib/ack-due isOverdue with the policy's grace). */
function stateOf(r: AckRosterRow, grace: number, now: Date): RowState {
  if (r.exempt) return "exempt";
  if (r.acknowledged_at) return "confirmed";
  if (r.due_at && isOverdue({ due_at: r.due_at, acknowledged_at: null }, { overdue_grace_days: grace }, now)) return "overdue";
  return "pending";
}

/** Today as the date input and the server see it (YYYY-MM-DD, UTC: parseAssignmentRequest's rule). */
export const today = () => new Date().toISOString().slice(0, 10);

/**
 * The calendar day of an instant in the workspace zone ('YYYY-MM-DD'; en-CA
 * prints the ISO order). An exemption's `until` is stored as that day's
 * last instant in the zone (lib/ack-due endOfDayIn), so sliced in UTC it
 * names the day before anywhere west of UTC; read in the zone it is the
 * day the manager typed.
 */
export function dayIn(iso: string, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: timeZone || "UTC", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
  } catch {
    return iso.slice(0, 10);
  }
}

// ── The three questions (D2, D4), in the spec's words ───────────────────────
// Each is awaited before anything is busy (STYLEGUIDE §Overlays), so Cancel
// leaves the control idle, and answers null when the person cancelled. The
// roster and the person record (F3, 1.14.0) ask them; nothing else holds a
// copy of these sentences.

/**
 * Exempt…: the required reason (shown on the record and in exports) and the
 * optional end date (after today). `policy` names the policy where the page
 * spans several ("this policy" on a document's own roster).
 */
export async function exemptDialog(who: string, policy = "this policy"): Promise<{ reason: string; until: string | null } | null> {
  const values = await formDialog({
    title: `Exempt ${who} from ${policy}`,
    fields: [
      {
        key: "reason",
        label: "Reason",
        type: "textarea",
        required: true,
        help: "Shown on the compliance record and in exports",
        validate: (v) => (v.trim().length > EXEMPT_REASON_MAX ? `Keep the reason under ${EXEMPT_REASON_MAX} characters.` : undefined),
      },
      {
        key: "until",
        label: "Until (optional)",
        type: "date",
        required: false,
        validate: (v) => (v && v <= today() ? "Pick a date after today." : undefined),
      },
    ],
    confirmLabel: "Exempt",
  });
  if (!values) return null;
  return { reason: values.reason.trim(), until: values.until || null };
}

/** Extend due date…: the days (1..365, 7 by default) and an optional reason; `body` may name the person and the policy. */
export async function extendDialog(count: number, body?: string): Promise<{ days: number; reason: string } | null> {
  const values = await formDialog({
    title: count === 1 ? "Extend due date" : `Extend due dates for ${people(count)}`,
    body,
    fields: [
      { key: "days", label: "Days", type: "number", min: 1, max: EXTEND_DAYS_MAX, initial: String(EXTEND_DAYS_DEFAULT) },
      { key: "reason", label: "Reason (optional)", type: "textarea", required: false, help: "Recorded on the compliance record" },
    ],
    confirmLabel: "Extend",
  });
  if (!values) return null;
  return { days: Number(values.days), reason: values.reason.trim() };
}

/**
 * Ask to re-confirm…: the reason of at least ten characters. `one` is the
 * person and the version they confirmed when the ask is for one person;
 * null asks for `count` people at once (the bulk bar).
 */
export async function reaskDialog(opts: {
  one: { name: string; rev: number | null } | null;
  count: number;
  /** The document's title for the question; "this document" when absent. */
  title?: string;
}): Promise<string | null> {
  const { one, count, title } = opts;
  const version = one?.rev ? `version ${one.rev}` : "the current version";
  const values = await formDialog({
    title: one
      ? title
        ? `Ask ${one.name} to re-confirm "${title}"?`
        : `Ask ${one.name} to re-confirm this document?`
      : `Ask ${people(count)} to re-confirm`,
    body: one
      ? `Their confirmation of ${version} stays in the record. They are asked to read the document and confirm again.`
      : "Their confirmations stay in the record. They are asked to read the document and confirm again.",
    fields: [
      {
        key: "reason",
        label: one ? "Why is this person being asked again?" : "Why are these people being asked again?",
        type: "textarea",
        required: true,
        validate: (v) => (v.trim().length < REASK_REASON_MIN ? RECONFIRM_REASON_TOO_SHORT : undefined),
      },
    ],
    confirmLabel: "Ask to re-confirm",
  });
  return values ? values.reason.trim() : null;
}

/**
 * The Exemption column, plain text, never a tooltip in the table
 * (STYLEGUIDE §Tables): "On leave until 1 Dec · Priya Shah · 3 Oct" on an
 * exempt row; the re-ask's reason and who asked on a row asked again; the
 * snooze ("Snoozed until 22 Oct") after either.
 */
function exemptionNote(r: AckRosterRow, fmt: AppSettings, now: Date): string {
  const f = (iso: string) => formatDate(iso, fmt);
  const parts: string[] = [];
  if (r.exempt) {
    parts.push(
      exemptionText(
        { exempt_reason: r.exempt_reason ?? "", exempt_until: r.exempt_until ?? null, exempt_by_name: r.exempt_by_name ?? "", exempt_at: r.exempt_at ?? null },
        f
      )
    );
  } else if (r.asked_again_at && !r.acknowledged_at && r.asked_again_reason) {
    parts.push([r.asked_again_reason, r.asked_again_by].filter(Boolean).join(" · "));
  }
  if (!r.exempt && isSnoozed(r, now)) parts.push(snoozeText({ snoozed_until: r.snoozed_until! }, f));
  return parts.filter(Boolean).join(" · ");
}

/**
 * The status chip (the closed set) and, on a row asked again that has not
 * confirmed since, the "Asked again {date}" chip beside it. Only a real
 * re-ask earns the chip (one with a reason or an asker: the per-person
 * ledger row behind it); a row re-opened because the person returned to the
 * audience carries the same stamp, and nobody asked them.
 */
function StatusCell({ row, state, fmt }: { row: AckRosterRow; state: RowState; fmt: AppSettings }) {
  const chip =
    state === "exempt" ? (
      <span className={chipClass("neutral")}>Exempt</span>
    ) : state === "confirmed" ? (
      <span className={chipClass("ok")}>Confirmed</span>
    ) : state === "overdue" ? (
      <span className={chipClass("error")}>Overdue</span>
    ) : (
      <span className={chipClass("warn")}>Pending</span>
    );
  const askedAgain =
    (state === "pending" || state === "overdue") && row.asked_again_at && Boolean(row.asked_again_reason || row.asked_again_by);
  if (!askedAgain) return chip;
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {chip}
      <span className={chipClass("warn")}>Asked again {formatDate(row.asked_again_at, fmt)}</span>
    </span>
  );
}

/** A row action: an icon button with its tooltip and the same accessible name (STYLEGUIDE §Buttons). */
function IconAction({
  icon,
  label,
  onClick,
  disabled,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  disabled: boolean;
}) {
  return (
    <button
      type="button"
      className={iconButtonClass("quiet", "sm")}
      data-tt={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
    >
      {icon}
    </button>
  );
}

/** A bulk-bar action: the same `secondary` `sm` button the rows' menus would be, disabled inside the cap's tooltip past 200 people. */
function BulkButton({
  icon,
  label,
  count,
  busy,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  /** How many of the selected rows this action applies to. */
  count: number;
  busy: boolean;
  onClick: () => void;
}) {
  const tooMany = count > ASSIGNMENT_IDS_MAX;
  const button = (
    <Button variant="secondary" size="sm" icon={icon} onClick={onClick} disabled={busy || tooMany}>
      {label}
    </Button>
  );
  return tooMany ? <Tooltip label={BULK_CAP_TOOLTIP}>{button}</Tooltip> : button;
}

export function AckRoster({
  docId,
  title,
  rows,
  ledger,
  canSeeIp,
  fmt,
  words = 0,
  frame = true,
  endpoint,
  can,
  grace = 0,
  onChanged,
  recordLinks,
}: {
  docId: number;
  /** The document's title for the dialogs and toasts ("this document" when absent). */
  title?: string;
  /** The current view: everyone asked, with their confirmation that counts (pending first, exempt last). */
  rows: AckRosterRow[];
  /** Every confirmation ever recorded, newest first; absent hides the view switch (the portal's expand row). */
  ledger?: AckLedgerViewRow[];
  /** The viewer holds compliance.export: the ledger view gets its IP column. */
  canSeeIp: boolean;
  /** The viewer's date and time settings (settingsForUser). */
  fmt: AppSettings;
  /** The live document's word count, for the Read time threshold; 0 never flags a row. */
  words?: number;
  /** The table in its own bordered card (the default); false where the container frames it, as the portal's expand row does. */
  frame?: boolean;
  /**
   * Where the row and bulk actions POST (D2/D4): the space-scoped twin
   * /api/documents/{id}/acknowledgements/actions for a steward, the admin
   * route /api/admin/compliance/assignments for a program manager. Absent:
   * a read-only roster (no checkbox column, no actions, no bulk bar).
   */
  endpoint?: string;
  /** What the viewer may do: `act` = document.ack_require on the policy's space or compliance.program_manage. */
  can?: { act: boolean };
  /** The policy's resolved overdue_grace_days (lib/ack-due isOverdue): the Overdue chip and filter. */
  grace?: number;
  /** After a successful action or Undo: the caller reloads its rows (the portal). Without it the route is refreshed (a server page). */
  onChanged?: () => void;
  /**
   * The person's compliance record (F3, 1.14.0): when true, the person cell
   * of the current view links to /compliance/person/{id}. The caller
   * decides, since the record's own rule admits a roster reader for the
   * spaces they read and a programme reader for all. A boolean, not a
   * function: the Record tab is a server page, and a function cannot cross
   * into this client component.
   */
  recordLinks?: boolean;
}) {
  const [show, setShow] = useState<Show>("all");
  const [view, setView] = useState<View>("current");
  const [filter, setFilter] = useState("");
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<Set<number>>(() => new Set());
  const needle = filter.trim().toLowerCase();
  const { run, busy } = useAction();
  const canAct = Boolean(endpoint && can?.act);
  const named = title ? `"${title}"` : "this document";

  // One clock per set of rows: the Overdue chips, the filters and the snooze
  // text agree with each other, and a re-render on a keystroke moves nothing.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const now = useMemo(() => new Date(), [rows]);

  const hasLedger = Array.isArray(ledger);
  const ledgerView = hasLedger && view === "ledger";

  const byAssignment = useMemo(() => {
    const m = new Map<number, AckRosterRow>();
    for (const r of rows) if (r.assignment_id != null) m.set(r.assignment_id, r);
    return m;
  }, [rows]);

  // Focus after an action (STYLEGUIDE §Settings pages: focus never falls to
  // <body>). The dialog hands focus back to the button that opened it, and
  // that button may unmount when the refreshed rows render (Exempt… becomes
  // Remove exemption). The row is noted before the request and focused once
  // the new rows are in; a cancelled or refused action clears the note.
  const rowEls = useRef(new Map<number, HTMLTableRowElement>());
  const pendingFocus = useRef<number | null>(null);
  const registerRow = useCallback(
    (id: number) => (el: HTMLTableRowElement | null) => {
      if (el) rowEls.current.set(id, el);
      else rowEls.current.delete(id);
    },
    []
  );
  useEffect(() => {
    // A selection only ever names rows that are still here.
    setSelected((s) => {
      let dropped = false;
      const next = new Set<number>();
      for (const id of s) {
        if (byAssignment.has(id)) next.add(id);
        else dropped = true;
      }
      return dropped ? next : s;
    });
    const id = pendingFocus.current;
    if (id == null) return;
    pendingFocus.current = null;
    rowEls.current.get(id)?.focus();
  }, [byAssignment]);

  // What the Show control leaves, then what the filter leaves of that: the
  // count beside the filter reads "3 of 42 people" against the Show choice.
  const base = useMemo(() => {
    if (ledgerView) return ledger ?? [];
    if (show === "all") return rows;
    return rows.filter((r) => {
      const s = stateOf(r, grace, now);
      if (show === "pending") return s === "pending" || s === "overdue";
      return s === show;
    });
  }, [ledgerView, ledger, rows, show, grace, now]);
  const visible = useMemo(
    () => (needle ? base.filter((r) => matches(needle, r.name, r.username, r.email)) : base),
    [base, needle]
  );
  const pages = Math.max(1, Math.ceil(visible.length / ROSTER_PAGE));
  const current = Math.min(page, pages - 1);
  const slice = visible.slice(current * ROSTER_PAGE, (current + 1) * ROSTER_PAGE);
  const paged = visible.length > ROSTER_PAGE;

  const changeShow = (next: Show) => {
    setShow(next);
    setPage(0);
  };
  const changeView = (next: View) => {
    setView(next);
    setPage(0);
  };
  const changeFilter = (next: string) => {
    setFilter(next);
    setPage(0);
  };

  // ── The actions (D2, D4) ──────────────────────────────────────────────────

  /** One POST through useAction: the server's error or the fallback is toasted; the answer comes back on success. */
  const post = useCallback(
    async (key: string, body: Record<string, unknown>, fallback: string): Promise<ActionAnswer | null> => {
      if (!endpoint) return null;
      const box: { result?: Partial<ActionAnswer> } = {};
      const ok = await run(
        key,
        async () => {
          const res = await fetch(endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          });
          if (res.ok) box.result = (await res.clone().json().catch(() => ({}))) as Partial<ActionAnswer>;
          return res;
        },
        { fallback, refresh: !onChanged }
      );
      if (!ok) return null;
      onChanged?.();
      return {
        action: body.action as AssignmentAction,
        changed: box.result?.changed ?? [],
        skipped: box.result?.skipped ?? [],
        until: box.result?.until ?? null,
      };
    },
    [endpoint, onChanged, run]
  );

  const idsOf = (targets: AckRosterRow[]) => targets.map((r) => r.assignment_id).filter((id): id is number => id != null);
  /** "Ana Ruiz" for one row, "3 people" for more (STYLEGUIDE §Vocabulary). */
  const whoOf = (ids: number[]): string => {
    if (ids.length === 1) {
      const r = byAssignment.get(ids[0]);
      if (r) return nameOf(r);
    }
    return people(ids.length);
  };
  const skippedNote = (n: number): string => (n > 0 ? ` ${people(n)} ${n === 1 ? "was" : "were"} skipped.` : "");
  /** A refused request (already toasted) or one that changed nothing (toasted here) ends the flow; otherwise the selection is spent. */
  const settled = (r: ActionAnswer | null): r is ActionAnswer => {
    if (!r) {
      pendingFocus.current = null;
      return false;
    }
    if (r.changed.length === 0) {
      toast("error", NOTHING_CHANGED);
      return false;
    }
    setSelected(new Set());
    return true;
  };

  async function exempt(targets: AckRosterRow[]) {
    const ids = idsOf(targets);
    if (!ids.length) return;
    const who = ids.length === 1 ? nameOf(targets[0]) : people(ids.length);
    // Awaited before anything is busy (STYLEGUIDE §Overlays): Cancel leaves the row idle.
    const asked = await exemptDialog(who);
    if (!asked) return;
    await exemptWith(ids, asked.reason, asked.until);
  }

  async function exemptWith(ids: number[], reason: string, until: string | null, opts: { undo?: boolean } = {}) {
    pendingFocus.current = ids[0];
    const r = await post(`exempt-${ids[0]}`, { action: "exempt", assignment_ids: ids, reason, until }, "Couldn't record the exemption.");
    if (!settled(r)) return;
    const text = `Exempted ${whoOf(r.changed)} from ${named}${skippedNote(r.skipped.length)}`;
    if (opts.undo) {
      toast("ok", text);
      return;
    }
    toast("ok", text, { action: { label: "Undo", onClick: () => void unexempt(r.changed, { undo: true }) } });
  }

  async function unexempt(ids: number[], opts: { undo?: boolean } = {}) {
    // The rows as they stand now, for Remove exemption's own Undo: each is
    // exempted again with its own reason and date.
    const before = ids.map((id) => byAssignment.get(id)).filter((r): r is AckRosterRow => Boolean(r));
    pendingFocus.current = ids[0];
    const r = await post(`unexempt-${ids[0]}`, { action: "unexempt", assignment_ids: ids }, "Couldn't remove the exemption.");
    if (!settled(r)) return;
    const who = whoOf(r.changed);
    if (opts.undo) {
      toast("ok", `Exemption undone: ${who} ${r.changed.length === 1 ? "is" : "are"} pending again.`);
      return;
    }
    const changed = before.filter((row) => r.changed.includes(row.assignment_id!));
    toast("ok", `Removed the exemption for ${who}: pending again with a fresh due date.${skippedNote(r.skipped.length)}`, {
      action: { label: "Undo", onClick: () => void reexempt(changed) },
    });
  }

  /** Remove exemption's Undo: the inverse call, one per distinct reason and date (an exemption needs its reason); the date read in the workspace zone, never a UTC slice. */
  async function reexempt(before: AckRosterRow[]) {
    const groups = new Map<string, { reason: string; until: string | null; ids: number[] }>();
    for (const row of before) {
      if (row.assignment_id == null) continue;
      const day = row.exempt_until ? dayIn(row.exempt_until, fmt.timezone) : null;
      const until = day && day > today() ? day : null;
      const reason = row.exempt_reason || "Exemption restored";
      const key = `${reason}\u0000${until ?? ""}`;
      const g = groups.get(key) ?? { reason, until, ids: [] };
      g.ids.push(row.assignment_id);
      groups.set(key, g);
    }
    for (const g of groups.values()) await exemptWith(g.ids, g.reason, g.until, { undo: true });
  }

  async function extend(targets: AckRosterRow[]) {
    const ids = idsOf(targets);
    if (!ids.length) return;
    const asked = await extendDialog(ids.length);
    if (!asked) return;
    const { days, reason } = asked;
    pendingFocus.current = ids[0];
    const r = await post(
      `extend-${ids[0]}`,
      { action: "extend", assignment_ids: ids, days, reason },
      "Couldn't extend the due date."
    );
    if (!settled(r)) return;
    const by = `${days} ${days === 1 ? "day" : "days"}`;
    const text =
      r.changed.length === 1
        ? `Extended the deadline for ${whoOf(r.changed)} by ${by}${skippedNote(r.skipped.length)}`
        : `Extended ${r.changed.length} deadlines by ${by}${skippedNote(r.skipped.length)}`;
    toast("ok", text, { action: { label: "Undo", onClick: () => void undoExtend(r.changed) } });
  }

  async function undoExtend(ids: number[]) {
    pendingFocus.current = ids[0];
    const r = await post(`undo-extend-${ids[0]}`, { action: "undo_extend", assignment_ids: ids }, "Couldn't undo the extension.");
    if (!settled(r)) return;
    toast(
      "ok",
      r.changed.length === 1
        ? `Extension undone: the deadline for ${whoOf(r.changed)} is back to its previous date.`
        : `Extension undone: ${r.changed.length} deadlines are back to their previous dates.`
    );
  }

  /** Snooze: a week from the row and the bar (the date goes in the toast); Unsnooze's Undo passes the days that were left. */
  async function snooze(targets: AckRosterRow[], opts: { undo?: boolean; days?: number } = {}) {
    const ids = idsOf(targets);
    if (!ids.length) return;
    const days = opts.days ?? SNOOZE_DAYS_DEFAULT;
    pendingFocus.current = ids[0];
    const r = await post(`snooze-${ids[0]}`, { action: "snooze", assignment_ids: ids, days }, "Couldn't snooze reminders.");
    if (!settled(r)) return;
    const until = r.until ? formatDate(r.until, fmt) : `${days} days from now`;
    const text = `Snoozed reminders for ${whoOf(r.changed)} until ${until}${skippedNote(r.skipped.length)}`;
    if (opts.undo) {
      toast("ok", text);
      return;
    }
    toast("ok", text, { action: { label: "Undo", onClick: () => void unsnooze(r.changed, { undo: true }) } });
  }

  async function unsnooze(ids: number[], opts: { undo?: boolean } = {}) {
    const before = ids.map((id) => byAssignment.get(id)).filter((r): r is AckRosterRow => Boolean(r));
    pendingFocus.current = ids[0];
    const r = await post(`unsnooze-${ids[0]}`, { action: "unsnooze", assignment_ids: ids }, "Couldn't resume reminders.");
    if (!settled(r)) return;
    const who = whoOf(r.changed);
    if (opts.undo) {
      toast("ok", `Snooze undone: reminders resume for ${who}.`);
      return;
    }
    toast("ok", `Reminders resume for ${who}.${skippedNote(r.skipped.length)}`, {
      action: { label: "Undo", onClick: () => void resnooze(before.filter((row) => r.changed.includes(row.assignment_id!))) },
    });
  }

  /**
   * Unsnooze's Undo: snoozed again for the days each row had left (rounded
   * up, clamped to 1..SNOOZE_DAYS_MAX), one call per distinct count, so the
   * row ends where it was rather than a week out.
   */
  async function resnooze(before: AckRosterRow[]) {
    const groups = new Map<number, AckRosterRow[]>();
    for (const row of before) {
      if (!row.snoozed_until) continue;
      const left = Math.ceil((new Date(row.snoozed_until).getTime() - now.getTime()) / DAY);
      const days = Number.isFinite(left) ? Math.min(SNOOZE_DAYS_MAX, Math.max(1, left)) : SNOOZE_DAYS_DEFAULT;
      groups.set(days, [...(groups.get(days) ?? []), row]);
    }
    for (const [days, rows] of groups) await snooze(rows, { undo: true, days });
  }

  async function reask(targets: AckRosterRow[]) {
    const ids = idsOf(targets);
    if (!ids.length) return;
    const one = ids.length === 1 ? targets[0] : null;
    const reason = await reaskDialog({ one: one ? { name: nameOf(one), rev: one.rev } : null, count: ids.length, title });
    if (reason === null) return;
    pendingFocus.current = ids[0];
    const r = await post(
      `reask-${ids[0]}`,
      { action: "reask", assignment_ids: ids, reason },
      "Couldn't ask to re-confirm."
    );
    if (!r) {
      pendingFocus.current = null;
      return;
    }
    if (r.changed.length === 0) {
      toast("error", "Nobody was asked: the selected people are exempt or no longer asked to confirm this document.");
      return;
    }
    setSelected(new Set());
    const skipped = r.skipped.length;
    // No Undo: the notice is already on its way (the spec offers none).
    toast(
      "ok",
      `${whoOf(r.changed)} will be asked to re-confirm.` +
        (skipped > 0 ? ` ${people(skipped)} ${skipped === 1 ? "was" : "were"} skipped (exempt or no longer asked).` : "")
    );
  }

  // ── Selection and the bulk bar ────────────────────────────────────────────

  const pageIds = useMemo(
    () => (ledgerView ? [] : (slice as AckRosterRow[]).map((r) => r.assignment_id).filter((id): id is number => id != null)),
    [slice, ledgerView]
  );
  const allOnPage = pageIds.length > 0 && pageIds.every((id) => selected.has(id));
  const someOnPage = !allOnPage && pageIds.some((id) => selected.has(id));
  const toggleOne = (id: number) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const togglePage = () =>
    setSelected((s) => {
      const next = new Set(s);
      if (allOnPage) for (const id of pageIds) next.delete(id);
      else for (const id of pageIds) next.add(id);
      return next;
    });
  const headCheck = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (headCheck.current) headCheck.current.indeterminate = someOnPage;
  }, [someOnPage]);

  const targets = useMemo(
    () => [...selected].map((id) => byAssignment.get(id)).filter((r): r is AckRosterRow => Boolean(r)),
    [selected, byAssignment]
  );
  // Each bulk action goes to the rows it applies to, so a mixed selection
  // never sends a confirmed person an extension or an exempt one a snooze.
  const sub = useMemo(() => {
    const st = (r: AckRosterRow) => stateOf(r, grace, now);
    const open = targets.filter((r) => st(r) === "pending" || st(r) === "overdue");
    return {
      open,
      exemptable: targets.filter((r) => !r.exempt),
      exempt: targets.filter((r) => Boolean(r.exempt)),
      snoozable: open.filter((r) => !isSnoozed(r, now)),
      snoozed: targets.filter((r) => !r.exempt && isSnoozed(r, now)),
      confirmed: targets.filter((r) => st(r) === "confirmed"),
    };
  }, [targets, grace, now]);

  const nobody = rows.length === 0 && !ledgerView;
  const nothingRecorded = ledgerView && (ledger?.length ?? 0) === 0;
  const anySnoozed = !ledgerView && (slice as AckRosterRow[]).some((r) => !r.exempt && isSnoozed(r, now));
  const pager = paged && (
    <Pager page={current} limit={ROSTER_PAGE} total={visible.length} onPage={setPage} className="print:hidden" />
  );

  return (
    <div data-roster={docId}>
      {!nobody && (
        // The toolbar fits the tightest common phone (STYLEGUIDE §Segmented
        // controls): inside the portal's expand row at 375px the box is
        // about 213px wide, narrower than the five Show options on one
        // line, so both groups may wrap their options inside the pill
        // instead of pushing the toolbar sideways; where the options fit on
        // one line nothing changes. The table under it scrolls inside its
        // own wrapper, by design.
        <div className="mb-3 flex flex-wrap items-center gap-3 print:hidden">
          {hasLedger && (
            <Segmented label="View" size="sm" options={VIEW_OPTIONS} value={view} onChange={changeView} className="flex-wrap" />
          )}
          {!ledgerView && (
            <Segmented label="Show" size="sm" options={SHOW_OPTIONS} value={show} onChange={changeShow} className="flex-wrap" />
          )}
          <ListFilter
            value={filter}
            onChange={changeFilter}
            label="Filter people"
            noun="people"
            shown={visible.length}
            total={base.length}
            className="min-w-0 flex-1"
          />
        </div>
      )}
      {canAct && !ledgerView && selected.size > 0 && (
        // The bulk bar: one bar above the table while something is checked,
        // the same actions as the rows over the checked assignment ids.
        <div
          role="region"
          aria-label="Selected people"
          className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-compass-200 bg-compass-50/70 px-3 py-2 print:hidden"
        >
          <span className="text-sm font-semibold text-compass-800">{selected.size} selected</span>
          <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())} disabled={busy}>
            Clear selection
          </Button>
          <span className="mx-1 h-4 w-px bg-compass-200" aria-hidden />
          {sub.open.length > 0 && (
            <BulkButton icon={<CalendarPlus />} label="Extend due date…" count={sub.open.length} busy={busy} onClick={() => void extend(sub.open)} />
          )}
          {sub.exemptable.length > 0 && (
            <BulkButton icon={<UserMinus />} label="Exempt…" count={sub.exemptable.length} busy={busy} onClick={() => void exempt(sub.exemptable)} />
          )}
          {sub.exempt.length > 0 && (
            <BulkButton
              icon={<UserCheck />}
              label="Remove exemption"
              count={sub.exempt.length}
              busy={busy}
              onClick={() => void unexempt(idsOf(sub.exempt))}
            />
          )}
          {sub.snoozable.length > 0 && (
            <BulkButton icon={<BellOff />} label="Snooze" count={sub.snoozable.length} busy={busy} onClick={() => void snooze(sub.snoozable)} />
          )}
          {sub.snoozed.length > 0 && (
            <BulkButton icon={<BellRing />} label="Unsnooze" count={sub.snoozed.length} busy={busy} onClick={() => void unsnooze(idsOf(sub.snoozed))} />
          )}
          {sub.confirmed.length > 0 && (
            <BulkButton
              icon={<RotateCcw />}
              label="Ask to re-confirm…"
              count={sub.confirmed.length}
              busy={busy}
              onClick={() => void reask(sub.confirmed)}
            />
          )}
        </div>
      )}
      {pager && <div className="mb-3">{pager}</div>}

      {/* overflow-hidden keeps the rounded corners (frameless, it keeps the
          Table's scroll wrapper inside the row); that wrapper carries the
          sideways scroll on a phone (twelve columns, most of them nowrap,
          outgrow 375px). On paper the Table drops its minimum width and the
          wrapper its scroll, so the far columns are not clipped by this card
          on a portrait page. */}
      <div className={frame ? "overflow-hidden rounded-xl border border-slate-200 bg-surface shadow-xs" : "overflow-hidden bg-surface"}>
        {nobody ? (
          <SectionEmpty className="px-4 py-6">{NOBODY_ASKED}</SectionEmpty>
        ) : nothingRecorded ? (
          <SectionEmpty className="px-4 py-6">
            No confirmations recorded for this document yet. Every confirmation, including ones a later
            re-confirmation replaced, is listed here once people confirm.
          </SectionEmpty>
        ) : visible.length === 0 ? (
          <SectionEmpty className="px-4 py-6">{needle ? "No people match your filter." : EMPTY_BY_SHOW[show]}</SectionEmpty>
        ) : ledgerView ? (
          <LedgerTable rows={slice as AckLedgerViewRow[]} canSeeIp={canSeeIp} fmt={fmt} words={words} />
        ) : (
          <CurrentTable
            rows={slice as AckRosterRow[]}
            fmt={fmt}
            words={words}
            grace={grace}
            now={now}
            canAct={canAct}
            busy={busy}
            selected={selected}
            allOnPage={allOnPage}
            headCheck={headCheck}
            onToggle={toggleOne}
            onTogglePage={togglePage}
            registerRow={registerRow}
            actions={{ extend, exempt, unexempt, snooze, unsnooze, reask }}
            recordLinks={recordLinks}
          />
        )}
      </div>
      {pager && <div className="mt-3">{pager}</div>}
      {/* The snooze invariant, spelled out where a snoozed row is on the
          page: the tooltip inside the scrolling table may clip (§Tooltips). */}
      {anySnoozed && <p className="mt-3 text-xs text-slate-500">{SNOOZE_INVARIANT}</p>}
    </div>
  );
}

interface RowActions {
  extend: (targets: AckRosterRow[]) => Promise<void>;
  exempt: (targets: AckRosterRow[]) => Promise<void>;
  unexempt: (ids: number[]) => Promise<void>;
  snooze: (targets: AckRosterRow[]) => Promise<void>;
  unsnooze: (ids: number[]) => Promise<void>;
  reask: (targets: AckRosterRow[]) => Promise<void>;
}

function CurrentTable({
  rows,
  fmt,
  words,
  grace,
  now,
  canAct,
  busy,
  selected,
  allOnPage,
  headCheck,
  onToggle,
  onTogglePage,
  registerRow,
  actions,
  recordLinks,
}: {
  rows: AckRosterRow[];
  fmt: AppSettings;
  words: number;
  grace: number;
  now: Date;
  canAct: boolean;
  busy: boolean;
  selected: Set<number>;
  allOnPage: boolean;
  headCheck: React.RefObject<HTMLInputElement | null>;
  onToggle: (id: number) => void;
  onTogglePage: () => void;
  registerRow: (id: number) => (el: HTMLTableRowElement | null) => void;
  actions: RowActions;
  recordLinks?: boolean;
}) {
  const f = (iso: string) => formatDate(iso, fmt);
  const selectable = rows.some((r) => r.assignment_id != null);
  return (
    <Table scroll minWidth={canAct ? "86rem" : "76rem"}>
      <thead className={TABLE_HEAD_ROW}>
        <tr>
          {canAct && (
            <Th fit className="print:hidden">
              <input
                ref={headCheck}
                type="checkbox"
                aria-label="Select all people on this page"
                checked={allOnPage}
                disabled={busy || !selectable}
                onChange={onTogglePage}
                className="h-4 w-4 align-middle"
              />
            </Th>
          )}
          <Th>Person</Th>
          <Th>Role</Th>
          <Th fit>Status</Th>
          <Th fit>Due</Th>
          <Th fit>Confirmed</Th>
          <Th fit>Version</Th>
          <Th fit>Signed</Th>
          <Th fit>Read time</Th>
          <Th fit>Reached end (self-reported)</Th>
          <Th>Exemption</Th>
          {canAct && (
            <Th fit className="print:hidden">
              <span className="sr-only">Actions</span>
            </Th>
          )}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const state = stateOf(r, grace, now);
          const id = r.assignment_id ?? null;
          const snoozed = isSnoozed(r, now);
          const note = exemptionNote(r, fmt, now);
          return (
            <tr
              key={r.id}
              className={TR}
              ref={canAct && id != null ? registerRow(id) : undefined}
              tabIndex={canAct && id != null ? -1 : undefined}
              aria-selected={canAct && id != null ? selected.has(id) : undefined}
            >
              {canAct && (
                <Td fit className="print:hidden">
                  {id != null && (
                    <input
                      type="checkbox"
                      aria-label={`Select ${nameOf(r)}`}
                      checked={selected.has(id)}
                      disabled={busy}
                      onChange={() => onToggle(id)}
                      className="h-4 w-4 align-middle"
                    />
                  )}
                </Td>
              )}
              <Td>
                <PersonCell name={r.name} username={r.username} email={r.email} href={recordLinks ? `/compliance/person/${r.id}` : undefined} />
              </Td>
              <Td className="text-slate-500">{r.role ?? ""}</Td>
              <Td fit>
                <StatusCell row={r} state={state} fmt={fmt} />
              </Td>
              {/* The deadline is an instant (policy_assignments.due_at), so
                  the instant formatter in the workspace zone; blank without
                  one, and on an exempt row (no deadline applies). */}
              <Td fit className="text-slate-500">
                {r.due_at && !r.exempt ? f(r.due_at) : ""}
              </Td>
              <Td fit className="text-slate-500">
                {r.acknowledged_at ? formatDateTime(r.acknowledged_at, fmt) : "—"}
              </Td>
              <Td fit className="text-slate-500">
                <VersionCell row={r} />
              </Td>
              <Td fit className="text-slate-700">
                <SignedCell name={r.acknowledged_at ? r.signed_name : null} />
              </Td>
              <Td fit className="text-slate-500">
                <ReadTimeCell seconds={r.read_seconds} words={words} />
              </Td>
              <Td fit>
                <ReachedEndCell reached={r.reached_end} />
              </Td>
              <Td className="text-slate-500">{note}</Td>
              {canAct && (
                <Td fit className="print:hidden">
                  {id != null && (
                    <div className="flex items-center justify-end gap-0.5">
                      {state === "exempt" ? (
                        <IconAction icon={<UserCheck />} label="Remove exemption" disabled={busy} onClick={() => void actions.unexempt([id])} />
                      ) : (
                        <>
                          {state === "confirmed" ? (
                            <IconAction icon={<RotateCcw />} label="Ask to re-confirm…" disabled={busy} onClick={() => void actions.reask([r])} />
                          ) : (
                            <IconAction icon={<CalendarPlus />} label="Extend due date…" disabled={busy} onClick={() => void actions.extend([r])} />
                          )}
                          <IconAction icon={<UserMinus />} label="Exempt…" disabled={busy} onClick={() => void actions.exempt([r])} />
                          {state !== "confirmed" &&
                            (snoozed ? (
                              <IconAction icon={<BellRing />} label="Unsnooze" disabled={busy} onClick={() => void actions.unsnooze([id])} />
                            ) : (
                              <IconAction icon={<BellOff />} label="Snooze" disabled={busy} onClick={() => void actions.snooze([r])} />
                            ))}
                        </>
                      )}
                    </div>
                  )}
                </Td>
              )}
            </tr>
          );
        })}
      </tbody>
    </Table>
  );
}

function LedgerTable({
  rows,
  canSeeIp,
  fmt,
  words,
}: {
  rows: AckLedgerViewRow[];
  canSeeIp: boolean;
  fmt: AppSettings;
  words: number;
}) {
  return (
    <Table scroll minWidth={canSeeIp ? "56rem" : "48rem"}>
      <thead className={TABLE_HEAD_ROW}>
        <tr>
          <Th>Person</Th>
          <Th fit>Confirmed</Th>
          <Th fit>Version</Th>
          <Th fit>Signed</Th>
          <Th fit>Read time</Th>
          {canSeeIp && <Th fit>IP</Th>}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id} className={TR}>
            <Td>
              <PersonCell name={r.name} username={r.username} email={r.email} />
              {r.account_removed && (
                <span className={chipClass("neutral", "sm", "ml-2 align-middle")}>Account removed</span>
              )}
            </Td>
            <Td fit className="text-slate-500">
              {formatDateTime(r.acknowledged_at, fmt)}
            </Td>
            <Td fit className="text-slate-500">
              <VersionCell row={r} />
            </Td>
            <Td fit className="text-slate-700">
              <SignedCell name={r.signed_name} />
            </Td>
            <Td fit className="text-slate-500">
              <ReadTimeCell seconds={r.read_seconds} words={words} />
            </Td>
            {canSeeIp && (
              <Td fit className="text-slate-500">
                {r.ip}
              </Td>
            )}
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

/**
 * The record page's Export menu (STYLEGUIDE §Print: exports are files behind
 * an Export menu, "Print…" last). The two CSV rows start a download without
 * leaving the page (the routes answer with an attachment); the ledger row is
 * for compliance.export holders only, because it carries the IP and user
 * agent of every confirmation. The trigger carries aria-haspopup and
 * aria-expanded, and the whole control stays off paper.
 */
export function AckExportMenu({ docId, canExport }: { docId: number; canExport: boolean }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setOpen(false), []);
  const download = (href: string) => {
    setOpen(false);
    window.location.assign(href);
  };
  return (
    <div className="relative print:hidden">
      <button
        ref={trigger}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        data-tt="Download or print the record"
        className={buttonClass("secondary", "md")}
      >
        <Download className="h-4 w-4" aria-hidden /> Export <ChevronDown className="h-4 w-4" aria-hidden />
      </button>
      <Popover open={open} onClose={close} triggerRef={trigger} role="menu" label="Export" align="end" width="w-72">
        <MenuItem icon={<FileSpreadsheet />} onClick={() => download(`/api/documents/${docId}/acknowledgements?format=csv`)}>
          Export CSV
        </MenuItem>
        {canExport && (
          <MenuItem icon={<FileSpreadsheet />} onClick={() => download(`/api/documents/${docId}/acknowledgements?format=ledger`)}>
            Ledger CSV (all confirmations)
          </MenuItem>
        )}
        <MenuSeparator />
        <MenuItem
          icon={<Printer />}
          onClick={() => {
            setOpen(false);
            window.print();
          }}
        >
          Print…
        </MenuItem>
      </Popover>
    </div>
  );
}
