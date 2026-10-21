"use client";

// Compliance › Policies (B4, 1.12.0): asking for a read confirmation of any
// published document, and every policy's progress with its row actions,
// the roster expand and the paused group. Moved from the one-page portal
// with every action, dialog, toast and string as it was; the matrix's
// Export CSV, a page-header action until the header became the section's,
// sits on the Policy progress card it exports. 1.12.0 adds the collapsed
// Retired group under Paused (G3: frozen counts, the reason, the
// replacement, the record and the CSV, Un-retire), "Retire policy…" on the
// live rows, the "Next re-confirmation {date}" meta text (G1) and the
// Record tab's AckRoster inside the expand row (C4). 1.13.0 gives each live
// row an icon button to the policy's Settings tab (D1), a second meta line,
// "+6 enrolled this week" (D1), the deadline rule with the overdue count
// (E1) and the reminder cadence in place of the bare "last reminded" (E2).
// 1.14.0 (F1, D3, F2): each live row's bar is stacked (confirmed, pending,
// overdue, exempt hatched) with its legend; the subtitle names the owner
// and the edits kept since the last ask; a Sort select, an "In set" select
// and the list filter sit above the rows; a set chip names the sets the
// policy belongs to; and the card's export is one Export menu (the matrix,
// the ledger, the audit package, Print…) for compliance.export holders.

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
  ShieldOff,
  FileCheck,
  Download,
  Send,
  BellRing,
  ChevronDown,
  ChevronRight,
  CirclePause,
  Archive,
  ArchiveRestore,
  ClipboardCheck,
  Settings2,
  X,
  Layers,
  FileSpreadsheet,
  FileArchive,
  Printer,
} from "lucide-react";
import { LoadingRow } from "@/components/Spinner";
import { chipClass } from "@/components/Chip";
import { Button, buttonClass, iconButtonClass } from "@/components/Button";
import { Card } from "@/components/Card";
import { EntityPicker } from "@/components/EntityPicker";
import { Select, SectionEmpty } from "@/components/form";
import { ListFilter } from "@/components/ListFilter";
import { Popover, MenuItem, MenuSeparator } from "@/components/Popover";
import { AckRoster } from "@/components/AckRoster";
import { ReconfirmButton } from "@/components/ReconfirmButton";
import {
  EDIT_DEFAULT_CHIP,
  EDIT_DEFAULT_OPTIONS,
  POLICY_SORTS,
  barCounts,
  barLabel,
  barLegend,
  keptLine,
  people,
  type PolicySort,
} from "@/components/compliance/copy";
import type { EditDefault } from "@/lib/compliance-settings";
import { recertPortalLine } from "@/lib/ack-recert";
import { portalDueLine } from "@/lib/ack-due";
import { reminderSubtitle } from "@/lib/ack-remind";
import { RESET_MIN_PCT } from "@/lib/diff";
import { timeAgo } from "@/lib/ui";
import { useFormatDate } from "@/components/SettingsProvider";
import { useBulkSelection, usePortal, type DecisionBrief, type DocRow, type Portal, type PortalPageProps } from "./use-portal";
import { PortalFallback } from "./PortalFallback";
import { PolicyBulkBar } from "./PortalBulk";

/** The row behind the marker: the newest reset, or the newest decision when it is one. */
function lastAsk(d: DocRow): DecisionBrief | null {
  if (d.last_reset) return d.last_reset;
  return d.last_decision?.outcome === "reset" ? d.last_decision : null;
}

/** "Last asked Mar 3, 2026 by Matt: Section 4 now covers contractors". */
function askedLine(x: DecisionBrief, date: (iso: string) => string): string {
  let line = `Last asked ${date(x.decided_at)}`;
  if (x.decided_by_name) line += ` by ${x.decided_by_name}`;
  if (x.reason) line += `: ${x.reason}`;
  return line;
}

/**
 * The row's first meta line: when the text changed, who joined the audience
 * this week (D1), the deadline rule with the overdue count (E1) and the
 * policy's owner (F1, 1.14.0): "Updated 3 Oct 2026 · +6 enrolled this week
 * · Due 29 Oct 2026 · 12 overdue · owner Priya Shah". The rule's fixed date
 * is a calendar day (the day formatter); a row from a server without a rule
 * says nothing about a deadline, and one without an owner nothing about one.
 */
function audienceLine(d: DocRow, fmt: { date: (iso: string) => string; day: (ymd: string) => string }): string {
  const parts = [`Updated ${fmt.date(d.updated_at)}`];
  if ((d.enrolled_week ?? 0) > 0) parts.push(`+${d.enrolled_week} enrolled this week`);
  if (d.due_rule) parts.push(portalDueLine(d.due_rule, { due_days: d.due_rule.resolved_days }, d.overdue ?? 0, fmt.day));
  if (d.owner_name) parts.push(`owner ${d.owner_name}`);
  return parts.join(" · ");
}

