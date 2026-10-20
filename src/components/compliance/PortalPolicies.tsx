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
// Record tab's AckRoster inside the expand row (C4).

import { useCallback, useEffect, useRef } from "react";
import Link from "next/link";
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
  X,
} from "lucide-react";
import { LoadingRow } from "@/components/Spinner";
import { chipClass } from "@/components/Chip";
import { Button, buttonClass, iconButtonClass } from "@/components/Button";
import { Card } from "@/components/Card";
import { EntityPicker } from "@/components/EntityPicker";
import { SectionEmpty } from "@/components/form";
import { AckRoster } from "@/components/AckRoster";
import { ReconfirmButton } from "@/components/ReconfirmButton";
import { EDIT_DEFAULT_CHIP, EDIT_DEFAULT_OPTIONS, people } from "@/components/compliance/copy";
import type { EditDefault } from "@/lib/compliance-settings";
import { recertPortalLine } from "@/lib/ack-recert";
import { timeAgo } from "@/lib/ui";
import { useFormatDate } from "@/components/SettingsProvider";
import { usePortal, type DecisionBrief, type DocRow, type Portal, type PortalPageProps } from "./use-portal";
import { PortalFallback } from "./PortalFallback";

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

  if (!portal.data) return <PortalFallback licensed={licensed} canManageLicense={canManageLicense} portal={portal} />;
  const { data, isBusy, busy, open, rosters, candidate, setCandidate, previewing } = portal;
  const { can } = data;
  // A paused policy (unpublished, requirement still on) is listed apart from
  // the live ones, with no actions: every row action needs a published
  // document, and the server's tiles already leave it out (G2). A retired
  // policy (G3) is its own group whatever its status: the requirement is
  // off, the record is frozen, and the tiles leave it out too.
  const retired = data.docs.filter((d) => d.ack_retired_at !== null);
  const active = data.docs.filter((d) => d.status === "published" && d.ack_retired_at === null);
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
                          <span className="block text-xs text-slate-500">
                            Updated {fmt.date(d.updated_at)} ·{" "}
                            {d.ack_last_reminded_at
                              ? `last reminded ${timeAgo(d.ack_last_reminded_at)}`
                              : "never reminded"}
                            {/* The stored next cycle date (G1), when the policy has one: a calendar day, so the day formatter. */}
                            {recertPortalLine(d, fmt.day) && ` · ${recertPortalLine(d, fmt.day)}`}
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
                        // The Record tab's roster (C4): the Show and people
                        // filters, the pager and the evidence columns, on
                        // the JSON rows the route already answers. No
                        // ledger here (the view switch stays hidden) and no
                        // word count (no read-time threshold without the
                        // text); the IP column follows compliance.export.
                        // Frameless: the strip's tint frames the table, not
                        // a second card inside the row.
                        <div className="px-4 py-3">
                          <AckRoster docId={d.id} rows={roster} canSeeIp={can.export} fmt={fmt.settings} frame={false} />
                        </div>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
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
