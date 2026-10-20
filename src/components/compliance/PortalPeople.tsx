"use client";

// Compliance › People (B4, 1.12.0): each person's required and confirmed
// counts with their standing, as the one-page portal's People card showed
// them, and (E1, 1.13.0) how many of their outstanding confirmations are
// past their due date. 1.14.0 (F1, F3): the person links to their
// compliance record, the Standing chip reads Compliant / "{n} outstanding"
// / "{n} overdue" (the overdue count in the Overdue column is ink, as a
// measurement should be), and the house controls sit above the table: a
// Segmented Show (All / Outstanding / Overdue / Compliant), the list filter
// with its live count, and the Pager past 50 rows.

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Users, Check, CircleAlert, CalendarX2 } from "lucide-react";
import { chipClass } from "@/components/Chip";
import { Card } from "@/components/Card";
import { Segmented } from "@/components/Segmented";
import { ListFilter } from "@/components/ListFilter";
import { SectionEmpty } from "@/components/form";
import { Table, Th, Td, TABLE_HEAD_ROW, TR } from "@/components/Table";
import { Pager } from "@/components/Pager";
import { standingOf } from "@/components/compliance/copy";
import { pageOf, useBulkSelection, usePortal, type PersonRow, type PortalPageProps } from "./use-portal";
import { PortalFallback } from "./PortalFallback";
import { PeopleBulkBar } from "./PortalBulk";

const PEOPLE_PAGE = 50;

type Show = "all" | "outstanding" | "overdue" | "compliant";

const SHOW_OPTIONS: { value: Show; label: string }[] = [
  { value: "all", label: "All" },
  { value: "outstanding", label: "Outstanding" },
  { value: "overdue", label: "Overdue" },
  { value: "compliant", label: "Compliant" },
];

/** The section-level line when the Show choice leaves nobody. */
const EMPTY_BY_SHOW: Record<Show, string> = {
  all: "No one has a confirmation pending or recorded yet.",
  outstanding: "Nobody is outstanding: everyone asked has confirmed.",
  overdue: "Nobody is overdue.",
  compliant: "Nobody has confirmed everything they are asked to yet.",
};

function matches(needle: string, ...values: (string | null | undefined)[]): boolean {
  if (!needle) return true;
  return values.some((v) => (v ?? "").toLowerCase().includes(needle));
}

/** The Show choice's rule: Outstanding is anyone with a confirmation left, Overdue anyone past a date, Compliant everyone done. */
function shows(u: PersonRow, show: Show): boolean {
  if (show === "all") return true;
  const standing = standingOf(u);
  if (show === "outstanding") return standing.kind !== "compliant";
  if (show === "overdue") return (u.overdue ?? 0) > 0;
  return standing.kind === "compliant";
}

