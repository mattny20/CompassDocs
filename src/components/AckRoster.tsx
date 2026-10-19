"use client";

// The Record tab's roster (C4, 1.12.0): the house Table with the house
// controls over it. "Show" narrows the current view to pending or confirmed
// people ("Overdue" and "Exempt" arrive with due dates and exemptions),
// "Filter people" narrows what is on the page with its live count, the
// Pager keeps a 400-person space readable, and "Current version / All
// confirmations" switches between the roster (one row per person, their
// confirmation that counts against the marker) and the ledger (every
// confirmation ever recorded for the document, superseded rows included).
// Controls stay off paper (STYLEGUIDE §Print): the record is printed as
// evidence, and the page prints the view and page on screen.
//
// Shared with the compliance portal's expand row in wave 2: the server page
// passes the rows it already read; the portal passes the JSON roster and
// may leave `ledger` out, which hides the view switch.

import { useCallback, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Download, FileSpreadsheet, PenLine, Printer } from "lucide-react";
import { chipClass } from "@/components/Chip";
import { Segmented } from "@/components/Segmented";
import { ListFilter } from "@/components/ListFilter";
import { Pager } from "@/components/Pager";
import { Popover, MenuItem, MenuSeparator } from "@/components/Popover";
import { SectionEmpty } from "@/components/form";
import { Table, Th, Td, TABLE_HEAD_ROW, TR } from "@/components/Table";
import { buttonClass } from "@/components/Button";
import { formatDateTime } from "@/lib/format";
import type { AppSettings } from "@/lib/settings";
import { isShortRead, readTimeLabel, SHORT_READ_TOOLTIP } from "@/lib/read-evidence";

/** One person of the current view: AckStatusRow's shape (the C2 fields are optional so the portal's JSON rows fit too). */
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

type Show = "all" | "pending" | "confirmed";
type View = "current" | "ledger";

/** Rows per page: a space of 400 people stays readable. */
export const ROSTER_PAGE = 50;

const SHOW_OPTIONS: { value: Show; label: string }[] = [
  { value: "all", label: "All" },
  { value: "pending", label: "Pending" },
  { value: "confirmed", label: "Confirmed" },
];

const VIEW_OPTIONS: { value: View; label: string }[] = [
  { value: "current", label: "Current version" },
  { value: "ledger", label: "All confirmations" },
];

/** The sentence the roster shows while nobody is asked yet (also the portal's expand row). */
export const NOBODY_ASKED = "No one is asked to confirm this document yet. Everyone who can see it is listed here once it is published.";

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

function PersonCell({ name, username, email }: { name: string; username: string; email?: string }) {
  return (
    <>
      <span className="font-medium text-slate-800">{name || username}</span>
      {email && <span className="ml-2 text-xs text-slate-500">{email}</span>}
    </>
  );
}

function matches(needle: string, ...values: (string | null | undefined)[]): boolean {
  if (!needle) return true;
  return values.some((v) => (v ?? "").toLowerCase().includes(needle));
}

export function AckRoster({
  docId,
  rows,
  ledger,
  canSeeIp,
  fmt,
  words = 0,
}: {
  docId: number;
  /** The current view: everyone asked, with their confirmation that counts (pending first). */
  rows: AckRosterRow[];
  /** Every confirmation ever recorded, newest first; absent hides the view switch (the portal's expand row). */
  ledger?: AckLedgerViewRow[];
  /** The viewer holds compliance.export: the ledger view gets its IP column. */
  canSeeIp: boolean;
  /** The viewer's date and time settings (settingsForUser). */
  fmt: AppSettings;
  /** The live document's word count, for the Read time threshold; 0 never flags a row. */
  words?: number;
}) {
  const [show, setShow] = useState<Show>("all");
  const [view, setView] = useState<View>("current");
  const [filter, setFilter] = useState("");
  const [page, setPage] = useState(0);
  const needle = filter.trim().toLowerCase();

  const hasLedger = Array.isArray(ledger);
  const ledgerView = hasLedger && view === "ledger";

  // What the Show control leaves, then what the filter leaves of that: the
  // count beside the filter reads "3 of 42 people" against the Show choice.
  const base = useMemo(() => {
    if (ledgerView) return ledger ?? [];
    if (show === "pending") return rows.filter((r) => !r.acknowledged_at);
    if (show === "confirmed") return rows.filter((r) => r.acknowledged_at);
    return rows;
  }, [ledgerView, ledger, rows, show]);
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

  const nobody = rows.length === 0 && !ledgerView;
  const nothingRecorded = ledgerView && (ledger?.length ?? 0) === 0;
  const pager = paged && (
    <Pager page={current} limit={ROSTER_PAGE} total={visible.length} onPage={setPage} className="print:hidden" />
  );

  return (
    <div data-roster={docId}>
      {!nobody && (
        <div className="mb-3 flex flex-wrap items-center gap-3 print:hidden">
          {hasLedger && <Segmented label="View" size="sm" options={VIEW_OPTIONS} value={view} onChange={changeView} />}
          {!ledgerView && <Segmented label="Show" size="sm" options={SHOW_OPTIONS} value={show} onChange={changeShow} />}
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
      {pager && <div className="mb-3">{pager}</div>}

      {/* overflow-hidden keeps the rounded corners; the Table's own scroll
          wrapper carries the sideways scroll on a phone (eight columns, six
          of them nowrap, outgrow 375px). On paper the Table drops its minimum
          width and the wrapper its scroll, so the far columns are not clipped
          by this card on a portrait page. */}
      <div className="overflow-hidden rounded-xl border border-slate-200 bg-surface shadow-xs">
        {nobody ? (
          <SectionEmpty className="px-4 py-6">{NOBODY_ASKED}</SectionEmpty>
        ) : nothingRecorded ? (
          <SectionEmpty className="px-4 py-6">
            No confirmations recorded for this document yet. Every confirmation, including ones a later
            re-confirmation replaced, is listed here once people confirm.
          </SectionEmpty>
        ) : visible.length === 0 ? (
          <SectionEmpty className="px-4 py-6">
            {needle ? `No people match "${filter.trim()}".` : show === "pending" ? "Nobody is pending: everyone asked has confirmed." : "Nobody has confirmed the current version yet."}
          </SectionEmpty>
        ) : ledgerView ? (
          <LedgerTable rows={slice as AckLedgerViewRow[]} canSeeIp={canSeeIp} fmt={fmt} words={words} />
        ) : (
          <CurrentTable rows={slice as AckRosterRow[]} fmt={fmt} words={words} />
        )}
      </div>
      {pager && <div className="mt-3">{pager}</div>}
    </div>
  );
}

function CurrentTable({ rows, fmt, words }: { rows: AckRosterRow[]; fmt: AppSettings; words: number }) {
  return (
    <Table scroll minWidth="60rem">
      <thead className={TABLE_HEAD_ROW}>
        <tr>
          <Th>Person</Th>
          <Th>Role</Th>
          <Th fit>Status</Th>
          <Th fit>Confirmed</Th>
          <Th fit>Version</Th>
          <Th fit>Signed</Th>
          <Th fit>Read time</Th>
          <Th fit>Reached end (self-reported)</Th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id} className={TR}>
            <Td>
              <PersonCell name={r.name} username={r.username} email={r.email} />
            </Td>
            <Td className="text-slate-500">{r.role ?? ""}</Td>
            <Td fit>
              {r.acknowledged_at ? (
                <span className={chipClass("ok")}>Confirmed</span>
              ) : (
                <span className={chipClass("warn")}>Pending</span>
              )}
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
          </tr>
        ))}
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