/**
 * The row's second meta line: the reminders and the cycle. "last reminded 2
 * days ago · next automatic reminder 29 Oct 2026" from the sweep's summary
 * (E2: the manual Remind and the automatic cadence stamp the same rows, so
 * one sentence covers both), "never reminded" when nobody has been, and the
 * stored next cycle date (G1) after it. A row from a server without the
 * summary keeps the 1.12.0 wording from the policy's own reminder stamp.
 */
function reminderLine(d: DocRow, fmt: { date: (iso: string) => string; day: (ymd: string) => string }): string {
  const summary = d.reminder ? reminderSubtitle(d.reminder, fmt.date) : null;
  const reminded = summary
    ? d.reminder!.last_reminded_at
      ? summary
      : `never reminded · ${summary}`
    : d.ack_last_reminded_at
      ? `last reminded ${timeAgo(d.ack_last_reminded_at)}`
      : "never reminded";
  const recert = recertPortalLine(d, fmt.day);
  const parts = [reminded];
  if (recert) parts.push(recert);
  // The edits kept since everyone was last asked (C1; F1 puts the count on
  // the subtitle, beside the reminder it may call for).
  if ((d.kept_since_reset ?? 0) > 0) parts.push(keptLine(d.kept_since_reset!, d.ack_rev));
  return parts.join(" · ");
}

/**
 * The drift chip: how far the live text now differs from the version people
 * confirmed, through the edits the subtitle counts ("7.8% drift since v12").
 * Warn once it reaches the re-ask threshold, which is when the Overview's
 * queue lists the policy; neutral below it; nothing while nothing drifted.
 */
function driftChip(d: DocRow): { text: string; tone: "warn" | "neutral" } | null {
  const drift = Number(d.drift_pct ?? 0);
  if (!(drift > 0)) return null;
  const since = d.ack_rev ? `v${d.ack_rev}` : "the last ask";
  return { text: `${drift.toFixed(1)}% drift since ${since}`, tone: drift >= RESET_MIN_PCT ? "warn" : "neutral" };
}

const DAY = 86_400_000;

/**
 * "Due soonest": a fixed date before any relative rule, a relative rule by
 * the days it resolves to, no rule last. A fixed date that has passed still
 * sorts first (it is the soonest a reader can be asked by).
 */
function dueKey(d: DocRow): number {
  const rule = d.due_rule;
  if (!rule) return Number.POSITIVE_INFINITY;
  if (rule.due_at) {
    const t = Date.parse(rule.due_at);
    if (!Number.isNaN(t)) return t;
  }
  return Date.now() + rule.resolved_days * DAY + 1e13;
}

/** The share confirmed (1 when nobody is asked, so an empty policy never reads as the least compliant). */
function pctOf(d: DocRow): number {
  return d.required ? d.acked / d.required : 1;
}

/** The Sort select's orders, each settling ties by title. */
function sortPolicies(rows: DocRow[], sort: PolicySort): DocRow[] {
  const byTitle = (a: DocRow, b: DocRow) => a.title.localeCompare(b.title);
  const out = [...rows];
  if (sort === "title") return out.sort(byTitle);
  if (sort === "overdue") return out.sort((a, b) => (b.overdue ?? 0) - (a.overdue ?? 0) || pctOf(a) - pctOf(b) || byTitle(a, b));
  if (sort === "compliance") return out.sort((a, b) => pctOf(a) - pctOf(b) || (b.overdue ?? 0) - (a.overdue ?? 0) || byTitle(a, b));
  return out.sort((a, b) => dueKey(a) - dueKey(b) || byTitle(a, b));
}

function matches(needle: string, ...values: (string | null | undefined)[]): boolean {
  if (!needle) return true;
  return values.some((v) => (v ?? "").toLowerCase().includes(needle));
}

/** The per-policy edit-default chip's tooltip (A5): the full option sentence behind EDIT_DEFAULT_CHIP's short state. */
function editDefaultTip(value: EditDefault): string {
  const label = EDIT_DEFAULT_OPTIONS.find((o) => o.value === value)?.label ?? "";
  // "When the text changes: ask the editor each time." (the Select's own words)
  const sentence = label.replace(/\s*\(recommended\)$/, "");
  return `When the text changes: ${sentence.charAt(0).toLowerCase()}${sentence.slice(1)}.`;
}

