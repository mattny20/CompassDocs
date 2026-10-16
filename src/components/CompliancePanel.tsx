"use client";

// Central compliance portal: org-wide read-confirmation progress across every
// policy, per-person standing, asking for a read confirmation of any published
// doc, reminders to stragglers and stopping a requirement. Enterprise
// (policy_ack). 1.10.1 (F7): every action runs through useAction() with
// toasts, the tables are the house Table/Pager, the payload is typed, and the
// controls follow the server's `can` flags (F6) so a read-only holder sees
// the programme without a button that would answer 403. Request and Remind
// ask first (A8): the shared requireAckDialog with the audience count, and a
// "Remind N people?" confirmDialog, because sending mail cannot be undone.

import { useCallback, useEffect, useState } from "react";
import {
  ShieldCheck,
  ShieldOff,
  FileCheck,
  Users,
  CircleAlert,
  Percent,
  Download,
  Send,
  BellRing,
  ChevronDown,
  ChevronRight,
  Check,
  CircleDashed,
  Settings2,
  X,
} from "lucide-react";
import { LoadingRow } from "@/components/Spinner";
import { chipClass, EnterpriseBadge } from "@/components/Chip";
import { Button, buttonClass, iconButtonClass } from "@/components/Button";
import { Card } from "@/components/Card";
import { EntityPicker } from "@/components/EntityPicker";
import { PageHeader } from "@/components/PageHeader";
import { LicenseGate } from "@/components/LicenseGate";
import { EmptyState, SectionEmpty } from "@/components/form";
import { Table, Th, Td, TABLE_HEAD_ROW, TR } from "@/components/Table";
import { Pager } from "@/components/Pager";
import { RelativeTime } from "@/components/RelativeTime";
import { confirmDialog } from "@/components/Dialog";
import { toast } from "@/components/Toasts";
import { requireAckDialog } from "@/components/RequireAckDialog";
import { ReconfirmButton } from "@/components/ReconfirmButton";
import { EDIT_DEFAULT_CHIP, EDIT_DEFAULT_OPTIONS, people } from "@/components/compliance/copy";
import type { EditDefault } from "@/lib/compliance-settings";
import { useAction } from "@/lib/use-action";
import { timeAgo } from "@/lib/ui";
import { useFormatDate } from "./SettingsProvider";

// ── The GET payload, as src/app/api/admin/compliance/route.ts answers it ────

export interface DocRow {
  id: number;
  title: string;
  space_name: string;
  space_icon: string;
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
  };
  docs: DocRow[];
  users: PersonRow[];
  candidates: CandidateDoc[];
  /** What the viewer may do (F6): manage = request, remind, stop; export = the CSVs. */
  can: { manage: boolean; export: boolean };
}

/** One row of GET /api/documents/{id}/acknowledgements (the roster expand). */
interface RosterRow {
  id: number;
  name: string;
  username: string;
  acknowledged_at: string | null;
  rev: number | null;
}

/** The POST answers the portal reads back. */
interface PostResult {
  ok?: boolean;
  queued?: number;
  eligible?: number;
  acked?: number;
  required?: number;
}

const PEOPLE_PAGE = 50;
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

function pageOf<T>(rows: T[], page: number, size: number): T[] {
  return rows.slice(page * size, (page + 1) * size);
}

/** The per-policy edit-default chip's tooltip (A5): the full option sentence behind EDIT_DEFAULT_CHIP's short state. */
function editDefaultTip(value: EditDefault): string {
  const label = EDIT_DEFAULT_OPTIONS.find((o) => o.value === value)?.label ?? "";
  // "When the text changes: ask the editor each time." (the Select's own words)
  const sentence = label.replace(/\s*\(recommended\)$/, "");
  return `When the text changes: ${sentence.charAt(0).toLowerCase()}${sentence.slice(1)}.`;
}

