"use client";

// Compliance › Overview (B4, 1.12.0): the programme's tiles, as the one-page
// portal showed them above its lists, plus (G1) the live policies whose next
// re-confirmation falls within 30 days. 1.14.0 (F1) makes them the six of
// items/F1.md (Policies, Compliance, Overdue with its people, Due in 7 days,
// Pending, Exempt), keeps the re-confirmation tile as a seventh, and adds
// the Needs attention queue under them: the training Overview's triage list
// for policies, one row per person and reason (or per policy, for the
// drift rows) with the actions that close it.

import { useCallback, useEffect, useRef } from "react";
import Link from "next/link";
import {
  FileCheck,
  Percent,
  CalendarClock,
  CalendarX2,
  CircleAlert,
  Hourglass,
  UserMinus,
  UserCheck,
  BellRing,
  BellOff,
  Timer,
} from "lucide-react";
import { Card } from "@/components/Card";
import { Button } from "@/components/Button";
import { chipClass } from "@/components/Chip";
import { SectionEmpty } from "@/components/form";
import { ReconfirmButton } from "@/components/ReconfirmButton";
import { useFormatDate } from "@/components/SettingsProvider";
import { SNOOZE_INVARIANT } from "@/lib/ack-assignments";
import {
  ATTENTION_EMPTY,
  EXEMPT_TIP,
  EXTEND_TIP,
  REMIND_TIP,
  SNOOZE_TIP,
  SNOOZED_ROWS_NOTE,
  UNEXEMPT_TIP,
  attentionChip,
  attentionCount,
  people,
} from "@/components/compliance/copy";
import { ATTENTION_PERSON_REASONS, usePortal, type PolicyAttentionRow, type PortalPageProps } from "./use-portal";
import { PortalFallback } from "./PortalFallback";
import { TEAM_LEADS_COMPLIANCE_COPY, TeamLeadsBlock } from "@/components/TeamLeadsBlock";

/** A queue row's key: the assignment for a person's row, the reason and the policy for a policy-level one. */
function rowKey(r: PolicyAttentionRow): string {
  return r.assignment_id != null ? `a${r.assignment_id}` : `${r.reason}-${r.document_id}`;
}

