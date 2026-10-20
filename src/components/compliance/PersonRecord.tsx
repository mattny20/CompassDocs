"use client";

// The per-person compliance record (F3, 1.14.0): everything one person must
// confirm, has confirmed and was told, on one printable page with a CSV
// beside it. The server page (/compliance/person/[id], `me` for the viewer)
// applies the four-way rule through userPolicyTranscript and renders the
// header; this component renders the body from the JSON the route answers:
//
//   Current requirements: the Record tab's evidence columns per policy
//     (Policy, Set, Status, Assigned with its source, Due, Confirmed,
//     Version, Signed, Read time, Reached end, IP where the viewer may see
//     it, Exemption), one row per open or exempt assignment on a live
//     policy.
//   Prior confirmations (n): superseded confirmations with what replaced
//     them, closed assignments ("Required 1 Mar to 30 Sep (left
//     Engineering)") and rows on retired policies.
//   Notices (n): the person's notice log (E3): when, what kind, which
//     policy, which channels, by whom.
//   Actions (compliance.program_manage, off paper): Remind about everything
//     outstanding (one reminder per outstanding policy through the team
//     route, until the bulk route lands), Ask to re-confirm…, Exempt from…,
//     Extend… and Remove exemption, each a menu over the policies it
//     applies to, asking in the roster's words (AckRoster's dialogs) and
//     posting to the admin assignments route; admins who may erase also see
//     Anonymise compliance record… (C5's question, verbatim from Users).
//
// A lead or a space roster reader sees only the rows their scope admits
// (the filter ran in SQL) and one line counting the policies they can't
// view. The page prints as evidence: controls are print:hidden and a footer
// names who generated it, when, and the CompassDocs version.

import { useCallback, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { BellRing, CalendarPlus, ChevronDown, PenLine, RotateCcw, UserCheck, UserMinus, UserX } from "lucide-react";
import { Button, buttonClass } from "@/components/Button";
import { Card } from "@/components/Card";
import { chipClass } from "@/components/Chip";
import { confirmDialog } from "@/components/Dialog";
import { SectionEmpty } from "@/components/form";
import { SectionHeading } from "@/components/Heading";
import { Popover, MenuItem } from "@/components/Popover";
import { useFormatDate } from "@/components/SettingsProvider";
import { Table, Th, Td, TABLE_HEAD_ROW, TR } from "@/components/Table";
import { toast } from "@/components/Toasts";
import { Tooltip } from "@/components/Tooltip";
import { dayIn, exemptDialog, extendDialog, reaskDialog, today } from "@/components/AckRoster";
import { exemptionText, snoozeText } from "@/lib/ack-assignments";
import type { AssignmentAction } from "@/lib/ack-assignments";
import { readTimeLabel, supersededByText } from "@/lib/read-evidence";
import { useAction } from "@/lib/use-action";
import type { NoticeRow, PolicyTranscript, PolicyTranscriptRow } from "@/lib/db";

/** What the viewer may do on this record (the server page decides). */
export interface RecordAbilities {
  /** compliance.program_manage: the Actions section. */
  manage: boolean;
  /** The team route's rule (compliance.team_read, or a lead with the setting on): Remind sends. */
  remind: boolean;
  /** user.delete and compliance.program_manage, on someone else's record: Anonymise compliance record…. */
  anonymise: boolean;
}

const ASSIGNMENTS = "/api/admin/compliance/assignments";

/** The tooltip on "(inferred)" (A1); the footnote under the table repeats it because the table scrolls sideways. */
const INFERRED_TIP = "Version inferred from the confirmation time; confirmations before 1.10.0 did not record it";
const INFERRED_NOTE =
  "Confirmations before 1.10.0 did not record the version; where a version is marked (inferred) it is the one that was current at the time of the confirmation.";
const EVIDENCE_NOTE =
  "Read time is how long the document was open on screen for this person since they were last asked, summed from view tracking when they confirmed; it is not proof of comprehension. Reached end is what the reader's own browser reported. Confirmations before 1.11.0 recorded neither.";

/** What the signature was checked against (lib/attestation IdentityProof), in words. */
const IDENTITY_PROOF: Record<string, string> = {
  password: "password",
  sso_session: "SSO session",
  typed_name_only: "typed name",
};

/** The notice kinds (lib/types AckNoticeKind) as the chip reads them. */
const NOTICE_KIND: Record<string, string> = {
  request: "Request",
  reminder: "Reminder",
  updated: "Re-confirmation notice",
  due: "Due",
  overdue: "Overdue",
  escalation: "Escalation",
  welcome: "Welcome",
  digest: "Weekly digest",
};

const CHANNEL: Record<string, string> = { inapp: "in-app", email: "email", webhook: "webhook" };

/** "5 policies" / "1 policy". */
function policies(n: number): string {
  return `${n} ${n === 1 ? "policy" : "policies"}`;
}

/** How the person came to owe the policy (policy_assignments.source), after the assignment date. */
function sourceText(r: PolicyTranscriptRow): string {
  switch (r.source) {
    case "space":
      return r.space_name ? `everyone in ${r.space_name} space` : "everyone in the space";
    case "group":
      return "group";
    case "new_member":
      return "new joiner";
    case "set":
      return r.set_names.length > 0 ? `${r.set_names[0]} set` : "set";
    case "user":
      return "named";
    case "role":
      return "role";
    case "recert":
      return "re-confirmation cycle";
    case "manual":
      return "manual";
    default:
      return "";
  }
}

/** The status chip (STYLEGUIDE §Status chips: the closed set), with "Asked again {date}" beside it on a row re-asked and not yet confirmed. */
function StatusChip({ row, date }: { row: PolicyTranscriptRow; date: (iso: string | null) => string }) {
  const chip =
    row.status === "exempt" ? (
      <span className={chipClass("neutral")}>Exempt</span>
    ) : row.status === "confirmed" ? (
      <span className={chipClass("ok")}>Confirmed</span>
    ) : row.status === "overdue" ? (
      <span className={chipClass("error")}>Overdue</span>
    ) : row.status === "pending" ? (
      <span className={chipClass("warn")}>Pending</span>
    ) : (
      <span className={chipClass("neutral")}>Superseded</span>
    );
  const askedAgain =
    (row.status === "pending" || row.status === "overdue") &&
    row.asked_again_at &&
    Boolean(row.asked_again_reason || row.asked_again_by);
  if (!askedAgain) return chip;
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {chip}
      <span className={chipClass("warn")}>Asked again {date(row.asked_again_at)}</span>
    </span>
  );
}