export function CompliancePanel({
  licensed,
  canManageLicense = false,
}: {
  licensed: boolean;
  /** Whether the viewer can open Settings → License (the gate's button). Passed from the server. */
  canManageLicense?: boolean;
}) {
  const fmt = useFormatDate();
  const { run, isBusy, busy } = useAction();
  const [data, setData] = useState<CompliancePayload | null>(null);
  const [loadError, setLoadError] = useState("");
  const [open, setOpen] = useState<number | null>(null);
  const [rosters, setRosters] = useState<Record<number, RosterRow[]>>({});
  const [rosterPage, setRosterPage] = useState(0);
  const [peoplePage, setPeoplePage] = useState(0);
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
  async function post(key: string, body: Record<string, unknown>, fallback: string): Promise<PostResult | null> {
    const box: { result?: PostResult } = {};
    const ok = await run(
      key,
      async () => {
        const res = await fetch("/api/admin/compliance", {
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

  async function toggleRoster(docId: number) {
    if (open === docId) {
      setOpen(null);
      return;
    }
    setOpen(docId);
    setRosterPage(0);
    if (rosters[docId]) return;
    try {
      const res = await fetch(`/api/documents/${docId}/acknowledgements`);
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d?.error || "");
      setRosters((prev) => ({ ...prev, [docId]: (d?.rows ?? []) as RosterRow[] }));
    } catch (e) {
      // Never a permanent spinner: say why, and fold the row back.
      toast("error", (e instanceof Error && e.message) || "Couldn't load the roster.");
      setOpen((cur) => (cur === docId ? null : cur));
    }
  }

  if (!licensed) {
    return (
      <div>
        <Header />
        <LicenseGate feature="The compliance portal" entitlement="policy_ack" canManage={canManageLicense} />
      </div>
    );
  }

  if (loadError && !data) {
    return (
      <div>
        <Header />
        <EmptyState
          icon={<CircleAlert />}
          title="Couldn't load the compliance portal"
          body={loadError}
          action={{ onClick: () => void load(), label: "Try again" }}
        />
      </div>
    );
  }

  if (!data) {
    return (
      <div>
        <Header />
        <LoadingRow className="py-10" />
      </div>
    );
  }

  const { kpis: k, can } = data;
  const peopleRows = data.users.filter((u) => u.required > 0);
  const peoplePager =
    peopleRows.length > PEOPLE_PAGE ? (
      <Pager page={peoplePage} limit={PEOPLE_PAGE} total={peopleRows.length} onPage={setPeoplePage} />
    ) : null;

  return (
    <div>
      <Header
        extra={
          // Printed for the record (STYLEGUIDE §Print): the controls stay
          // off the paper, here and on the Request card and the row actions.
          <div className="contents print:hidden">
            {can.manage && (
              <Button variant="secondary" href="/compliance/settings" icon={<Settings2 />}>
                Settings
              </Button>
            )}
            {can.export && (
              // A plain anchor: a Link would prefetch the download, and every
              // export is an audit row.
              <a href="/api/admin/compliance?format=csv" className={buttonClass("secondary")}>
                <Download className="h-4 w-4" aria-hidden /> Export CSV
              </a>
            )}
          </div>
        }
      />

      <div className="space-y-5">
        {/* KPIs */}
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {[
            { icon: <FileCheck className="h-4 w-4" />, label: "Policies requiring confirmation", value: k.policies },
            { icon: <Percent className="h-4 w-4" />, label: "Overall compliance", value: `${k.pct}%` },
            { icon: <Users className="h-4 w-4" />, label: "Fully compliant people", value: `${k.users_compliant}/${k.users_total}` },
            { icon: <CircleAlert className="h-4 w-4" />, label: "Outstanding confirmations", value: k.outstanding },
          ].map((c) => (
            <div key={c.label} className="rounded-xl border border-slate-200 bg-surface p-4 shadow-xs">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-compass-50 text-compass-600">
                {c.icon}
              </span>
              <div className="mt-2 text-2xl font-bold tracking-tight text-slate-900">{c.value}</div>
              <div className="text-xs text-slate-500">{c.label}</div>
            </div>
          ))}
        </div>

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
                onClick={() => void requestConfirmation()}
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
        <Card title="Policy progress" icon={<FileCheck />} padding="none">
          {data.docs.length === 0 ? (
            <SectionEmpty className="px-4 py-8 text-center">
              {can.manage
                ? "No documents require read confirmation yet. Request one above."
                : "No documents require read confirmation yet."}
            </SectionEmpty>
          ) : (
            <ul className="divide-y divide-slate-100">
              {data.docs.map((d) => {
                const pct = d.required ? Math.round((d.acked / d.required) * 100) : 100;
                const complete = d.acked >= d.required;
                const roster = rosters[d.id];
                return (
                  <li key={d.id}>
                    <div className="flex flex-wrap items-center gap-3 px-4 py-3">
                      <div className="min-w-0 flex-1">
                        <button
                          type="button"
                          onClick={() => void toggleRoster(d.id)}
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
                              onClick={() => void remind(d)}
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
                                dropRoster(d.id);
                                void load();
                              }}
                            />
                          )}
                          {can.manage && (
                            <Button
                              variant="secondary"
                              size="sm"
                              icon={<ShieldOff />}
                              onClick={() => void stopRequiring(d)}
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
        </Card>

        {/* Per-person standing */}
        <Card title="People" icon={<Users />} padding="none">
          {peopleRows.length === 0 ? (
            <SectionEmpty className="px-4 py-6">
              No one has a confirmation pending or recorded yet.
            </SectionEmpty>
          ) : (
            <>
              {peoplePager && <div className="border-b border-slate-100 px-4 py-2">{peoplePager}</div>}
              <Table scroll>
                <thead className={TABLE_HEAD_ROW}>
                  <tr>
                    <Th>Person</Th>
                    <Th fit align="right">
                      Required
                    </Th>
                    <Th fit align="right">
                      Confirmed
                    </Th>
                    <Th fit align="right">
                      Standing
                    </Th>
                  </tr>
                </thead>
                <tbody>
                  {pageOf(peopleRows, peoplePage, PEOPLE_PAGE).map((u) => (
                    <tr key={u.id} className={TR}>
                      <Td className="font-medium text-slate-700">
                        {u.name || u.username}
                        <span className="ml-1.5 text-xs font-normal text-slate-500">{u.role}</span>
                      </Td>
                      <Td fit align="right" className="text-slate-500">
                        {u.required}
                      </Td>
                      <Td fit align="right" className="text-slate-600">
                        {u.acked}
                      </Td>
                      <Td fit align="right">
                        {u.acked >= u.required ? (
                          <span className={chipClass("ok")}>
                            <Check className="h-3 w-3" aria-hidden /> Compliant
                          </span>
                        ) : (
                          <span className={chipClass("warn")}>
                            <CircleAlert className="h-3 w-3" aria-hidden /> {u.required - u.acked} outstanding
                          </span>
                        )}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
              {peoplePager && <div className="border-t border-slate-100 px-4 py-2">{peoplePager}</div>}
            </>
          )}
        </Card>
      </div>
    </div>
  );
}

function Header({ extra }: { extra?: React.ReactNode }) {
  return (
    <PageHeader
      icon={<ShieldCheck />}
      title={
        <>
          Compliance{" "}
          <EnterpriseBadge />
        </>
      }
      subtitle="Read-confirmation progress across every policy: who has confirmed what, and who still owes a confirmation."
      actions={extra}
      className="mb-5"
    />
  );
}