export function PortalPolicies({ licensed, canManageLicense = false }: PortalPageProps) {
  const fmt = useFormatDate();
  const portal = usePortal(licensed);

  // The list's order and what is on it (F1, D3): the Sort select, the "In
  // set" select (shown once any live policy belongs to a set) and the list
  // filter over the live rows. The filter's count reads against the set
  // choice, as the roster's reads against its Show choice. Paused and
  // retired policies keep their own groups below, untouched by either.
  const [sort, setSort] = useState<PolicySort>("overdue");
  const [inSet, setInSet] = useState("");
  const [filter, setFilter] = useState("");
  const sortId = useId();
  const setId = useId();
  const needle = filter.trim().toLowerCase();
  const liveRows = useMemo(
    () => (portal.data?.docs ?? []).filter((d) => d.status === "published" && d.ack_retired_at === null),
    [portal.data]
  );
  const setNames = useMemo(() => {
    const names = new Set<string>();
    for (const d of liveRows) for (const n of d.set_names ?? []) names.add(n);
    return [...names].sort((a, b) => a.localeCompare(b));
  }, [liveRows]);
  const inSetRows = useMemo(
    () => (inSet ? liveRows.filter((d) => (d.set_names ?? []).includes(inSet)) : liveRows),
    [liveRows, inSet]
  );
  const shownRows = useMemo(
    () =>
      sortPolicies(
        needle ? inSetRows.filter((d) => matches(needle, d.title, d.space_name, d.owner_name, ...(d.set_names ?? []))) : inSetRows,
        sort
      ),
    [inSetRows, needle, sort]
  );

  // The bulk selection (F5, 1.14.0): a checkbox per live row, the header's
  // "Select all shown" over what the filter and the sort leave, shift-click
  // ranges in that order, and the bar while anything is checked. The
  // selection names live rows only, is pruned on reload and cleared after
  // an action (the bar does both).
  const shownIds = useMemo(() => shownRows.map((d) => d.id), [shownRows]);
  const liveIds = useMemo(() => liveRows.map((d) => d.id), [liveRows]);
  const selection = useBulkSelection(liveIds);
  const headCheck = useRef<HTMLInputElement>(null);
  const allShown = selection.allOf(shownIds);
  const someShown = !allShown && selection.someOf(shownIds);
  useEffect(() => {
    if (headCheck.current) headCheck.current.indeterminate = someShown;
  }, [someShown]);
  const { selected: selectedIds } = selection;
  const selectedRows = useMemo(() => liveRows.filter((d) => selectedIds.has(d.id)), [liveRows, selectedIds]);

  // Focus after Retire policy… / Un-retire (STYLEGUIDE §Settings pages:
  // focus never falls to <body>). The dialog hands focus back to the button
  // that opened it, and that button unmounts when the reload moves the row
  // between the live list and the Retired group. The target is noted before
  // the question (a cancelled or refused action clears it, so focus stays
  // where the dialog returned it) and taken once the new payload has
  // rendered: the moved row's "View record" on a retired policy, with its
  // group opened so the control is reachable, or the row's disclosure
  // button on a resumed one. One ref per row, keyed by document id.
  const rowFocus = useRef(new Map<number, HTMLElement>());
  const pendingFocus = useRef<number | null>(null);
  const registerFocus = useCallback(
    (id: number) => (el: HTMLElement | null) => {
      if (el) rowFocus.current.set(id, el);
      else rowFocus.current.delete(id);
    },
    []
  );
  const { data: payload, loadError } = portal;
  useEffect(() => {
    const id = pendingFocus.current;
    pendingFocus.current = null;
    if (id == null) return;
    const el = rowFocus.current.get(id);
    if (!el) return;
    const group = el.closest("details");
    if (group && !group.open) group.open = true;
    el.focus();
  }, [payload, loadError]);
  const focusAfter = (id: number, action: () => Promise<number | null>) => {
    pendingFocus.current = id;
    void action().then((moved) => {
      if (moved == null) pendingFocus.current = null;
    });
  };

  // The escalation notice's link (E2, 1.13.0): /compliance/policies?policy={id}
  // opens that policy's roster and brings the row into view once the
  // payload has loaded, with focus on its disclosure button, so the owner
  // lands on the overdue people rather than on a folded list. Once per id:
  // a row folded afterwards stays folded. A paused or retired policy has no
  // roster here and is left alone.
  const searchParams = useSearchParams();
  const wanted = Number(searchParams.get("policy")) || null;
  const wantedOpened = useRef<number | null>(null);
  const { openRoster } = portal;
  useEffect(() => {
    if (wanted == null || !payload || wantedOpened.current === wanted) return;
    if (!payload.docs.some((d) => d.id === wanted && d.status === "published" && d.ack_retired_at === null)) return;
    wantedOpened.current = wanted;
    void openRoster(wanted);
    const el = rowFocus.current.get(wanted);
    el?.scrollIntoView({ block: "start" });
    el?.focus({ preventScroll: true });
  }, [wanted, payload, openRoster]);

  if (!portal.data) return <PortalFallback licensed={licensed} canManageLicense={canManageLicense} portal={portal} />;
  const { data, isBusy, busy, open, rosters, candidate, setCandidate, previewing } = portal;
  const { can } = data;
  // A paused policy (unpublished, requirement still on) is listed apart from
  // the live ones, with no actions: every row action needs a published
  // document, and the server's tiles already leave it out (G2). A retired
  // policy (G3) is its own group whatever its status: the requirement is
  // off, the record is frozen, and the tiles leave it out too.
  const retired = data.docs.filter((d) => d.ack_retired_at !== null);
  const active = liveRows;
  const paused = data.docs.filter((d) => d.status !== "published" && d.ack_retired_at === null);

  return (
    <div className="space-y-5">
      {/* Request read confirmation (managers only) */}
      {can.manage && (
        <Card
          title="Request read confirmation"
          icon={<Send />}
          className="print:hidden"
          description="Pick a published document. Everyone who can see it is asked to read and confirm it, with a dashboard notice and an email. You see how many people that is before anything is sent, and you can require it quietly instead."
          padding="p-4"
        >
          <div className="flex flex-wrap items-center gap-2">
            <div className="min-w-72 flex-1 sm:max-w-md">
              {candidate != null ? (
                <span className="inline-flex items-center gap-1.5 rounded-lg border border-compass-200 bg-compass-50 px-3 py-1.5 text-sm font-medium text-compass-800">
                  {data.candidates.find((c) => c.id === candidate)?.title ?? `#${candidate}`}
                  <button
                    type="button"
                    onClick={() => setCandidate(null)}
                    data-tt="Clear document choice"
                    aria-label="Clear document choice"
                    className="opacity-60 hover:opacity-100"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </span>
              ) : (
                <EntityPicker
                  options={data.candidates.map((c) => ({
                    id: c.id,
                    label: c.title,
                    sublabel: `${c.space_icon} ${c.space_name}`,
                  }))}
                  onPick={(id) => setCandidate(id)}
                  label="Document"
                  placeholder="Find a published document…"
                  emptyText="No published documents match."
                  maxVisible={10}
                />
              )}
            </div>
            <Button
              onClick={() => void portal.requestConfirmation()}
              disabled={candidate == null || busy}
              busy={previewing || (candidate != null && isBusy(`request-${candidate}`))}
              icon={<Send />}
            >
              Request read confirmation
            </Button>
          </div>
        </Card>
      )}

      {/* Per-policy progress */}
      <Card
        title="Policy progress"
        icon={<FileCheck />}
        padding="none"
        actions={
          // Exports are files behind one Export menu, Print… last
          // (STYLEGUIDE §Print); the whole control stays off the paper, as
          // the Request card and the row controls do. compliance.export
          // holders only: every download is an audit row.
          can.export ? <PortalExportMenu /> : undefined
        }
      >
        {active.length === 0 ? (
          <SectionEmpty className="px-4 py-8 text-center">
            {paused.length > 0
              ? "No published document requires read confirmation right now. The paused policies below resume when they are published again."
              : can.manage
                ? "No documents require read confirmation yet. Request one above."
                : "No documents require read confirmation yet."}
          </SectionEmpty>
        ) : (
          <>
            {/* The order and the filter (F1, D3): a Select for each choice
                (its visible caption is its name), then the list filter with
                its live count. Off the paper, like every control here. */}
            <div className="flex flex-wrap items-center gap-3 border-b border-slate-100 px-4 py-3 print:hidden">
              {can.manage && (
                // "Select all shown": the rows the filter and the sort leave
                // (STYLEGUIDE §Tables' bulk bar; the list has no table head,
                // so the header checkbox leads the toolbar).
                <input
                  ref={headCheck}
                  type="checkbox"
                  aria-label="Select all shown"
                  checked={allShown}
                  disabled={busy || shownIds.length === 0}
                  onChange={() => selection.toggleAll(shownIds)}
                  className="h-4 w-4 align-middle"
                />
              )}
              <span className="flex items-center gap-1.5 text-xs text-slate-500">
                <span id={sortId}>Sort</span>
                <Select dense className="w-auto" aria-labelledby={sortId} value={sort} onChange={(e) => setSort(e.target.value as PolicySort)}>
                  {POLICY_SORTS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </Select>
              </span>
              {setNames.length > 0 && (
                <span className="flex items-center gap-1.5 text-xs text-slate-500">
                  <span id={setId}>In set</span>
                  <Select dense className="w-auto" aria-labelledby={setId} value={inSet} onChange={(e) => setInSet(e.target.value)}>
                    <option value="">Any set</option>
                    {setNames.map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </Select>
                </span>
              )}
              <ListFilter
                value={filter}
                onChange={setFilter}
                label="Filter policies"
                noun="policies"
                shown={shownRows.length}
                total={inSetRows.length}
                className="min-w-0 flex-1"
              />
            </div>
            {can.manage && selection.size > 0 && (
              // The bulk bar (F5): the actions over the checked policies;
              // a successful action clears the selection, forgets the
              // cached rosters of the policies it touched, reloads, then
              // focuses Select all shown (the control the bar grew from).
              // Off the paper with its band.
              <div className="border-b border-slate-100 px-4 py-3 print:hidden">
                <PolicyBulkBar
                  selected={selectedRows}
                  users={data.users}
                  canExport={can.export}
                  onClear={selection.clear}
                  onDone={async () => {
                    for (const d of selectedRows) portal.dropRoster(d.id);
                    await portal.load();
                  }}
                  focusAfter={() => headCheck.current?.focus()}
                />
              </div>
            )}
            {shownRows.length === 0 ? (
              <SectionEmpty className="px-4 py-6">
                {needle ? "No policies match your filter." : `No policies in the set "${inSet}" right now.`}
              </SectionEmpty>
            ) : (
          <ul className="divide-y divide-slate-100">
            {shownRows.map((d) => {
              const pct = d.required ? Math.round((d.acked / d.required) * 100) : 100;
              const complete = d.acked >= d.required;
              const roster = rosters[d.id];
              const bar = barCounts(d);
              const drift = driftChip(d);
              const editDefault = d.ack_edit_default ?? d.edit_default;
              return (
                <li key={d.id}>
                  <div className="flex flex-wrap items-center gap-3 px-4 py-3">
                    {can.manage && (
                      // The row's checkbox (F5): the click notes Shift
                      // before the change toggles, so a shift-click selects
                      // the range from the last row clicked, in the list's
                      // current order.
                      <input
                        type="checkbox"
                        aria-label={`Select ${d.title}`}
                        checked={selection.has(d.id)}
                        disabled={busy}
                        onClick={selection.markShift}
                        onChange={() => selection.toggle(d.id, shownIds)}
                        className="h-4 w-4 shrink-0 print:hidden"
                      />
                    )}
                    <div className="min-w-0 flex-1">
                      <button
                        ref={registerFocus(d.id)}
                        type="button"
                        onClick={() => void portal.toggleRoster(d.id)}
                        aria-expanded={open === d.id}
                        className="flex w-full min-w-0 items-center gap-2 text-left"
                      >
                        {open === d.id ? (
                          <ChevronDown className="h-4 w-4 shrink-0 text-slate-400" />
                        ) : (
                          <ChevronRight className="h-4 w-4 shrink-0 text-slate-400" />
                        )}
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-medium text-slate-800">
                            {d.space_icon} {d.title}
                          </span>
                          {/* Two meta lines (1.13.0): the audience and the
                              deadline, then the reminders and the cycle. */}
                          <span className="block text-xs text-slate-500">{audienceLine(d, fmt)}</span>
                          <span className="block text-xs text-slate-500">{reminderLine(d, fmt)}</span>
                          {lastAsk(d) && (
                            <span className="block text-xs text-slate-500">
                              {askedLine(lastAsk(d)!, fmt.date)}
                            </span>
                          )}
                        </span>
                      </button>
                      {/* The chips sit beside the disclosure button, not
                          inside it: a tooltip must be reachable by keyboard
                          (STYLEGUIDE §Accessibility), and a focusable element
                          inside a <button> is not valid HTML. pl-6 lines them
                          up under the title (chevron 16px + gap 8px). The
                          edit-default chip (A5) says how the policy treats a
                          text edit; the drift chip appears once kept edits
                          moved the text; a set chip (D3) names each set the
                          policy belongs to (an attribute, so neutral, with
                          the icon and a hidden "In set" for readers). */}
                      {(editDefault || drift || (d.set_names?.length ?? 0) > 0) && (
                        <span className="mt-1 flex flex-wrap items-center gap-1.5 pl-6">
                          {editDefault && (
                            <span
                              className={chipClass("neutral", "sm")}
                              tabIndex={0}
                              data-tt={editDefaultTip(editDefault)}
                              data-tt-wrap=""
                            >
                              {EDIT_DEFAULT_CHIP[editDefault]}
                            </span>
                          )}
                          {drift && (
                            <span
                              className={chipClass(drift.tone, "sm")}
                              tabIndex={0}
                              data-tt="How far the text now differs from the version people confirmed, through edits the editor said did not need everyone to re-confirm"
                              data-tt-wrap=""
                            >
                              {drift.text}
                            </span>
                          )}
                          {(d.set_names ?? []).map((name) => (
                            <span key={name} className={chipClass("neutral", "sm")}>
                              <Layers className="h-3 w-3" aria-hidden />
                              <span className="sr-only">In set </span>
                              {name}
                            </span>
                          ))}
                        </span>
                      )}
                    </div>
                    <div className="w-full sm:w-64">
                      <div className="mb-0.5 flex justify-between text-xs">
                        <span className={complete ? "font-medium ink-ok" : "text-slate-500"}>
                          {d.acked}/{d.required}
                        </span>
                        <span className="text-slate-500">{pct}%</span>
                      </div>
                      {/* The stacked bar (F1): confirmed, pending, overdue
                          and, beside the denominator, exempt as a hatch over
                          the slate token, so it survives dark mode and print
                          (a hue would not; the stripes are in rem so they
                          scale with the interface, STYLEGUIDE §Scaling).
                          Each segment's share is of all four numbers; the
                          legend under it carries the numbers for anyone who
                          cannot read the colours, and for paper. */}
                      <div
                        role="img"
                        aria-label={barLabel(d)}
                        className="flex h-1.5 overflow-hidden rounded-full bg-slate-100"
                      >
                        {bar.total > 0 && (
                          <>
                            <span className="h-full bg-compass-600" style={{ width: `${(bar.confirmed / bar.total) * 100}%` }} />
                            <span className="h-full bg-slate-200" style={{ width: `${((bar.pending - bar.overdue) / bar.total) * 100}%` }} />
                            <span className="h-full bg-red-500" style={{ width: `${(bar.overdue / bar.total) * 100}%` }} />
                            <span
                              className="h-full"
                              style={{
                                width: `${(bar.exempt / bar.total) * 100}%`,
                                backgroundImage:
                                  "repeating-linear-gradient(45deg, rgb(var(--slate-300)) 0 0.25rem, transparent 0.25rem 0.5rem)",
                              }}
                            />
                          </>
                        )}
                      </div>
                      <span className="mt-0.5 block text-2xs text-slate-500">{barLegend(d)}</span>
                    </div>
                    {(can.manage || can.export) && (
                      // Five controls do not fit beside the title on a
                      // phone: under sm the group takes the row's width
                      // and wraps; from sm it keeps the one-line layout.
                      <div className="flex w-full flex-wrap items-center gap-1.5 print:hidden sm:w-auto sm:shrink-0">
                        {can.manage && !complete && (
                          <Button
                            variant="secondary"
                            size="sm"
                            icon={<BellRing />}
                            onClick={() => void portal.remind(d)}
                            disabled={busy}
                            busy={isBusy(`remind-${d.id}`)}
                            data-tt="Notify everyone who hasn't confirmed yet"
                          >
                            Remind
                          </Button>
                        )}
                        {can.manage && (
                          // The deliberate re-ask (A7): disabled with its
                          // tooltip until someone has confirmed the
                          // current version; Remind is the live control
                          // before that. The roster cache is dropped so
                          // the next expand shows everyone Pending.
                          <ReconfirmButton
                            docId={d.id}
                            title={d.title}
                            summary={{ current: d.acked, eligible: d.required, rev: d.ack_rev ?? null }}
                            onDone={() => {
                              portal.dropRoster(d.id);
                              void portal.load();
                            }}
                          />
                        )}
                        {can.manage && (
                          <Button
                            variant="secondary"
                            size="sm"
                            icon={<ShieldOff />}
                            onClick={() => void portal.stopRequiring(d)}
                            disabled={busy}
                            busy={isBusy(`stop-${d.id}`)}
                            data-tt="Stop asking people to confirm this policy; the record is kept"
                            data-tt-wrap=""
                          >
                            Stop requiring
                          </Button>
                        )}
                        {can.manage && (
                          // Retire (G3): the end of the policy's life, with
                          // a reason. The question is the hook's; the row
                          // moves to the Retired group below on reload.
                          <Button
                            variant="secondary"
                            size="sm"
                            icon={<Archive />}
                            onClick={() => focusAfter(d.id, () => portal.retire(d))}
                            disabled={busy}
                            busy={isBusy(`retire-${d.id}`)}
                            data-tt="End this policy with a reason; every confirmation stays on record under Retired"
                            data-tt-wrap=""
                          >
                            Retire policy…
                          </Button>
                        )}
                        {can.manage && (
                          // The policy's Settings tab (D1, 1.13.0): who must
                          // confirm, the deadline, the reminders and the
                          // rest live on the record's page, not here; the
                          // guard there is ack_require on the space or
                          // program_manage, which `manage` is.
                          <Link
                            href={`/doc/${d.id}/acknowledgements/settings`}
                            data-tt="Read confirmation settings"
                            aria-label="Read confirmation settings"
                            className={iconButtonClass("bordered", "sm")}
                          >
                            <Settings2 />
                          </Link>
                        )}
                        {can.export && (
                          <a
                            href={`/api/documents/${d.id}/acknowledgements?format=csv`}
                            data-tt="Download this policy's compliance record"
                            aria-label="Download this policy's compliance record"
                            className={iconButtonClass("bordered", "sm")}
                          >
                            <Download />
                          </a>
                        )}
                      </div>
                    )}
                  </div>
                  {open === d.id && (
                    <div className="border-t border-slate-100 bg-slate-50/60">
                      {!roster ? (
                        <LoadingRow className="py-3" />
                      ) : roster.rows.length === 0 ? (
                        <SectionEmpty className="px-4 py-4">
                          No one is expected to confirm this policy yet.
                        </SectionEmpty>
                      ) : (
                        // The Record tab's roster (C4): the Show and people
                        // filters, the pager and the evidence columns, on
                        // the JSON rows the route already answers. No
                        // ledger here (the view switch stays hidden) and no
                        // word count (no read-time threshold without the
                        // text); the IP column follows compliance.export.
                        // Frameless: the strip's tint frames the table, not
                        // a second card inside the row. 1.13.0: the row and
                        // bulk actions post to the portal's assignments
                        // route (program_manage holders act; everyone else
                        // reads), the Overdue chip reads the policy's
                        // resolved grace, and every action reloads this
                        // roster and the counts above it.
                        <div className="px-4 py-3">
                          <AckRoster
                            docId={d.id}
                            title={d.title}
                            rows={roster.rows}
                            canSeeIp={can.export}
                            fmt={fmt.settings}
                            frame={false}
                            endpoint="/api/admin/compliance/assignments"
                            can={{ act: can.manage }}
                            grace={roster.grace}
                            onChanged={() => void portal.reloadRoster(d.id)}
                            recordHref={(userId) => `/compliance/person/${userId}`}
                          />
                        </div>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
            )}
          </>
        )}
        {paused.length > 0 && <PausedPolicies rows={paused} date={fmt.date} />}
        {retired.length > 0 && (
          <RetiredPolicies
            rows={retired}
            date={fmt.date}
            portal={portal}
            register={registerFocus}
            onUnretire={(d) => focusAfter(d.id, () => portal.unretire(d))}
          />
        )}
      </Card>
    </div>
  );
}

/**
 * The Policy progress card's Export menu (F2, 1.14.0; STYLEGUIDE §Print:
 * exports are files behind an Export menu, "Print…" last), the twin of the
 * record page's AckExportMenu for the whole programme: the matrix CSV (one
 * row per policy and person), the ledger CSV (every confirmation ever
 * recorded, with IP and user agent) and the audit package (the ZIP with its
 * hash manifest), each a download that never leaves the page (the routes
 * answer with an attachment), then Print…. The trigger carries aria-haspopup
 * and aria-expanded, and the whole control stays off paper.
 */
function PortalExportMenu() {
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
        data-tt="Download or print the programme's records"
        className={buttonClass("secondary", "sm")}
      >
        <Download className="h-4 w-4" aria-hidden /> Export <ChevronDown className="h-4 w-4" aria-hidden />
      </button>
      <Popover open={open} onClose={close} triggerRef={trigger} role="menu" label="Export" align="end" width="w-64">
        <MenuItem icon={<FileSpreadsheet />} onClick={() => download("/api/admin/compliance?format=csv")}>
          Matrix CSV
        </MenuItem>
        <MenuItem icon={<FileSpreadsheet />} onClick={() => download("/api/admin/compliance?format=ledger")}>
          Ledger CSV
        </MenuItem>
        <MenuItem icon={<FileArchive />} onClick={() => download("/api/admin/compliance/audit-package")}>
          Audit package (ZIP)
        </MenuItem>
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

/**
 * Policies that are unpublished with the requirement still on (G2, 1.11.0).
 * Nothing is reset and nobody is asked while a document is down, so each
 * row shows its standing and an "Unpublished" chip and offers no action:
 * Remind, the re-ask, Stop requiring and the record download all need a
 * published document, and the tiles above leave the group out. Collapsed
 * by default, the way the record page folds former staff away.
 */
function PausedPolicies({ rows, date }: { rows: DocRow[]; date: (iso: string) => string }) {
  return (
    <details className="border-t border-slate-100 [&[open]>summary]:border-b [&[open]>summary]:border-slate-100">
      <summary className="cursor-pointer select-none px-4 py-3 text-sm font-semibold text-slate-700 hover:text-compass-700 marker:text-compass-500">
        Paused (unpublished) · {rows.length}
      </summary>
      <p className="px-4 pt-3 text-sm text-slate-500">
        Unpublished documents that still require read confirmation. Confirmations are kept, and nobody is
        asked or counted while a document is unpublished. Publishing it again resumes the program where
        it left off.
      </p>
      <ul className="divide-y divide-slate-100">
        {rows.map((d) => (
          <li key={d.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
            <div className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium text-slate-800">
                {d.space_icon} {d.title}
              </span>
              <span className="block text-xs text-slate-500">Updated {date(d.updated_at)}</span>
            </div>
            <span
              className={chipClass("neutral", "sm")}
              tabIndex={0}
              data-tt="Read confirmation is paused while the document is unpublished. Confirmations are kept."
              data-tt-wrap=""
            >
              <CirclePause className="h-3 w-3" aria-hidden /> Unpublished
            </span>
            <span className="text-xs text-slate-500">
              {d.acked} of {people(d.required)} confirmed
            </span>
          </li>
        ))}
      </ul>
    </details>
  );
}

/**
 * Retired policies (G3, 1.12.0): the requirement is off for good, the
 * record is frozen and nobody is asked. Each row shows when it was retired
 * (the chip; who retired it is the chip's tooltip), the final standing
 * ("42 of 50 people confirmed v12": the counts and the version frozen on
 * the ledger row), the reason, the replacement when one was named, the
 * policy's Record page and its CSV, because the evidence stays readable
 * and exportable. No Remind, no re-ask, no Stop requiring: there is nothing
 * to ask or to stop. Un-retire, for managers, is the one action. Collapsed
 * by default and out of the tiles, like the paused group above it.
 */
function RetiredPolicies({
  rows,
  date,
  portal,
  register,
  onUnretire,
}: {
  rows: DocRow[];
  date: (iso: string) => string;
  portal: Portal;
  /** The row's focus target ("View record"), registered by document id for the page's focus move after Retire. */
  register: (id: number) => (el: HTMLElement | null) => void;
  onUnretire: (d: DocRow) => void;
}) {
  const { data, isBusy, busy } = portal;
  const can = data?.can ?? { manage: false, export: false };
  return (
    <details className="border-t border-slate-100 [&[open]>summary]:border-b [&[open]>summary]:border-slate-100">
      <summary className="cursor-pointer select-none px-4 py-3 text-sm font-semibold text-slate-700 hover:text-compass-700 marker:text-compass-500">
        Retired · {rows.length}
      </summary>
      <p className="px-4 pt-3 text-sm text-slate-500">
        Policies that no longer ask anyone to confirm. Every confirmation made before a policy was retired
        stays on record, and its Record and History pages stay open.
      </p>
      <ul className="divide-y divide-slate-100">
        {rows.map((d) => {
          const version = d.retired_rev ? ` v${d.retired_rev}` : "";
          return (
            <li key={d.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-slate-800">
                  {d.space_icon} {d.title}
                </span>
                {d.ack_retired_reason && (
                  <span className="block text-xs text-slate-500">{d.ack_retired_reason}</span>
                )}
                {d.superseded_by_title && d.ack_superseded_by != null && (
                  <span className="block text-xs text-slate-500">
                    Replaced by{" "}
                    <Link href={`/doc/${d.ack_superseded_by}`} className="font-medium text-compass-700 hover:underline">
                      {d.superseded_by_title}
                    </Link>
                  </span>
                )}
              </div>
              <span
                className={chipClass("neutral", "sm")}
                tabIndex={0}
                data-tt={
                  d.ack_retired_by_name
                    ? `Retired by ${d.ack_retired_by_name}. Nobody is asked to confirm; every confirmation stays on record.`
                    : "Nobody is asked to confirm; every confirmation stays on record."
                }
                data-tt-wrap=""
              >
                <Archive className="h-3 w-3" aria-hidden /> Retired {d.ack_retired_at ? date(d.ack_retired_at) : ""}
              </span>
              <span className="text-xs text-slate-500">
                {d.acked} of {people(d.required)} confirmed{version}
              </span>
              <div className="flex w-full flex-wrap items-center gap-1.5 print:hidden sm:w-auto sm:shrink-0">
                {/* A bare Link with the button recipe: it carries the ref
                    that takes focus after Retire (Button forwards none). */}
                <Link
                  ref={register(d.id)}
                  href={`/doc/${d.id}/acknowledgements`}
                  className={buttonClass("secondary", "sm")}
                  data-tt="Open this policy's record"
                >
                  <ClipboardCheck className="h-3.5 w-3.5 shrink-0" aria-hidden /> View record
                </Link>
                {can.manage && (
                  <Button
                    variant="secondary"
                    size="sm"
                    icon={<ArchiveRestore />}
                    onClick={() => onUnretire(d)}
                    disabled={busy}
                    busy={isBusy(`unretire-${d.id}`)}
                    data-tt="Ask people to confirm this policy again; confirmations made before it was retired stay on record"
                    data-tt-wrap=""
                  >
                    Un-retire
                  </Button>
                )}
                {can.export && (
                  <a
                    href={`/api/documents/${d.id}/acknowledgements?format=csv`}
                    data-tt="Download this policy's compliance record"
                    aria-label="Download this policy's compliance record"
                    className={iconButtonClass("bordered", "sm")}
                  >
                    <Download />
                  </a>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </details>
  );
}