/** "v12", with "(inferred)" in text and its tooltip on rows from before 1.10.0. */
function VersionCell({ row }: { row: PolicyTranscriptRow }) {
  if (!row.version) return null;
  if (row.version_source === "inferred") {
    return (
      <span className="inline-flex items-center gap-1.5">
        v{row.version}
        <span className="text-xs text-slate-500" data-tt={INFERRED_TIP} data-tt-wrap tabIndex={0}>
          (inferred)
        </span>
      </span>
    );
  }
  return <>v{row.version}</>;
}

/** The typed name behind a pen, then what it was checked against; nothing on an unsigned or pending row. */
function SignedCell({ row }: { row: PolicyTranscriptRow }) {
  if (!row.acknowledged_at || !row.signed_name) return null;
  const proof = row.identity_proof ? IDENTITY_PROOF[row.identity_proof] ?? row.identity_proof : "";
  return (
    <span className="inline-flex items-center gap-1.5">
      <PenLine className="h-3.5 w-3.5 shrink-0 text-slate-400" aria-hidden />
      {row.signed_name}
      {proof && <span className="text-xs text-slate-500">{proof}</span>}
    </span>
  );
}

/** The policy's title as a link to the document; plain when the policy is gone. */
function PolicyLink({ row }: { row: PolicyTranscriptRow }) {
  const title = row.title || "(untitled)";
  if (row.document_id === null) return <span className="font-medium text-slate-800">{title}</span>;
  return (
    <Link href={`/doc/${row.document_id}`} className="font-medium text-slate-800 hover:text-compass-700">
      {title}
    </Link>
  );
}