export function PortalOverview({ licensed, canManageLicense = false }: PortalPageProps) {
  const fmt = useFormatDate();
  const portal = usePortal(licensed);

  // Focus after a row action (STYLEGUIDE §Settings pages: focus never falls
  // to <body>). The row that was acted on leaves the queue (snoozed,
  // exempted, re-asked) or changes place, and the button that had focus
  // unmounts with it, so the neighbour's row is noted before the request
  // and focused once the new payload has rendered; a cancelled or refused
  // action clears the note. With no neighbour, the queue's card takes it.
  const rowEls = useRef(new Map<string, HTMLLIElement>());
  const queueEl = useRef<HTMLDivElement>(null);
  const pendingFocus = useRef<string | null>(null);
  const registerRow = useCallback(
    (key: string) => (el: HTMLLIElement | null) => {
      if (el) rowEls.current.set(key, el);
      else rowEls.current.delete(key);
    },
    []
  );
  const { data } = portal;
  useEffect(() => {
    const key = pendingFocus.current;
    if (key == null) return;
    pendingFocus.current = null;
    (rowEls.current.get(key) ?? queueEl.current)?.focus();
  }, [data]);
  const focusAfter = (rows: PolicyAttentionRow[], index: number, action: () => Promise<boolean>) => {
    const neighbour = rows[index + 1] ?? rows[index - 1];
    pendingFocus.current = neighbour ? rowKey(neighbour) : "";
    void action().then((done) => {
      if (!done) pendingFocus.current = null;
    });
  };

  if (!portal.data) return <PortalFallback licensed={licensed} canManageLicense={canManageLicense} portal={portal} />;
  const { kpis: k, can, docs } = portal.data;
  const queue = portal.data.attention ?? { rows: [], total: 0, snoozed: 0 };
  const { busy, isBusy, attention } = portal;
  const overdue = k.overdue ?? 0;

  const tiles: { icon: React.ReactNode; label: string; value: string | number; sub?: string; alert?: boolean }[] = [
    { icon: <FileCheck className="h-4 w-4" />, label: "Policies", value: k.policies },
    { icon: <Percent className="h-4 w-4" />, label: "Compliance", value: `${k.pct}%` },
    // Overdue reads in the error ink above zero, with the people behind the
    // number under it (one person can owe several overdue confirmations).
    { icon: <CalendarX2 className="h-4 w-4" />, label: "Overdue", value: overdue, sub: people(k.overdue_people ?? 0), alert: overdue > 0 },
    { icon: <Hourglass className="h-4 w-4" />, label: "Due in 7 days", value: k.due_7d ?? 0 },
    { icon: <CircleAlert className="h-4 w-4" />, label: "Pending", value: k.pending ?? k.outstanding },
    { icon: <UserMinus className="h-4 w-4" />, label: "Exempt", value: k.exempt ?? 0 },
    // The seventh (G1, 1.12.0) stays: at 9rem a Wide page holds seven
    // across and a Normal page five and two, which reads as well as five
    // and one; dropping the number would hide the annual cycle's workload.
    { icon: <CalendarClock className="h-4 w-4" />, label: "Re-confirmation due in 30 days", value: k.recert_due_30 ?? 0 },
  ];

  return (
    <div className="space-y-5">
      {/* KPIs: a description list, so each number is the definition of its
          label and a reader (or a test) finds "Overdue" and its value without
          a class name. The label is the term and comes first in the markup;
          the column reverses it visually so the tile still reads icon,
          number, label. Seven tiles in a card-grid (STYLEGUIDE §Scaling):
          9rem each, as many across as the page width holds, never a
          viewport breakpoint. Every sum is over the live policies (paused
          and retired ones are out); Exempt is beside the denominator, not
          in it. */}
      <dl className="card-grid [--card-min:9rem] gap-3">
        {tiles.map((c) => (
          <div key={c.label} className="flex flex-col rounded-xl border border-slate-200 bg-surface p-4 shadow-xs">
            <dt className="order-last text-xs text-slate-500">{c.label}</dt>
            <dd>
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-compass-50 text-compass-600">
                {c.icon}
              </span>
              <span className={`mt-2 block text-2xl font-bold tracking-tight ${c.alert ? "text-red-600" : "text-slate-900"}`}>
                {c.value}
              </span>
              {c.sub && <span className="block text-xs text-slate-500">{c.sub}</span>}
            </dd>
          </div>
        ))}
      </dl>

      {/* Needs attention (F1): work this list to zero. The header's count
          line keeps the cut and the snoozed rows visible as numbers; each
          row is the person (a link to their record), the policy (a link to
          its Record tab), the reason chip and the actions a compliance
          manager has. The policy-level rows (a drifted text, edits kept
          against the suggestion) lead the list and ask for the deliberate
          re-ask; the person rows follow by reason, then by due date. */}
      <Card
        title="Needs attention"
        icon={<CircleAlert />}
        padding="none"
        description={attentionCount(queue.rows.length, queue.total, queue.snoozed)}
        className="scroll-mt-6"
        id="needs-attention"
      >
        <div ref={queueEl} tabIndex={-1}>
          {queue.rows.length === 0 ? (
            <SectionEmpty className="px-4 py-6">{ATTENTION_EMPTY}</SectionEmpty>
          ) : (
            <ul className="divide-y divide-slate-100">
              {queue.rows.map((r, i) => {
                const key = rowKey(r);
                const chip = attentionChip(r, fmt.date);
                const doc = docs.find((d) => d.id === r.document_id);
                const person = r.user_id != null && ATTENTION_PERSON_REASONS.has(r.reason);
                return (
                  <li
                    key={key}
                    ref={registerRow(key)}
                    tabIndex={-1}
                    className="flex flex-wrap items-center gap-2 px-4 py-2 text-sm"
                  >
                    {r.user_id != null && (
                      <Link
                        href={`/compliance/person/${r.user_id}`}
                        className="font-medium text-slate-700 hover:text-compass-600 hover:underline"
                      >
                        {r.user_name}
                      </Link>
                    )}
                    <Link
                      href={`/doc/${r.document_id}/acknowledgements`}
                      className={`min-w-0 flex-1 truncate hover:text-compass-600 hover:underline ${
                        r.user_id != null ? "text-slate-500" : "font-medium text-slate-700"
                      }`}
                    >
                      {r.title}
                    </Link>
                    <span className={chipClass(chip.tone, "sm")}>{chip.text}</span>
                    {can.manage && (
                      // Four controls do not fit beside the names on a
                      // phone: under sm the group takes the row's width
                      // and wraps; from sm it keeps the one-line layout.
                      <span className="flex w-full flex-wrap items-center gap-1 print:hidden sm:w-auto sm:shrink-0">
                        {person && r.assignment_id != null && (
                          <>
                            <Button
                              variant="secondary"
                              size="sm"
                              icon={<BellRing />}
                              onClick={() => focusAfter(queue.rows, i, () => attention.remind(r))}
                              disabled={busy}
                              busy={isBusy(`remind-${r.document_id}`)}
                              data-tt={REMIND_TIP}
                              data-tt-wrap=""
                            >
                              Remind
                            </Button>
                            <Button
                              variant="secondary"
                              size="sm"
                              icon={<Timer />}
                              onClick={() => focusAfter(queue.rows, i, () => attention.extendWeek(r))}
                              disabled={busy}
                              busy={isBusy(`extend-${r.assignment_id}`)}
                              data-tt={EXTEND_TIP}
                              data-tt-wrap=""
                            >
                              Extend 7 days
                            </Button>
                            <Button
                              variant="secondary"
                              size="sm"
                              icon={<BellOff />}
                              onClick={() => focusAfter(queue.rows, i, () => attention.snoozeWeek(r))}
                              disabled={busy}
                              busy={isBusy(`snooze-${r.assignment_id}`)}
                              data-tt={SNOOZE_TIP}
                            >
                              Snooze
                            </Button>
                            <Button
                              variant="secondary"
                              size="sm"
                              icon={<UserMinus />}
                              onClick={() => focusAfter(queue.rows, i, () => attention.exempt(r))}
                              disabled={busy}
                              busy={isBusy(`exempt-${r.assignment_id}`)}
                              data-tt={EXEMPT_TIP}
                              data-tt-wrap=""
                            >
                              Exempt…
                            </Button>
                          </>
                        )}
                        {r.reason === "standing_exemption" && r.assignment_id != null && (
                          <Button
                            variant="secondary"
                            size="sm"
                            icon={<UserCheck />}
                            onClick={() => focusAfter(queue.rows, i, () => attention.unexempt(r))}
                            disabled={busy}
                            busy={isBusy(`unexempt-${r.assignment_id}`)}
                            data-tt={UNEXEMPT_TIP}
                            data-tt-wrap=""
                          >
                            Remove exemption
                          </Button>
                        )}
                        {(r.reason === "drifted" || r.reason === "kept_n") && doc && (
                          // The deliberate re-ask (A7): the same control as
                          // the Policies row, with the standing from that
                          // row; the marker moves and the drift row leaves.
                          <ReconfirmButton
                            docId={doc.id}
                            title={doc.title}
                            summary={{ current: doc.acked, eligible: doc.required, rev: doc.ack_rev ?? null }}
                            onDone={() => {
                              pendingFocus.current = queue.rows[i + 1] ? rowKey(queue.rows[i + 1]) : queue.rows[i - 1] ? rowKey(queue.rows[i - 1]) : "";
                              portal.dropRoster(doc.id);
                              void portal.load();
                            }}
                          />
                        )}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          {queue.snoozed > 0 && (
            // The snooze invariant, spelled out where snoozed rows are
            // hidden: the tooltip on Snooze says what it does to the queue;
            // this says what it does not do to anything else.
            <p className="border-t border-slate-100 px-4 py-3 text-xs text-slate-500">
              {SNOOZED_ROWS_NOTE} {SNOOZE_INVARIANT}
            </p>
          )}
        </div>
      </Card>

      {/* Team leads (F4, 1.14.0): the block the training Overview shows,
          for programme managers, against the compliance leads route; the
          leads are one list for both programmes. */}
      {can.manage && <TeamLeadsBlock copy={TEAM_LEADS_COMPLIANCE_COPY} api="/api/compliance/leads" />}
    </div>
  );
}
