"use client";

// Compliance › Policies (B4, 1.12.0): asking for a read confirmation of any
// published document, and every policy's progress with its row actions,
// the roster expand and the paused group. Moved from the one-page portal
// with every action, dialog, toast and string as it was; the matrix's
// Export CSV, a page-header action until the header became the section's,
// sits on the Policy progress card it exports. Wave 2 adds the Retired
// group (G3), the row actions for retirement, the "Next re-confirmation"
// text (G1) and the AckRoster expand (C4).

import {
  ShieldOff,
  FileCheck,
  Download,
  Send,
  BellRing,
  ChevronDown,
  ChevronRight,
  Check,
  CircleDashed,
  CirclePause,
  X,
} from "lucide-react";
import { LoadingRow } from "@/components/Spinner";
import { chipClass } from "@/components/Chip";
import { Button, buttonClass, iconButtonClass } from "@/components/Button";
import { Card } from "@/components/Card";
import { EntityPicker } from "@/components/EntityPicker";
import { SectionEmpty } from "@/components/form";
import { Table, Th, Td, TABLE_HEAD_ROW, TR } from "@/components/Table";
import { Pager } from "@/components/Pager";
import { RelativeTime } from "@/components/RelativeTime";
import { ReconfirmButton } from "@/components/ReconfirmButton";
import { EDIT_DEFAULT_CHIP, EDIT_DEFAULT_OPTIONS, people } from "@/components/compliance/copy";
import type { EditDefault } from "@/lib/compliance-settings";
import { timeAgo } from "@/lib/ui";
import { useFormatDate } from "@/components/SettingsProvider";
import { pageOf, usePortal, type DecisionBrief, type DocRow, type PortalPageProps } from "./use-portal";
import { PortalFallback } from "./PortalFallback";

const ROSTER_PAGE = 50;

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

/** "Edited 3 times since v12 without re-asking · 7.8% drift" (the number feeds the needs-attention queue later). */
function driftLabel(d: DocRow): string {
  const n = d.kept_since_reset ?? 0;
  const drift = Number(d.drift_pct ?? 0);
  const edited = n === 1 ? "Edited once" : `Edited ${n} times`;
  const since = d.ack_rev ? `v${d.ack_rev}` : "the last ask";
  return `${edited} since ${since} without re-asking` + (drift > 0 ? ` · ${drift.toFixed(1)}% drift` : "");
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
  if (!portal.data) return <PortalFallback licensed={licensed} canManageLicense={canManageLicense} portal={portal} />;
  const { data, isBusy, busy, open, rosters, rosterPage, setRosterPage, candidate, setCandidate, previewing } = portal;
  const { can } = data;
  // A paused policy (unpublished, requirement still on) is listed apart from
  // the live ones, with no actions: every row action needs a published
  // document, and the server's tiles already leave it out (G2).
  const active = data.docs.filter((d) => d.status === "published");
  const paused = data.docs.filter((d) => d.status !== "published");

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
          can.export ? (
            // Printed for the record (STYLEGUIDE §Print): the controls stay
            // off the paper, here, on the Request card and on the rows. A
            // plain anchor: a Link would prefetch the download, and every
            // export is an audit row.
            <a href="/api/admin/compliance?format=csv" className={buttonClass("secondary", "sm", "print:hidden")}>
              <Download className="h-4 w-4" aria-hidden /> Export CSV
            </a>
          ) : undefined
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
          <ul className="divide-y divide-slate-100">
            {active.map((d) => {
              const pct = d.required ? Math.round((d.acked / d.required) * 100) : 100;
              const complete = d.acked >= d.required;
              const roster = rosters[d.id];
              return (
                <li key={d.id}>
                  <div className="flex flex-wrap items-center gap-3 px-4 py-3">
                    <div className="min-w-0 flex-1">
                      <button
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
                          <span className="block text-xs text-slate-500">
                            Updated {fmt.date(d.updated_at)} ·{" "}
                            {d.ack_last_reminded_at
                              ? `last reminded ${timeAgo(d.ack_last_reminded_at)}`
                              : "never reminded"}
                          </span>
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
                          text edit; the drift chip appears once edits have
                          been kept. */}
                      {(d.ack_edit_default || (d.kept_since_reset ?? 0) > 0) && (
                        <span className="mt-1 flex flex-wrap items-center gap-1.5 pl-6">
                          {d.ack_edit_default && (
                            <span
                              className={chipClass("neutral", "sm")}
                              tabIndex={0}
                              data-tt={editDefaultTip(d.ack_edit_default)}
                              data-tt-wrap=""
                            >
                              {EDIT_DEFAULT_CHIP[d.ack_edit_default]}
                            </span>
                          )}
                          {(d.kept_since_reset ?? 0) > 0 && (
                            <span
                              className={chipClass("neutral", "sm")}
                              tabIndex={0}
                              data-tt="Edits the editor said did not need everyone to re-confirm; drift is how far the text now differs from the version people confirmed"
                              data-tt-wrap=""
                            >
                              {driftLabel(d)}
                            </span>
                          )}
                        </span>
                      )}
                    </div>
                    <div className="w-40">
                      <div className="mb-0.5 flex justify-between text-xs">
                        <span className={complete ? "font-medium ink-ok" : "text-slate-500"}>
                          {d.acked}/{d.required}
                        </span>
                        <span className="text-slate-500">{pct}%</span>
                      </div>
                      <div className="h-1.5 overflow-hidden rounded-full bg-slate-100">
                        <div
                          className={`h-full rounded-full ${complete ? "bg-emerald-500" : "bg-compass-500"}`}
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    </div>
                    {(can.manage || can.export) && (
                      // Four controls do not fit beside the title on a
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
                      ) : roster.length === 0 ? (
                        <SectionEmpty className="px-4 py-4">
                          No one is expected to confirm this policy yet.
                        </SectionEmpty>
                      ) : (
                        <>
                          <Table scroll>
                            <thead className={TABLE_HEAD_ROW}>
                              <tr>
                                <Th>Person</Th>
                                <Th fit>Status</Th>
                                <Th fit>Confirmed</Th>
                                <Th fit>Version</Th>
                              </tr>
                            </thead>
                            <tbody>
                              {pageOf(roster, rosterPage, ROSTER_PAGE).map((r) => (
                                <tr key={r.id} className={TR}>
                                  <Td className="text-slate-700">{r.name || r.username}</Td>
                                  <Td fit>
                                    {r.acknowledged_at ? (
                                      <span className={chipClass("ok", "sm")}>
                                        <Check className="h-3 w-3" aria-hidden /> Confirmed
                                      </span>
                                    ) : (
                                      <span className={chipClass("warn", "sm")}>
                                        <CircleDashed className="h-3 w-3" aria-hidden /> Pending
                                      </span>
                                    )}
                                  </Td>
                                  <Td fit className="text-slate-500">
                                    {r.acknowledged_at ? <RelativeTime value={r.acknowledged_at} /> : ""}
                                  </Td>
                                  <Td fit className="text-slate-500">
                                    {r.rev ? `v${r.rev}` : ""}
                                  </Td>
                                </tr>
                              ))}
                            </tbody>
                          </Table>
                          {roster.length > ROSTER_PAGE && (
                            <div className="border-t border-slate-100 px-4 py-2">
                              <Pager
                                page={rosterPage}
                                limit={ROSTER_PAGE}
                                total={roster.length}
                                onPage={setRosterPage}
                              />
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {paused.length > 0 && <PausedPolicies rows={paused} date={fmt.date} />}
      </Card>
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