/** The Exemption column, plain text (the roster's rule): the exemption, else a re-ask's reason and asker; a running snooze after either. */
function exemptionNote(r: PolicyTranscriptRow, date: (iso: string) => string, now: Date): string {
  const parts: string[] = [];
  if (r.exempt) parts.push(exemptionText(r, date));
  else if (r.asked_again_at && !r.acknowledged_at && r.asked_again_reason) {
    parts.push([r.asked_again_reason, r.asked_again_by].filter(Boolean).join(" · "));
  }
  if (!r.exempt && r.snoozed_until && new Date(r.snoozed_until).getTime() > now.getTime()) {
    parts.push(snoozeText(r, date));
  }
  return parts.filter(Boolean).join(" · ");
}

/** What a history row says about itself: the successor, the closed span, or nothing (the chips say the rest). */
function historyText(r: PolicyTranscriptRow, date: (iso: string | null) => string): string {
  if (r.record === "superseded") {
    return r.superseded_by ? `Superseded by: ${supersededByText(r.superseded_by, (iso) => date(iso))}` : "Superseded";
  }
  if (r.record === "closed") {
    const reason = r.removed_reason ? ` (${r.removed_reason.replace(/_/g, " ")})` : "";
    return `Required ${date(r.assigned_at)} to ${date(r.removed_at)}${reason}`;
  }
  return "";
}

/** What the two action routes answer (lib/ack-assignment-actions AssignmentAnswer). */
interface ActionAnswer {
  action: AssignmentAction;
  changed: number[];
  skipped: number[];
  until: string | null;
}

/**
 * One action's menu: a secondary button that opens a Popover role="menu"
 * listing the policies the action applies to (STYLEGUIDE §Overlays). With
 * nothing to list the button is disabled inside a Tooltip saying why.
 */
function PolicyMenu({
  id,
  label,
  icon,
  items,
  empty,
  busy,
  onPick,
}: {
  id: string;
  label: string;
  icon: React.ReactNode;
  items: PolicyTranscriptRow[];
  /** The tooltip while there is nothing to pick. */
  empty: string;
  busy: boolean;
  onPick: (row: PolicyTranscriptRow) => void;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setOpen(false), []);
  const none = items.length === 0;
  const button = (
    <button
      ref={trigger}
      type="button"
      aria-haspopup="menu"
      aria-expanded={open}
      disabled={busy || none}
      onClick={() => setOpen((o) => !o)}
      className={buttonClass("secondary", "md")}
    >
      <span className="shrink-0 [&>svg]:h-4 [&>svg]:w-4" aria-hidden>
        {icon}
      </span>
      {label} <ChevronDown className="h-4 w-4" aria-hidden />
    </button>
  );
  return (
    <div className="relative">
      {none ? <Tooltip label={empty}>{button}</Tooltip> : button}
      <Popover open={open} onClose={close} triggerRef={trigger} role="menu" label={label} width="w-80">
        {items.map((row) => (
          <MenuItem
            key={`${id}-${row.assignment_id}`}
            onClick={() => {
              setOpen(false);
              onPick(row);
            }}
          >
            {row.title}
            {row.version ? ` · v${row.version}` : ""}
          </MenuItem>
        ))}
      </Popover>
    </div>
  );
}