export function PortalPeople({ licensed, canManageLicense = false }: PortalPageProps) {
  const portal = usePortal(licensed);
  const [show, setShow] = useState<Show>("all");
  const [filter, setFilter] = useState("");
  const [page, setPage] = useState(0);
  const needle = filter.trim().toLowerCase();
  const users = portal.data?.users;

  // What the Show control leaves, then what the filter leaves of that: the
  // count beside the filter reads "3 of 42 people" against the Show choice.
  const base = useMemo(() => (users ?? []).filter((u) => u.required > 0 && shows(u, show)), [users, show]);
  const visible = useMemo(
    () => (needle ? base.filter((u) => matches(needle, u.name, u.username, u.role)) : base),
    [base, needle]
  );

  // The bulk selection (F5, 1.14.0): a checkbox per person, the header's
  // "Select all shown" over what the Show control and the filter leave,
  // shift-click ranges in that order, and the bar while anyone is checked.
  // Pruned on reload; cleared after an action (the bar does both).
  const visibleIds = useMemo(() => visible.map((u) => u.id), [visible]);
  const allIds = useMemo(() => (users ?? []).filter((u) => u.required > 0).map((u) => u.id), [users]);
  const selection = useBulkSelection(allIds);
  const headCheck = useRef<HTMLInputElement>(null);
  const allShown = selection.allOf(visibleIds);
  const someShown = !allShown && selection.someOf(visibleIds);
  useEffect(() => {
    if (headCheck.current) headCheck.current.indeterminate = someShown;
  }, [someShown]);
  const { selected: selectedIds } = selection;
  const selectedPeople = useMemo(() => (users ?? []).filter((u) => u.required > 0 && selectedIds.has(u.id)), [users, selectedIds]);

  if (!portal.data) return <PortalFallback licensed={licensed} canManageLicense={canManageLicense} portal={portal} />;
  const { can } = portal.data;
  const busy = portal.busy;
  const anyone = portal.data.users.some((u) => u.required > 0);
  const pages = Math.max(1, Math.ceil(visible.length / PEOPLE_PAGE));
  const current = Math.min(page, pages - 1);
  const pager =
    visible.length > PEOPLE_PAGE ? (
      <Pager page={current} limit={PEOPLE_PAGE} total={visible.length} onPage={setPage} className="print:hidden" />
    ) : null;
  const changeShow = (next: Show) => {
    setShow(next);
    setPage(0);
  };
  const changeFilter = (next: string) => {
    setFilter(next);
    setPage(0);
  };

  return (
    <Card title="People" icon={<Users />} padding="none">
      {!anyone ? (
        <SectionEmpty className="px-4 py-6">{EMPTY_BY_SHOW.all}</SectionEmpty>
      ) : (
        <>
          {/* The toolbar fits a phone (STYLEGUIDE §Segmented controls): the
              Show options may wrap inside the pill, the filter keeps its
              floor. Controls stay off paper. */}
          <div className="flex flex-wrap items-center gap-3 border-b border-slate-100 px-4 py-3 print:hidden">
            <Segmented label="Show" size="sm" options={SHOW_OPTIONS} value={show} onChange={changeShow} className="flex-wrap" />
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
          {can.manage && selection.size > 0 && (
            // The bulk bar (F5): the actions over the checked people; a
            // successful action clears the selection and reloads.
            <div className="border-b border-slate-100 px-4 py-3">
              <PeopleBulkBar selected={selectedPeople} onClear={selection.clear} onDone={() => portal.load()} />
            </div>
          )}
          {pager && <div className="border-b border-slate-100 px-4 py-2">{pager}</div>}
          {visible.length === 0 ? (
            <SectionEmpty className="px-4 py-6">{needle ? "No people match your filter." : EMPTY_BY_SHOW[show]}</SectionEmpty>
          ) : (
            <Table scroll>
              <thead className={TABLE_HEAD_ROW}>
                <tr>
                  {can.manage && (
                    // "Select all shown": everyone the Show control and the
                    // filter leave, across the pages (STYLEGUIDE §Tables'
                    // bulk bar).
                    <Th fit className="print:hidden">
                      <input
                        ref={headCheck}
                        type="checkbox"
                        aria-label="Select all shown"
                        checked={allShown}
                        disabled={busy || visibleIds.length === 0}
                        onChange={() => selection.toggleAll(visibleIds)}
                        className="h-4 w-4 align-middle"
                      />
                    </Th>
                  )}
                  <Th>Person</Th>
                  <Th fit align="right">
                    Required
                  </Th>
                  <Th fit align="right">
                    Confirmed
                  </Th>
                  <Th fit align="right">
                    Overdue
                  </Th>
                  <Th fit align="right">
                    Standing
                  </Th>
                </tr>
              </thead>
              <tbody>
                {pageOf(visible, current, PEOPLE_PAGE).map((u) => {
                  const standing = standingOf(u);
                  return (
                    <tr key={u.id} className={TR} aria-selected={can.manage ? selection.has(u.id) : undefined}>
                      {can.manage && (
                        <Td fit className="print:hidden">
                          <input
                            type="checkbox"
                            aria-label={`Select ${u.name || u.username}`}
                            checked={selection.has(u.id)}
                            disabled={busy}
                            onClick={selection.markShift}
                            onChange={() => selection.toggle(u.id, visibleIds)}
                            className="h-4 w-4 align-middle"
                          />
                        </Td>
                      )}
                      <Td className="font-medium text-slate-700">
                        {/* The person's compliance record (F3): every policy
                            they must confirm, with the evidence and prior
                            cycles. */}
                        <Link href={`/compliance/person/${u.id}`} className="hover:text-compass-600 hover:underline">
                          {u.name || u.username}
                        </Link>
                        <span className="ml-1.5 text-xs font-normal text-slate-500">{u.role}</span>
                      </Td>
                      <Td fit align="right" className="text-slate-500">
                        {u.required}
                      </Td>
                      <Td fit align="right" className="text-slate-600">
                        {u.acked}
                      </Td>
                      <Td fit align="right">
                        {/* A measurement is ink, never a chip (STYLEGUIDE
                            §Tables): the error ink when any confirmation is
                            past its date and grace; the Standing chip beside
                            it is the alarm. */}
                        {(u.overdue ?? 0) > 0 ? (
                          <span className="font-medium text-red-600">{u.overdue}</span>
                        ) : (
                          <span className="text-slate-500">0</span>
                        )}
                      </Td>
                      <Td fit align="right">
                        <span className={chipClass(standing.tone)}>
                          {standing.kind === "compliant" ? (
                            <Check className="h-3 w-3" aria-hidden />
                          ) : standing.kind === "overdue" ? (
                            <CalendarX2 className="h-3 w-3" aria-hidden />
                          ) : (
                            <CircleAlert className="h-3 w-3" aria-hidden />
                          )}{" "}
                          {standing.text}
                        </span>
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          )}
          {pager && <div className="border-t border-slate-100 px-4 py-2">{pager}</div>}
        </>
      )}
    </Card>
  );
}