export function PersonRecord({
  transcript,
  can,
  viewerName,
  version,
  generatedAt,
}: {
  transcript: PolicyTranscript;
  can: RecordAbilities;
  /** The viewer, for the print footer. */
  viewerName: string;
  /** CompassDocs' version, for the print footer. */
  version: string;
  /** When the page was rendered (ISO), for the print footer. */
  generatedAt: string;
}) {
  const fmt = useFormatDate();
  const { run, busy } = useAction();
  const { person, current, history, notices, hidden } = transcript;
  const name = person.name || person.username;
  // One clock per render of the rows: the snooze text and the menus agree.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const now = useMemo(() => new Date(), [current]);

  const date = (iso: string | null | undefined) => (iso ? fmt.date(iso) : "");
  const dateTime = (iso: string | null | undefined) => (iso ? fmt.dateTime(iso) : "");

  const showIp = current.some((r) => r.ip !== null);
  const anyConfirmed = [...current, ...history].some((r) => r.acknowledged_at);
  const anyInferred = [...current, ...history].some((r) => r.version && r.version_source === "inferred");

  // What each action applies to (the roster's rule): an open row can be
  // extended and reminded, a confirmed one re-asked, any non-exempt row
  // exempted, an exempt one released.
  const withId = (r: PolicyTranscriptRow) => r.assignment_id !== null;
  const outstanding = current.filter((r) => withId(r) && (r.status === "pending" || r.status === "overdue"));
  const confirmed = current.filter((r) => withId(r) && r.status === "confirmed");
  const exemptable = current.filter((r) => withId(r) && !r.exempt);
  const exempted = current.filter((r) => withId(r) && r.exempt);

  // ── The actions (D2, D4; the roster's flows for one person and one policy) ──

  const post = useCallback(
    async (key: string, body: Record<string, unknown>, fallback: string): Promise<ActionAnswer | null> => {
      const box: { result?: Partial<ActionAnswer> } = {};
      const ok = await run(
        key,
        async () => {
          const res = await fetch(ASSIGNMENTS, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          });
          if (res.ok) box.result = (await res.clone().json().catch(() => ({}))) as Partial<ActionAnswer>;
          return res;
        },
        { fallback }
      );
      if (!ok) return null;
      return {
        action: body.action as AssignmentAction,
        changed: box.result?.changed ?? [],
        skipped: box.result?.skipped ?? [],
        until: box.result?.until ?? null,
      };
    },
    [run]
  );

  /** Nothing changed (every id came back skipped): the row moved under the manager's feet. */
  const changedOne = (r: ActionAnswer | null, nothing: string): boolean => {
    if (!r) return false;
    if (r.changed.length === 0) {
      toast("error", nothing);
      return false;
    }
    return true;
  };

  async function exemptWith(row: PolicyTranscriptRow, reason: string, until: string | null, opts: { undo?: boolean } = {}) {
    const id = row.assignment_id!;
    const r = await post(`exempt-${id}`, { action: "exempt", assignment_ids: [id], reason, until }, "Couldn't record the exemption.");
    if (!changedOne(r, `Nothing changed: ${name} is already exempt from "${row.title}" or no longer asked.`)) return;
    const text = `Exempted ${name} from "${row.title}"`;
    if (opts.undo) {
      toast("ok", text);
      return;
    }
    toast("ok", text, { action: { label: "Undo", onClick: () => void unexempt(row, { undo: true }) } });
  }

  async function exempt(row: PolicyTranscriptRow) {
    // Awaited before anything is busy (STYLEGUIDE §Overlays): Cancel leaves the page idle.
    const asked = await exemptDialog(name, `"${row.title}"`);
    if (!asked) return;
    await exemptWith(row, asked.reason, asked.until);
  }

  async function unexempt(row: PolicyTranscriptRow, opts: { undo?: boolean } = {}) {
    const id = row.assignment_id!;
    const r = await post(`unexempt-${id}`, { action: "unexempt", assignment_ids: [id] }, "Couldn't remove the exemption.");
    if (!changedOne(r, `Nothing changed: ${name} is not exempt from "${row.title}".`)) return;
    if (opts.undo) {
      toast("ok", `Exemption undone: ${name} is pending again.`);
      return;
    }
    // Undo exempts again with the same reason and end date, read in the
    // workspace zone (the roster's rule), never a UTC slice of the stamp.
    const day = row.exempt_until ? dayIn(row.exempt_until, fmt.settings.timezone) : null;
    const until = day && day > today() ? day : null;
    toast("ok", `Removed the exemption for ${name}: pending again with a fresh due date.`, {
      action: { label: "Undo", onClick: () => void exemptWith(row, row.exempt_reason || "Exemption restored", until, { undo: true }) },
    });
  }

  async function extend(row: PolicyTranscriptRow) {
    const asked = await extendDialog(1, `${name} · "${row.title}"`);
    if (!asked) return;
    const id = row.assignment_id!;
    const r = await post(
      `extend-${id}`,
      { action: "extend", assignment_ids: [id], days: asked.days, reason: asked.reason },
      "Couldn't extend the due date."
    );
    if (!changedOne(r, `Nothing changed: "${row.title}" is no longer open for ${name}.`)) return;
    const by = `${asked.days} ${asked.days === 1 ? "day" : "days"}`;
    toast("ok", `Extended the deadline for ${name} by ${by}`, {
      action: {
        label: "Undo",
        onClick: () =>
          void post(`undo-extend-${id}`, { action: "undo_extend", assignment_ids: [id] }, "Couldn't undo the extension.").then((u) => {
            if (changedOne(u, "Nothing changed: the extension was already undone.")) {
              toast("ok", `Extension undone: the deadline for ${name} is back to its previous date.`);
            }
          }),
      },
    });
  }

  async function reask(row: PolicyTranscriptRow) {
    const reason = await reaskDialog({ one: { name, rev: row.version }, count: 1, title: row.title });
    if (reason === null) return;
    const id = row.assignment_id!;
    const r = await post(`reask-${id}`, { action: "reask", assignment_ids: [id], reason }, "Couldn't ask to re-confirm.");
    if (!changedOne(r, `Nobody was asked: ${name} is exempt or no longer asked to confirm "${row.title}".`)) return;
    // No Undo: the notice is already on its way (the spec offers none).
    toast("ok", `${name} will be asked to re-confirm.`);
  }

  /**
   * Remind about everything outstanding: one reminder per open policy
   * through the team route (one person, the policy's own cadence, audited),
   * until the bulk route bundles them into one notice. Sending mail asks
   * first (STYLEGUIDE §Feedback). A policy refused inside its cadence is
   * reported in the toast, not retried.
   */
  async function remindAll() {
    if (outstanding.length === 0) return;
    const ok = await confirmDialog({
      title: `Remind ${name} about ${policies(outstanding.length)}?`,
      body: "One reminder per outstanding policy goes out now. A policy reminded inside its cadence is skipped.",
      confirmLabel: "Send reminders",
    });
    if (ok !== true) return;
    let sent = 0;
    const problems: string[] = [];
    await run(
      "remind",
      async () => {
        for (const row of outstanding) {
          const res = await fetch("/api/compliance/team", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ assignment_id: row.assignment_id }),
          });
          if (res.ok) sent++;
          else {
            const data = (await res.json().catch(() => ({}))) as { error?: string };
            problems.push(data?.error || `Couldn't remind about "${row.title}".`);
          }
        }
        if (sent > 0) return;
        // Nothing went out: the first refusal is the toast, through run()'s own path.
        return new Response(JSON.stringify({ error: problems[0] ?? "Couldn't send the reminders." }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      },
      { fallback: "Couldn't send the reminders." }
    );
    if (sent > 0) {
      toast("ok", `Reminded ${name} about ${policies(sent)}.${problems.length > 0 ? ` ${problems[0]}` : ""}`);
    }
  }

  // The erasure path (C5): the Users page's question, verbatim, so the two
  // surfaces cannot drift. Irreversible, so it asks with the username typed.
  async function anonymise() {
    const ok = await confirmDialog({
      title: `Anonymise ${name}'s compliance record?`,
      body: `Replaces this person's name, email and IP address on every confirmation and decision record with "Former staff #${person.id}". Counts, dates, versions and hashes stay. Audit log entries are kept as recorded. This cannot be undone.`,
      confirmLabel: "Anonymise record",
      danger: true,
      typeToConfirm: person.username,
    });
    if (ok !== true) return;
    await run("anonymise", () => fetch(`/api/admin/users/${person.id}/anonymise-compliance`, { method: "POST" }), {
      fallback: "Couldn't anonymise the compliance record.",
      ok: "Compliance record anonymised.",
    });
  }

  const remindButton = (
    <Button
      variant="secondary"
      icon={<BellRing />}
      busy={busy}
      disabled={!can.remind || outstanding.length === 0}
      onClick={() => void remindAll()}
      data-tt={can.remind && outstanding.length > 0 ? "Send a reminder for each outstanding policy now" : undefined}
      data-tt-wrap={can.remind && outstanding.length > 0 ? "" : undefined}
    >
      Remind about everything outstanding
    </Button>
  );

  return (
    <div>
      {hidden > 0 && (
        // A lead or a roster reader: the rows outside their scope never left
        // the database; only their number did.
        <p className="mb-4 text-sm text-slate-500">
          {policies(hidden)} you can&apos;t view
        </p>
      )}

      <section aria-labelledby="record-current">
        <SectionHeading id="record-current">Current requirements</SectionHeading>
        <Card padding="none">
          {current.length === 0 ? (
            <SectionEmpty className="px-4 py-6">
              {hidden > 0 ? "No current requirements in the spaces you can read." : "No current requirements."}
            </SectionEmpty>
          ) : (
            <Table scroll minWidth={showIp ? "96rem" : "88rem"}>
              <thead className={TABLE_HEAD_ROW}>
                <tr>
                  <Th>Policy</Th>
                  <Th>Set</Th>
                  <Th fit>Status</Th>
                  <Th>Assigned</Th>
                  <Th fit>Due</Th>
                  <Th fit>Confirmed</Th>
                  <Th fit>Version</Th>
                  <Th fit>Signed</Th>
                  <Th fit>Read time</Th>
                  <Th fit>Reached end (self-reported)</Th>
                  {showIp && <Th fit>IP</Th>}
                  <Th>Exemption</Th>
                </tr>
              </thead>
              <tbody>
                {current.map((r) => (
                  <tr key={r.assignment_id ?? `${r.document_id}`} className={TR}>
                    <Td>
                      <PolicyLink row={r} />
                      {r.space_name && <span className="ml-2 text-xs text-slate-500">{r.space_name}</span>}
                    </Td>
                    <Td className="text-slate-500">{r.set_names.join(", ")}</Td>
                    <Td fit>
                      <StatusChip row={r} date={date} />
                    </Td>
                    <Td className="text-slate-500">
                      {date(r.assigned_at)}
                      {sourceText(r) && <span className="ml-1.5 text-xs">{sourceText(r)}</span>}
                    </Td>
                    {/* The deadline is an instant: the instant formatter in the
                        viewer's zone; blank on an exempt row (none applies). */}
                    <Td fit className="text-slate-500">
                      {r.due_at && !r.exempt ? date(r.due_at) : ""}
                    </Td>
                    <Td fit className="text-slate-500">
                      {dateTime(r.acknowledged_at)}
                    </Td>
                    <Td fit className="text-slate-500">
                      <VersionCell row={r} />
                    </Td>
                    <Td fit className="text-slate-700">
                      <SignedCell row={r} />
                    </Td>
                    <Td fit className="text-slate-500">
                      {r.acknowledged_at ? readTimeLabel(r.read_seconds) : ""}
                    </Td>
                    <Td fit className="text-slate-500">
                      {r.acknowledged_at ? (r.reached_end ? "yes" : "no") : ""}
                    </Td>
                    {showIp && (
                      <Td fit className="text-slate-500">
                        {r.ip ?? ""}
                      </Td>
                    )}
                    <Td className="text-slate-500">{exemptionNote(r, (iso) => fmt.date(iso), now)}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
        {anyConfirmed && <p className="mt-3 text-xs text-slate-500">{EVIDENCE_NOTE}</p>}
        {anyInferred && <p className="mt-3 text-xs text-slate-500">{INFERRED_NOTE}</p>}
      </section>

      <section aria-labelledby="record-history" className="mt-8">
        <SectionHeading id="record-history">Prior confirmations ({history.length})</SectionHeading>
        <p className="-mt-2 mb-3 text-xs text-slate-500">
          Confirmations a later cycle replaced, assignments that ended, and policies since retired.
        </p>
        <Card padding="none">
          {history.length === 0 ? (
            <SectionEmpty className="px-4 py-6">No prior confirmations.</SectionEmpty>
          ) : (
            <Table scroll minWidth="64rem">
              <thead className={TABLE_HEAD_ROW}>
                <tr>
                  <Th>Policy</Th>
                  <Th>Record</Th>
                  <Th fit>Confirmed</Th>
                  <Th fit>Version</Th>
                  <Th fit>Signed</Th>
                </tr>
              </thead>
              <tbody>
                {history.map((r, i) => (
                  <tr key={`${r.record}-${r.assignment_id ?? "a"}-${r.version_id ?? "v"}-${r.acknowledged_at ?? i}`} className={TR}>
                    <Td>
                      <PolicyLink row={r} />
                      {r.space_name && <span className="ml-2 text-xs text-slate-500">{r.space_name}</span>}
                    </Td>
                    <Td className="text-slate-600">
                      <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
                        {historyText(r, date) && <span>{historyText(r, date)}</span>}
                        {r.record === "closed" && r.status === "exempt" && <span className={chipClass("neutral", "sm")}>Exempt</span>}
                        {r.retired_at && <span className={chipClass("neutral", "sm")}>Retired {date(r.retired_at)}</span>}
                        {r.purged && <span className={chipClass("neutral", "sm")}>Policy removed</span>}
                      </span>
                    </Td>
                    <Td fit className="text-slate-500">
                      {dateTime(r.acknowledged_at)}
                    </Td>
                    <Td fit className="text-slate-500">
                      <VersionCell row={r} />
                    </Td>
                    <Td fit className="text-slate-700">
                      <SignedCell row={r} />
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      </section>

      <section aria-labelledby="record-notices" className="mt-8">
        <SectionHeading id="record-notices">Notices ({notices.length})</SectionHeading>
        <Card padding="none">
          {notices.length === 0 ? (
            <SectionEmpty className="px-4 py-6">No notices sent yet.</SectionEmpty>
          ) : (
            <Table scroll minWidth="56rem">
              <thead className={TABLE_HEAD_ROW}>
                <tr>
                  <Th fit>Sent</Th>
                  <Th fit>Kind</Th>
                  <Th>Policy</Th>
                  <Th fit>Channels</Th>
                  <Th fit>By</Th>
                </tr>
              </thead>
              <tbody>
                {notices.map((n: NoticeRow) => (
                  <tr key={n.id} className={TR}>
                    <Td fit className="text-slate-500">
                      {dateTime(n.sent_at)}
                    </Td>
                    <Td fit>
                      <span className={chipClass("neutral")}>{NOTICE_KIND[n.kind] ?? n.kind}</span>
                    </Td>
                    <Td>
                      {n.document_id !== null ? (
                        <Link href={`/doc/${n.document_id}`} className="font-medium text-slate-800 hover:text-compass-700">
                          {n.document_title}
                        </Link>
                      ) : (
                        <span className="font-medium text-slate-800">{n.document_title}</span>
                      )}
                    </Td>
                    <Td fit className="text-slate-500">
                      {n.channels.map((c) => CHANNEL[c] ?? c).join(" · ")}
                    </Td>
                    <Td fit className="text-slate-500">
                      {n.by_name}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      </section>

      {can.manage && (
        <section aria-labelledby="record-actions" className="mt-8 print:hidden">
          <SectionHeading id="record-actions">Actions</SectionHeading>
          <Card>
            <p className="mb-3 text-sm text-slate-500">
              Each action asks before it sends or changes anything; reversible ones offer Undo in the toast.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              {can.remind ? (
                outstanding.length === 0 ? (
                  <Tooltip label="Nothing is outstanding.">{remindButton}</Tooltip>
                ) : (
                  remindButton
                )
              ) : (
                <Tooltip label="Reminding one person needs the Read team policies permission.">{remindButton}</Tooltip>
              )}
              <PolicyMenu
                id="reask"
                label="Ask to re-confirm…"
                icon={<RotateCcw />}
                items={confirmed}
                empty="No current confirmation to lapse."
                busy={busy}
                onPick={(row) => void reask(row)}
              />
              <PolicyMenu
                id="exempt"
                label="Exempt from…"
                icon={<UserMinus />}
                items={exemptable}
                empty="Nothing to exempt from."
                busy={busy}
                onPick={(row) => void exempt(row)}
              />
              <PolicyMenu
                id="extend"
                label="Extend…"
                icon={<CalendarPlus />}
                items={outstanding}
                empty="No open deadline to extend."
                busy={busy}
                onPick={(row) => void extend(row)}
              />
              {exempted.length > 0 && (
                <PolicyMenu
                  id="unexempt"
                  label="Remove exemption"
                  icon={<UserCheck />}
                  items={exempted}
                  empty="No exemption to remove."
                  busy={busy}
                  onPick={(row) => void unexempt(row)}
                />
              )}
              {can.anonymise && anyConfirmed && (
                <Button
                  variant="danger"
                  icon={<UserX />}
                  busy={busy}
                  onClick={() => void anonymise()}
                  data-tt="Replace their name, email and IP on every attestation record; counts, dates, versions and hashes stay"
                  data-tt-wrap=""
                >
                  Anonymise compliance record…
                </Button>
              )}
            </div>
          </Card>
        </section>
      )}

      {/* The printed record says who generated it and when (STYLEGUIDE §Print). */}
      <p className="mt-6 hidden text-xs text-slate-500 print:block">
        Generated {fmt.dateTime(generatedAt)} by {viewerName} · CompassDocs {version}
      </p>
    </div>
  );
}
