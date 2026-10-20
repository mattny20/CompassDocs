import "server-only";
import { notify, notifyPrefAllows } from "./notifications";
import { getSmtpConfig, smtpConfigured } from "./smtp-config";
import { sendMail } from "./mailer";
import { renderEmail } from "./email-templates";
import {
  pool,
  getNotifyPrefsFor,
  insertAckOutbox,
  claimAckOutbox,
  claimAckReminder,
  touchAckOutbox,
  retireAbandonedAckOutbox,
  completeAckOutbox,
  failAckOutbox,
  ackNoticeDocument,
  ackNoticeRecipients,
  recentAckNoticeUserIds,
  ackNoticesForOutbox,
  rekeyAckNotices,
  insertAckNotices,
  addAckNoticeChannel,
  ackNoticeCoalesces,
  stampAckDecisionsNotified,
  setAckRequired,
  setAckLastReminded,
  compliancePendingUsers,
  claimDueRecertifications,
  claimAckReminders,
  claimAckEscalations,
  escalationRecipients,
  expireExemptions,
  reconcileAllPolicies,
  getUserById,
  listOwedPoliciesFor,
  ackNoticeIdsFor,
} from "./db";
import type { AckOutboxInput, AckNoticeInput, AckActor, Queryable, ClaimedAckOutboxRow, AckSweepDefaults, EscalationVia } from "./db";
// Reminders and escalation (E2): the cadence words and the notices' copy.
import { featureEnabled } from "./ee";
import {
  bundleBody,
  bundleList,
  bundleTitle,
  dueLine,
  dueNoticeBody,
  dueNoticeTitle,
  dueStatusLabel,
  escalationBody,
  escalationList,
  escalationTitle,
} from "./ack-remind";
import type { DayFormatter } from "./ack-remind";
import { RECERT_LEDGER_REASON } from "./ack-recert";
// Deadlines (E1): the cascade's layers, the per-recipient due dates for the
// notices and the "Also move existing deadlines" writer.
import { cache } from "react";
import { policyDefaultLayers, assignmentDueDates, moveDeadlines } from "./db";
import { getComplianceSettings } from "./compliance-settings";
import { getAppSettings } from "./settings-store";
import { formatDate } from "./format";
import { DUE_NUMBER_KEYS, daysLeft, dueLineFor, dueSuffixFor, resolveDefaults } from "./ack-due";
import type { DueRule, PolicyDefaultsLayer, ResolvedDefaults } from "./ack-due";
import type { AckNoticeMode, AckNoticeChannel, AckNoticeKind, AckSource } from "./types";
import { auditAck } from "./audit";
import type { AckAuditAction } from "./audit";

// Read-confirmation notices (1.10.1, E3 + H4 + H1).
//
// Nothing on a request path sends anything. A route, a save or a sweep
// queues one row in ack_outbox (enqueueAckNotice, or resetAcknowledgements
// inside its own transaction); the minute tick drains the queue
// (deliverAckNotices) with an atomic claim, so every instance may run it and
// no row is delivered twice; notifyAckRequest is the worker that renders the
// email once, writes the inbox rows and posts personal webhooks, writes one
// ack_notices row per person with the channels reached so far, then sends
// mail one recipient at a time and adds 'email' to the row per accepted
// mail (recordNotices and addAckNoticeChannel are the only writers of that
// table). The record is written before the slow part and the claim is kept
// fresh during it (touchAckOutbox), so a reclaim means a dead instance, and
// the instance that reclaims resumes from the record: people an earlier
// attempt reached in-app are emailed only, never told twice. A failed
// delivery keeps its row for a retry after the ten-minute reclaim, up to
// three attempts; the third failure closes the row with its error.
//
// The links' origin is the custom_domain setting when there is one, else
// the origin of the request that queued the row (stored on it): nothing is
// remembered across requests, so no request header can steer another
// person's notice.
//
// Compliance emails deliberately do NOT honor the personal notification-email
// switch: a read-confirmation request is a workplace requirement, not a
// courtesy update. The per-kind email preference (Account → Notifications →
// Read confirmations → Email) is honored and the record shows it: a row whose
// channels lack 'email' for that reason reads "email opted out".

export type { AckOutboxInput, AckNoticeInput } from "./db";

/** sendMail's shape; tests inject one, production uses the SMTP settings. */
export type Mailer = (to: string[], subject: string, text: string, html?: string) => Promise<void>;

/** People who already heard about this document in this way within the window, and did not confirm since, are not told again (H1), except by manual and recurrence sources. */
export const ACK_NOTICE_COALESCE_HOURS = 24;
/** A row that failed this many times is closed with its error, audited ack.notice_failed and never claimed again. */
export const ACK_NOTICE_MAX_ATTEMPTS = 3;
/** The lease heartbeat runs after this many recipients inside the mail and webhook loops. */
export const ACK_NOTICE_HEARTBEAT_EVERY = 10;
/** Advisory-lock class for serialising the portal's Request per document (pg_advisory_xact_lock(class, document id)). */
const ACK_REQUEST_LOCK_CLASS = 710101;

async function defaultMailer(): Promise<Mailer | null> {
  return smtpConfigured(await getSmtpConfig()) ? sendMail : null;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// --- Writers -----------------------------------------------------------------

/**
 * Queue a fan-out. `client` is the caller's transaction client (a reset
 * queues inside its own transaction, so a rolled-back approval or merge
 * tells nobody) or null for the pool. Returns the outbox row id; delivery
 * happens within a minute of not_before.
 */
export async function enqueueAckNotice(client: Queryable | null, row: AckOutboxInput): Promise<number> {
  return insertAckOutbox(client, row);
}

/** Append rows to the per-person notice log. Called by the drain and by the digests, never by a route. */
export async function recordNotices(rows: AckNoticeInput[]): Promise<number[]> {
  return insertAckNotices(rows);
}

/**
 * The portal's Request, as one call (F7/A8 call it): the document starts
 * requiring read confirmation and, when `notify` is on, everyone pending is
 * told through the outbox and the reminder stamp starts the one-hour Remind
 * cooldown. Only the call that actually switched the requirement on queues
 * the notice: two Requests at once (a double submit, two managers, the
 * portal and the popover) queue one, and the loser answers `switched_on:
 * false, queued: 0` (the routes' existing "already asks" answer). A quiet
 * switch-on (notify off, as the Undo after "Stop requiring" does) stamps
 * nothing, so Remind is not blocked for an hour when nobody was told.
 * `queued` is how many people are pending now; the drain resolves the list
 * again at delivery. No audit row here: the route writes
 * document.ack_required and the drain writes ack.requested with the real
 * counts. `origin` is the sending request's, kept on the row for the links.
 */
export async function requestAcknowledgement(
  doc: { id: number; title: string },
  actor: AckActor,
  origin: string,
  opts: { notify: boolean }
): Promise<{ queued: number; outbox_id: number | null; switched_on: boolean }> {
  // setAckRequired's switched_on cannot tell two concurrent calls apart on
  // its own: its before-value comes from the statement's snapshot, so both
  // see "off" (verified under READ COMMITTED). The calls for one document
  // are therefore serialised on a transaction-scoped advisory lock: the
  // second one's UPDATE starts after the first committed and reports the
  // requirement already on. The transaction only scopes the lock; every
  // write below runs on the pool as before.
  const lock = await pool().connect();
  try {
    await lock.query("BEGIN");
    await lock.query("SELECT pg_advisory_xact_lock($1::int, $2::int)", [ACK_REQUEST_LOCK_CLASS, doc.id]);
    const { switched_on } = await setAckRequired(doc.id, true);
    if (!switched_on || !opts.notify) return { queued: 0, outbox_id: null, switched_on };
    const pending = await compliancePendingUsers(doc.id);
    const outboxId = await insertAckOutbox(null, {
      document_id: doc.id,
      mode: "request",
      source: "manual",
      actor,
      user_ids: null,
      origin,
    });
    await setAckLastReminded(doc.id);
    return { queued: pending.length, outbox_id: outboxId, switched_on: true };
  } finally {
    await lock.query("COMMIT").catch(() => {});
    lock.release();
  }
}

/**
 * The portal's Remind: queue a reminder for everyone still pending. The
 * one-hour cooldown stamp is the claim (one UPDATE sets it and tests it),
 * so two clicks in the same second queue one reminder; `claimed: false`
 * means the hour had not passed (the route answers 429) or the document no
 * longer takes confirmations. No audit row here (the drain writes
 * ack.reminder_sent). `origin` is the sending request's, kept on the row.
 */
export async function enqueueReminder(
  doc: { id: number; title: string },
  actor: AckActor,
  origin: string
): Promise<{ queued: number; outbox_id: number | null; claimed: boolean }> {
  if (!(await claimAckReminder(doc.id))) return { queued: 0, outbox_id: null, claimed: false };
  const pending = await compliancePendingUsers(doc.id);
  const outboxId = await insertAckOutbox(null, {
    document_id: doc.id,
    mode: "reminder",
    source: "manual",
    actor,
    user_ids: null,
    origin,
  });
  return { queued: pending.length, outbox_id: outboxId, claimed: true };
}

// --- Copy --------------------------------------------------------------------

export type RequestLabel = "Action required" | "Reminder" | "Updated" | "Annual re-confirmation";

export interface NoticeCopy {
  /** The {{request_label}} tag and the subject's first words. */
  label: RequestLabel;
  /** The {{request_type}} tag: "{{requester_name}} {{request_type}} that you read and confirm:". */
  requestType: string;
  /** In-app title and body (the sidebar bell, personal webhooks). */
  title: string;
  body: string;
  /** The {{change_note}} and {{reason}} tags; at most one is non-blank. */
  changeNote: string;
  reason: string;
}

function formatDay(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

/**
 * One place for every sentence a notice can carry (H1). 'updated' from a
 * text change names what changed; from a manual re-ask the body is the
 * person's reason; from the recurrence sweep (G1, later) the sweep passes
 * its sentence as the reason. The due clause appears only when E1 (later)
 * supplies a date. No em-dashes.
 */
export function noticeCopy(input: {
  mode: AckNoticeMode;
  source?: AckSource | "" | null;
  docTitle: string;
  actorName: string;
  reason?: string | null;
  dueAt?: string | null;
  /** The due date already formatted the workspace's way (the drain passes it); formatDay(dueAt) otherwise. */
  dueText?: string | null;
  /** A 'welcome' notice (D1): how many policies the new account owes and their titles (the first three are named). */
  count?: number;
  titles?: string[];
}): NoticeCopy {
  const t = input.docTitle;
  const who = input.actorName || "Someone";
  const by = input.dueText ? ` by ${input.dueText}` : input.dueAt ? ` by ${formatDay(input.dueAt)}` : "";
  const note = (input.reason ?? "").trim();
  switch (input.mode) {
    case "updated": {
      if (input.source === "recurrence") {
        return {
          label: "Annual re-confirmation",
          requestType: "asks again",
          title: `Please re-confirm "${t}"`,
          body: note || `Annual re-confirmation: please read and confirm "${t}" again${by}.`,
          changeNote: "",
          reason: note,
        };
      }
      if (input.source === "manual") {
        return {
          label: "Action required",
          requestType: "asks again",
          title: `Please re-confirm "${t}"`,
          body: note || `${who} asks you to read and confirm "${t}" again${by}.`,
          changeNote: "",
          reason: note,
        };
      }
      return {
        label: "Updated",
        requestType: "changed the document and asks again",
        title: `Changed. Please re-confirm "${t}"`,
        body: `${who} changed "${t}"${note ? `: ${note}` : ""}. Please read the changes and confirm again${by}.`,
        changeNote: note,
        reason: "",
      };
    }
    case "due":
      // The sweep's automatic reminder (E2): the drain words each person's
      // own notice from their row (deliverDue); this is the one-date shape.
      return {
        label: "Reminder",
        requestType: "sent a reminder",
        title: dueNoticeTitle(t, input.dueAt ?? null, false),
        body: input.dueAt ? `Due ${input.dueText || formatDay(input.dueAt)}.` : dueNoticeBody(t, null),
        changeNote: "",
        reason: "",
      };
    case "reminder":
    case "overdue":
    case "escalation":
      return {
        label: "Reminder",
        requestType: "sent a reminder",
        title: `Reminder: confirm "${t}"`,
        body: `You still need to read and confirm "${t}"${by}.`,
        changeNote: "",
        reason: "",
      };
    case "welcome": {
      // One notice for everything a new account owes (D1): the first three
      // titles, then "and n more"; the due dates are on My policies.
      const titles = input.titles ?? [];
      const n = input.count ?? titles.length;
      const named = titles
        .slice(0, 3)
        .map((x) => `"${x}"`)
        .join(", ");
      const more = n > 3 ? ` and ${n - 3} more` : "";
      return {
        label: "Action required",
        requestType: "requested",
        title: `Welcome: ${n} ${n === 1 ? "policy" : "policies"} to read`,
        body: `Please read and confirm ${named ? `${named}${more}` : "your policies"}. Each one shows its due date on My policies.`,
        changeNote: "",
        reason: "",
      };
    }
    case "request":
    default:
      return {
        label: "Action required",
        requestType: "requested",
        title: `Action required: confirm "${t}"`,
        body: `Please read and confirm "${t}"${by}.`,
        changeNote: "",
        reason: "",
      };
  }
}

/** The audit key the drain writes when a delivery completes. */
function auditActionFor(mode: AckNoticeMode, source: AckSource | "" | null): AckAuditAction {
  switch (mode) {
    case "updated":
      return source === "recurrence" ? "ack.recert" : "ack.reset_notified";
    case "reminder":
    case "overdue":
      return "ack.reminder_sent";
    case "due":
      return "ack.reminder_auto";
    case "escalation":
      return "ack.escalated";
    case "request":
    case "welcome":
    default:
      return "ack.requested";
  }
}

// --- The worker --------------------------------------------------------------

export interface NotifyAckInput {
  docId: number;
  docTitle: string;
  mode: AckNoticeMode;
  source?: AckSource | "" | null;
  reason?: string | null;
  /**
   * People to reach on every channel they allow. `noticeId` is set when an
   * earlier attempt wrote their row but reached nothing (channels []): the
   * channels go onto that row instead of a new one. `due_at` is the
   * person's own due date (their assignment row, E1): the due tags and the
   * "by {date}" clause are theirs, and people with different dates get
   * different renderings of the one notice. Absent or null: `dueAt` below.
   */
  users: { id: number; name: string; email: string; noticeId?: number; due_at?: string | null }[];
  /** People an earlier attempt reached in-app but could not email: email only, then the channel is added to their row. */
  resumeEmail?: { id: number; name: string; email: string; noticeId: number; due_at?: string | null }[];
  requesterId: number | null;
  requesterName: string;
  /** Absolute origin for the links; '' leaves them relative. */
  origin: string;
  /** Omit for the SMTP settings; null for no email at all; a function to inject one (tests). */
  mailer?: Mailer | null;
  outboxId?: number | null;
  dueAt?: string | null;
  /** The lease heartbeat (the drain's touchAckOutbox), run every `heartbeatEvery` recipients inside the slow loops. */
  heartbeat?: () => Promise<void>;
  heartbeatEvery?: number;
}

export interface NotifyAckResult {
  /** Mails the server accepted in this call (fresh and resumed). */
  emailed: number;
  /** ack_notices rows written in this call. */
  noticed: number;
  /** One line per failure (a template that would not render, an inbox that took no rows, a mail the server refused). Non-empty = the outbox row is retried. */
  errors: string[];
  channels: Map<number, AckNoticeChannel[]>;
}

/**
 * Deliver one notice to a set of people and record it per person. Renders
 * the email once, writes the inbox rows and posts personal webhooks through
 * notify(), writes the record (one ack_notices row per fresh person with
 * the channels reached so far, even an empty list when nothing could reach
 * them), then sends mail one recipient at a time (per-kind email preference
 * honored; the master switch is not, see the header) and adds 'email' to
 * each person's row as the server accepts the mail. A failure never stops
 * the loop: it is reported in `errors` so the drain can retry the row, and
 * the retry resumes from the notice log instead of repeating.
 */
export async function notifyAckRequest(input: NotifyAckInput): Promise<NotifyAckResult> {
  const link = `/doc/${input.docId}#confirm-reading`;
  const origin = input.origin || "";
  const url = `${origin}${link}`;
  const mailer = input.mailer === undefined ? await defaultMailer() : input.mailer;
  const every = Math.max(1, input.heartbeatEvery ?? ACK_NOTICE_HEARTBEAT_EVERY);
  const heartbeat = input.heartbeat ?? (async () => {});
  const errors: string[] = [];
  const channels = new Map<number, AckNoticeChannel[]>();

  // The due date is each recipient's own (E1): the drain reads it off their
  // assignment row; a caller without rows may pass one date for everyone.
  // Dates are formatted the workspace's way (its date format and time
  // zone), the same way the Due chips show them.
  const settings = await getAppSettings();
  const fmtDue = (iso: string) => formatDate(iso, settings);
  const dueOf = (u: { due_at?: string | null }) => u.due_at ?? input.dueAt ?? null;
  const copyFor = (dueAt: string | null) =>
    noticeCopy({
      mode: input.mode,
      source: input.source,
      docTitle: input.docTitle,
      actorName: input.requesterName,
      reason: input.reason,
      dueAt,
      dueText: dueAt ? fmtDue(dueAt) : null,
    });

  // One rendering per distinct due date, on first use: people who share a
  // date share a mail, and a workspace with one rule renders once as
  // before. A template that will not render is a failure to retry, not a
  // reason to skip the inbox: people still see the bell, and the row comes
  // back for the email. The free-text tags (title, names, change note,
  // reason) are rendered as written, never as markdown or HTML: the
  // template marks them as text.
  const mails = new Map<string, { subject: string; text: string; html: string } | null>();
  const mailFor = async (dueAt: string | null) => {
    const key = dueAt ?? "";
    if (mails.has(key)) return mails.get(key)!;
    let mail: { subject: string; text: string; html: string } | null = null;
    if (mailer) {
      try {
        const copy = copyFor(dueAt);
        const left = dueAt ? daysLeft(dueAt, new Date(), settings.timezone) : null;
        mail = await renderEmail(
          "ack_request",
          {
            requester_name: input.requesterName || "CompassDocs",
            doc_title: input.docTitle,
            doc_url: url,
            request_type: copy.requestType,
            request_label: copy.label,
            change_note: copy.changeNote,
            reason: copy.reason,
            due_date: dueAt ? fmtDue(dueAt) : "",
            due_line: dueLineFor(dueAt, fmtDue),
            due_suffix: dueSuffixFor(dueAt, fmtDue),
            days_left: left === null ? "" : String(Math.max(0, left)),
          },
          origin
        );
      } catch (e) {
        console.error("Ack email render failed:", e);
        errors.push(`Email template: ${errorMessage(e)}`);
      }
    }
    mails.set(key, mail);
    return mail;
  };

  // In-app and webhook, for the people not yet reached, one fan-out per
  // distinct due date (the body says "by {date}"). An inbox that took no
  // rows is a delivery failure like a refused mail: the row comes back and
  // these people (their row says nothing reached them) are fed to notify()
  // again on the retry.
  const fresh = input.users;
  for (const u of fresh) channels.set(u.id, []);
  const byDue = new Map<string, typeof fresh>();
  for (const u of fresh) {
    const key = dueOf(u) ?? "";
    const group = byDue.get(key);
    if (group) group.push(u);
    else byDue.set(key, [u]);
  }
  for (const [key, group] of byDue) {
    const copy = copyFor(key || null);
    try {
      const reached = await notify(
        group.map((u) => u.id),
        {
          kind: "ack_requested",
          title: copy.title,
          body: copy.body,
          link,
          actorName: input.requesterName,
          origin,
        },
        { heartbeat, heartbeatEvery: every }
      );
      for (const id of reached.inboxIds) channels.get(id)?.push("inapp");
      for (const id of reached.webhookIds) channels.get(id)?.push("webhook");
      if (reached.inboxError) errors.push(`Inbox: ${reached.inboxError}`);
    } catch (e) {
      console.error("Ack inbox notifications failed:", e);
      errors.push(`Inbox: ${errorMessage(e)}`);
    }
  }

  // The record, before the slow part: one row per fresh person with what
  // reached them so far, so an instance that takes these rows over after
  // this one died resumes with the email instead of repeating the inbox. A
  // person whose row already exists (nothing reached them last time) gets
  // the channels added to it. 'email' is added per accepted mail below.
  const noticeIdOf = new Map<number, number>();
  const newRows = fresh.filter((u) => u.noticeId == null);
  const ids = await recordNotices(
    newRows.map((u) => ({
      user_id: u.id,
      user_name: u.name,
      user_email: u.email,
      document_id: input.docId,
      document_title: input.docTitle,
      kind: input.mode,
      channels: channels.get(u.id) ?? [],
      by_user_id: input.requesterId,
      by_name: input.requesterName || "system",
      outbox_id: input.outboxId ?? null,
    }))
  );
  newRows.forEach((u, i) => noticeIdOf.set(u.id, ids[i]));
  for (const u of fresh) {
    if (u.noticeId == null) continue;
    noticeIdOf.set(u.id, u.noticeId);
    for (const ch of channels.get(u.id) ?? []) await addAckNoticeChannel(u.noticeId, ch);
  }
  const resume = input.resumeEmail ?? [];
  for (const r of resume) noticeIdOf.set(r.id, r.noticeId);

  // Email, one at a time: fresh recipients and the ones a failed attempt
  // left without. Skip anyone who turned the ack email channel off. The
  // error line names the person by id, never by address: it lands in the
  // queue's error column, which no erasure path rewrites.
  const targets = [...fresh, ...resume];
  let emailed = 0;
  if (mailer && targets.length > 0) {
    const prefs = await getNotifyPrefsFor(targets.map((u) => u.id)).catch(
      () => new Map<number, Record<string, Record<string, boolean>>>()
    );
    let attempted = 0;
    for (const target of targets) {
      if (!target.email) continue;
      if (!notifyPrefAllows(prefs.get(target.id), "ack_requested", "email")) continue;
      const mail = await mailFor(dueOf(target));
      if (!mail) continue;
      try {
        await mailer([target.email], mail.subject, mail.text, mail.html);
        emailed++;
        channels.get(target.id)?.push("email");
        const noticeId = noticeIdOf.get(target.id);
        if (noticeId != null) await addAckNoticeChannel(noticeId, "email");
      } catch (e) {
        console.error(`Ack email to user #${target.id} failed:`, e);
        errors.push(`Email to user #${target.id}: ${errorMessage(e)}`);
      }
      if (++attempted % every === 0) await heartbeat();
    }
  }

  return { emailed, noticed: ids.length, errors, channels };
}

// --- The drain ---------------------------------------------------------------

export interface DeliverOptions {
  /** Absolute origin for links in emails and webhooks: the custom_domain setting from the tick. When empty, each row's own origin (the request that queued it) is used. */
  origin?: string;
  /** Omit for the SMTP settings; null for no email; a function to inject one (tests). */
  mailer?: Mailer | null;
  /** Rows to claim per call (default 20). */
  limit?: number;
  /** Claim only rows for these documents (tests sharing one database; a targeted re-delivery). The tick passes nothing. */
  documentIds?: number[];
  /** Recipients between lease heartbeats (default ACK_NOTICE_HEARTBEAT_EVERY; tests pass 1). */
  heartbeatEvery?: number;
}

export interface DeliverResult {
  claimed: number;
  /** Deliveries that completed (a merged group of 'updated' rows counts once). */
  delivered: number;
  /** Deliveries left for a retry, or closed on their last failure. */
  failed: number;
  /** Rows closed because an instance died on their last attempt (not claimed by this call). */
  retired: number;
}

/**
 * Rows of mode 'updated' for the same document, with no explicit list, are
 * one delivery that keeps the latest reason (the rows are claimed in id
 * order, so the last of a group is the newest). Everything else is its own.
 */
function groupOutbox(rows: ClaimedAckOutboxRow[]): ClaimedAckOutboxRow[][] {
  const groups: ClaimedAckOutboxRow[][] = [];
  const updated = new Map<number, ClaimedAckOutboxRow[]>();
  for (const r of rows) {
    if (r.mode === "updated" && r.user_ids === null && r.document_id != null) {
      const g = updated.get(r.document_id);
      if (g) {
        g.push(r);
        continue;
      }
      const fresh = [r];
      updated.set(r.document_id, fresh);
      groups.push(fresh);
    } else {
      groups.push([r]);
    }
  }
  return groups;
}

interface GroupOutcome {
  /** False when the policy no longer takes confirmations (gone, trashed, unpublished, requirement off): the rows are closed and nobody is told. */
  deliverable: boolean;
  pending: number;
  skippedRecent: number;
  emailed: number;
  noticed: number;
  errors: string[];
  /** 'due' rows only (E2): recipients told in a bundle instead of this row's own notice. */
  bundled?: number;
}

async function deliverGroup(
  group: ClaimedAckOutboxRow[],
  primary: ClaimedAckOutboxRow,
  ctx: { origin: string; mailer: Mailer | null; heartbeat: () => Promise<void>; heartbeatEvery?: number }
): Promise<GroupOutcome> {
  const none: GroupOutcome = { deliverable: false, pending: 0, skippedRecent: 0, emailed: 0, noticed: 0, errors: [] };
  // A welcome (D1) names a person, not a policy: its list is resolved at
  // delivery and the row's document is only the one it is keyed to.
  if (primary.mode === "welcome") return deliverWelcome(group, primary, ctx);
  const doc = primary.document_id != null ? await ackNoticeDocument(primary.document_id) : undefined;
  if (!doc || !doc.deliverable) return none;

  const ids = group.map((r) => r.id);
  // The record of an earlier attempt follows the group's newest row, which
  // outlives the rest (see rekeyAckNotices), so it is found however the
  // group has shrunk since.
  await rekeyAckNotices(ids, primary.id);
  // Recipients are resolved now, not at enqueue: a person who confirmed in
  // the meantime is not told. Then minus the people an earlier attempt of
  // these rows already reached (a retry resumes), and, for sources that
  // coalesce, minus anyone who heard about this document in this way in
  // the last 24 hours and did not confirm since (a manual or recurrence
  // row in the group turns the coalescing off for the whole group: those
  // always deliver).
  // Each person's due date rides along from their assignment row (E1), so
  // the mail and the inbox line say "by {their date}".
  const dues = await assignmentDueDates(doc.id, primary.user_ids);
  const recipients = (await ackNoticeRecipients(doc.id, primary.user_ids)).map((u) => ({ ...u, due_at: dues.get(u.id) ?? null }));
  const already = await ackNoticesForOutbox(ids);
  const coalesce = group.every((r) => ackNoticeCoalesces(r.source));
  const recent = coalesce
    ? await recentAckNoticeUserIds(doc.id, primary.mode, ACK_NOTICE_COALESCE_HOURS)
    : new Set<number>();
  // Fresh: no row from these rows yet and not told today; or a row that
  // says nothing reached them, which is fed again onto that row.
  const fresh = recipients
    .filter((u) => {
      const had = already.get(u.id);
      return had ? had.channels.length === 0 : !recent.has(u.id);
    })
    .map((u) => (already.has(u.id) ? { ...u, noticeId: already.get(u.id)!.id } : u));
  const resume = recipients
    .filter((u) => {
      const had = already.get(u.id);
      return Boolean(had && had.channels.length > 0 && !had.channels.includes("email"));
    })
    .map((u) => ({ ...u, noticeId: already.get(u.id)!.id }));
  const skippedRecent = recipients.filter((u) => !already.has(u.id) && recent.has(u.id)).length;

  const r = await notifyAckRequest({
    docId: doc.id,
    docTitle: doc.title,
    mode: primary.mode,
    source: primary.source,
    reason: primary.reason,
    users: fresh,
    resumeEmail: resume,
    requesterId: primary.actor_id,
    requesterName: primary.actor_name,
    origin: ctx.origin || primary.origin || "",
    mailer: ctx.mailer,
    outboxId: primary.id,
    heartbeat: ctx.heartbeat,
    heartbeatEvery: ctx.heartbeatEvery,
  });
  return {
    deliverable: true,
    pending: recipients.length,
    skippedRecent,
    emailed: r.emailed,
    noticed: r.noticed,
    errors: r.errors,
  };
}

/**
 * Drain the outbox: close the rows an instance died on during their last
 * attempt (audited ack.notice_failed, since no claim would ever see them
 * again), then claim up to `limit` due rows atomically (one UPDATE with
 * FOR UPDATE SKIP LOCKED in its subquery; rows claimed over ten minutes
 * ago by a dead instance are taken again; three failed attempts close a
 * row), deliver each group with the batch's claim kept fresh before each
 * group and inside the slow loops, then close the rows with the real
 * counts and write the audit entry (ack.requested, ack.reminder_sent,
 * ack.reset_notified, ack.recert or ack.escalated by mode) with
 * {pending, emailed, noticed, skipped_recent}. A delivery with any failure
 * keeps its rows with the error; the third failure closes them and is
 * audited ack.notice_failed. Runs from the minute tick in
 * instrumentation.ts, gated on the policy_ack entitlement there; safe to
 * run from every instance at once.
 */
export async function deliverAckNotices(opts: DeliverOptions = {}): Promise<DeliverResult> {
  const out: DeliverResult = { claimed: 0, delivered: 0, failed: 0, retired: 0 };
  for (const row of await retireAbandonedAckOutbox(opts.documentIds)) {
    out.retired++;
    const doc = row.document_id != null ? await ackNoticeDocument(row.document_id).catch(() => undefined) : undefined;
    await auditAck("ack.notice_failed", doc ?? { id: row.document_id ?? 0, title: "" }, {
      actor: { id: row.actor_id, name: row.actor_name || "system" },
      source: row.source || null,
      reason: row.reason,
      details: {
        mode: row.mode,
        outbox_id: row.id,
        attempts: row.attempts,
        emailed: row.emailed,
        noticed: row.noticed,
        error: row.error,
      },
    });
  }

  const rows = await claimAckOutbox(opts.limit ?? 20, opts.documentIds);
  out.claimed = rows.length;
  if (rows.length === 0) return out;
  const mailer = opts.mailer === undefined ? await defaultMailer() : opts.mailer;
  // The lease covers the whole batch: a group late in the batch is as old
  // as the claim by the time its turn comes, so every heartbeat refreshes
  // every row still open in this call.
  const open = new Set(rows.map((r) => r.id));
  const heartbeat = () => touchAckOutbox([...open]);

  // The sweep's rows (E2): a person named on more than three 'due' rows of
  // this batch is told once, before the rows go out one by one; the plan
  // says who was bundled per row and what failed for them.
  let sweep: SweepCtx | null = null;
  let bundles: DueBundlePlan = { bundled: new Map(), errors: new Map() };
  if (rows.some((r) => r.mode === "due" || r.mode === "escalation")) {
    const settings = await getAppSettings();
    sweep = {
      origin: opts.origin ?? "",
      mailer,
      heartbeat,
      every: Math.max(1, opts.heartbeatEvery ?? ACK_NOTICE_HEARTBEAT_EVERY),
      fmt: (iso) => formatDate(iso, settings),
    };
    await heartbeat();
    bundles = await planDueBundles(rows, sweep);
  }

  for (const group of groupOutbox(rows)) {
    const ids = group.map((r) => r.id);
    const primary = group[group.length - 1];
    const attempts = Math.max(...group.map((r) => r.attempts));
    const retire = attempts >= ACK_NOTICE_MAX_ATTEMPTS;
    const actor = { id: primary.actor_id, name: primary.actor_name || "system" };
    const docRef = { id: primary.document_id ?? 0, title: "" };
    try {
      await heartbeat();
      const outcome =
        sweep && primary.mode === "due"
          ? await deliverDue(primary, bundles, sweep)
          : sweep && primary.mode === "escalation"
            ? await deliverEscalation(primary, sweep)
            : await deliverGroup(group, primary, {
                origin: opts.origin ?? "",
                mailer,
                heartbeat,
                heartbeatEvery: opts.heartbeatEvery,
              });
      if (!outcome.deliverable) {
        await completeAckOutbox(ids);
        out.delivered++;
        continue;
      }
      const doc = (await ackNoticeDocument(primary.document_id!)) ?? docRef;
      if (outcome.errors.length > 0) {
        const error = `${outcome.errors.length} failure(s); last: ${outcome.errors[outcome.errors.length - 1]}`;
        await failAckOutbox(ids, error, { retire });
        out.failed++;
        if (retire) {
          await auditAck("ack.notice_failed", doc, {
            actor,
            source: primary.source || null,
            reason: primary.reason,
            details: {
              mode: primary.mode,
              outbox_id: primary.id,
              attempts,
              pending: outcome.pending,
              emailed: outcome.emailed,
              noticed: outcome.noticed,
              error,
            },
          });
        }
        continue;
      }
      const counts = await completeAckOutbox(ids);
      out.delivered++;
      await auditAck(auditActionFor(primary.mode, primary.source), doc, {
        actor,
        source: primary.source || null,
        reason: primary.reason,
        details: {
          mode: primary.mode,
          outbox_id: primary.id,
          merged: ids.length,
          attempts,
          pending: outcome.pending,
          emailed: counts.emailed,
          noticed: counts.noticed,
          skipped_recent: outcome.skippedRecent,
          ...(outcome.bundled !== undefined ? { bundled: outcome.bundled } : {}),
        },
      });
      if (primary.mode === "updated" && primary.document_id != null) {
        const since = group.map((r) => r.not_before).sort()[0];
        await stampAckDecisionsNotified(primary.document_id, since).catch((e) =>
          console.error("[ack] could not stamp notified_at:", e)
        );
      }
    } catch (e) {
      const error = errorMessage(e);
      console.error(`[ack] notice delivery for outbox ${ids.join(",")} failed:`, e);
      await failAckOutbox(ids, error, { retire }).catch(() => {});
      out.failed++;
      if (retire) {
        const doc = primary.document_id != null ? await ackNoticeDocument(primary.document_id).catch(() => undefined) : undefined;
        await auditAck("ack.notice_failed", doc ?? docRef, {
          actor,
          source: primary.source || null,
          reason: primary.reason,
          details: { mode: primary.mode, outbox_id: primary.id, attempts, error },
        });
      }
    } finally {
      for (const id of ids) open.delete(id);
    }
  }
  return out;
}

// --- Deadlines and the defaults cascade (E1, 1.13.0) -----------------------------
//
// policy_settings -> spaces.policy_defaults -> ack_defaults -> BUILT_IN. The
// pure rule is resolveDefaults in lib/ack-due; here the layers are read from
// the database. A page, a route and the sweeps all resolve through these.

/**
 * The workspace layer of the cascade: ack_defaults' seven numbers, only the
 * ones an admin set (null = the built-in). Read once per request (the
 * settings reader is React-cached) and once per sweep, then passed into the
 * SQL claims as their COALESCE fallbacks.
 */
export async function workspaceDueDefaults(): Promise<PolicyDefaultsLayer> {
  const { ack_defaults } = await getComplianceSettings();
  const out: PolicyDefaultsLayer = {};
  for (const key of DUE_NUMBER_KEYS) if (ack_defaults[key] != null) out[key] = ack_defaults[key];
  return out;
}

export interface ResolvedPolicyDefaults extends ResolvedDefaults {
  /** The policy's own deadline rule (both null = inherit), for the Deadline card's radio. */
  rule: DueRule;
  /** The policy's space, for "Inherit (14 days, from Security space)"; null when the document is gone. */
  space: { id: number; name: string } | null;
}

/**
 * One policy's effective values and where each came from ('policy' |
 * 'space' | 'workspace' | 'built-in'), read once per request (React
 * cache(), the approvalMode pattern): the Settings tab's hints, the
 * ack-settings GET, the reader's chips and the roster all share the answer.
 * A document that is gone resolves to the workspace and built-in layers
 * with `space` null, so a caller need not test for it.
 */
export const resolvePolicyDefaults = cache(async (docId: number): Promise<ResolvedPolicyDefaults> => {
  const [layers, workspace] = await Promise.all([policyDefaultLayers(docId), workspaceDueDefaults()]);
  const resolved = resolveDefaults({ policy: layers?.policy, space: layers?.space.defaults, workspace });
  return {
    ...resolved,
    rule: layers?.rule ?? { due_days: null, due_at: null },
    space: layers ? { id: layers.space.id, name: layers.space.name } : null,
  };
});

/**
 * "Also move existing deadlines" (E1): recompute every open row of the
 * policy from `rule` as it now stands (lib/db moveDeadlines: the fixed date
 * while ahead, else each row's cycle start plus the days, the cascade
 * filling an inherited number; due_history keeps the old and new dates)
 * and write ack.due_moved {policy, n, from_rule, to_rule}. `fromRule` is
 * what the policy had before the save, as the route read it. The toast's
 * Undo is undoExtension over the returned ids.
 */
export async function movePolicyDeadlines(
  doc: { id: number; title: string },
  rule: DueRule,
  opts: { fromRule?: DueRule | null; actor: AckActor; ip?: string | null; reason?: string }
): Promise<{ moved: number; ids: number[] }> {
  const [resolved, settings] = await Promise.all([resolvePolicyDefaults(doc.id), getAppSettings()]);
  const r = await moveDeadlines(doc.id, rule, {
    dueDays: resolved.values.due_days,
    timeZone: settings.timezone,
    actor: opts.actor,
    reason: opts.reason,
  });
  await auditAck("ack.due_moved", doc, {
    actor: opts.actor,
    ip: opts.ip,
    details: { policy: doc.id, n: r.moved, from_rule: opts.fromRule ?? null, to_rule: rule },
  });
  return r;
}

// --- The re-confirmation sweep (G1, 1.12.0) -------------------------------------

/**
 * Fire every re-confirmation cycle that is due (the hourly tick in
 * instrumentation.ts, gated on the policy_ack entitlement there; safe to
 * run from every instance at once). One atomic claim in lib/db
 * (claimDueRecertifications) moves each due policy's marker, next date and
 * reminder stamp, writes its 'reset' ledger row from source 'recurrence' and
 * queues one immediate 'updated' notice carrying the months-since sentence;
 * here each cycle is echoed to the audit log as ack.recert {version_id,
 * reset, eligible} by the system (the drain writes a second ack.recert when
 * the notice has gone out, with the delivery counts). Returns how many
 * cycles fired. `documentIds` limits the sweep (tests sharing a database).
 */
export async function recertifyDueAcks(
  opts: { documentIds?: number[]; defaults?: PolicyDefaultsLayer | null; timeZone?: string } = {}
): Promise<{ cycles: number }> {
  // The people's clocks restart with the cycle (E1): the claim re-arms every
  // open row from the cascade, with the workspace layer loaded once here
  // (complianceHourly may pass the one it loaded for the whole tick).
  const defaults = opts.defaults === undefined ? await workspaceDueDefaults() : opts.defaults;
  const timeZone = opts.timeZone ?? (await getAppSettings()).timezone;
  const cycles = await claimDueRecertifications(null, { documentIds: opts.documentIds, defaults, timeZone });
  for (const c of cycles) {
    await auditAck("ack.recert", { id: c.document_id, title: c.title }, {
      actor: { id: null, name: "system" },
      version_id: c.version_id,
      version: c.rev,
      source: "recurrence",
      reason: RECERT_LEDGER_REASON,
      details: {
        reset: c.confirmations_reset,
        eligible: c.eligible,
        recert_months: c.recert_months,
        decision_id: c.decision_id,
        outbox_id: c.outbox_id,
        rearmed: c.rearmed,
      },
    });
  }
  return { cycles: cycles.length };
}

// --- The welcome notice (D1, 1.13.0) ---------------------------------------------
//
// A new account enrolled in several policies at once (autoAssignPolicies in
// lib/db, from createUser, scimCreateUser and createSsoUser) is told once:
// one 'welcome' outbox row naming the person, keyed to the first policy
// (the row goes with it; a claim filtered by document finds it), delivered
// below with the ack_welcome template. The list is resolved at delivery
// (listOwedPoliciesFor: what they still owe at the tick), so a policy
// confirmed or retired in the two minutes between is not named. A single
// policy goes the usual way, as a 'request' row for that person alone. The
// record is one ack_notices row per policy named, kind 'welcome', so each
// policy's log shows the person was told; a retry adds the email channel
// to every one of them. The per-kind email preference (Read confirmations)
// is honoured like every other notice of the family.

/**
 * Queue the welcome for one person. Answers the outbox row id, or null when
 * there is nothing to say. `origin` is the sending request's when there is
 * one; a provisioning hook has none and the drain falls back to the
 * workspace's custom_domain for the links.
 */
export async function notifyWelcome(userId: number, policies: { id: number }[], origin = ""): Promise<number | null> {
  if (policies.length === 0) return null;
  return insertAckOutbox(null, {
    document_id: policies[0].id,
    mode: policies.length === 1 ? "request" : "welcome",
    source: "",
    user_ids: [userId],
    origin,
  });
}

async function deliverWelcome(
  group: ClaimedAckOutboxRow[],
  primary: ClaimedAckOutboxRow,
  ctx: { origin: string; mailer: Mailer | null; heartbeat: () => Promise<void> }
): Promise<GroupOutcome> {
  const none: GroupOutcome = { deliverable: false, pending: 0, skippedRecent: 0, emailed: 0, noticed: 0, errors: [] };
  const userId = primary.user_ids?.[0];
  if (userId == null) return none;
  const person = await getUserById(userId);
  if (!person || person.status !== "active") return none;
  const policies = await listOwedPoliciesFor(userId);
  if (policies.length === 0) return none;

  const ids = group.map((r) => r.id);
  await rekeyAckNotices(ids, primary.id);
  // An earlier attempt's record: nothing to do once the mail went; email
  // only when the inbox was reached; everything when nothing reached them.
  const already = (await ackNoticesForOutbox(ids)).get(userId);
  const out: GroupOutcome = { deliverable: true, pending: 1, skippedRecent: 0, emailed: 0, noticed: 0, errors: [] };
  if (already && already.channels.includes("email")) return out;

  const origin = ctx.origin || primary.origin || "";
  const link = "/compliance";
  const url = `${origin}${link}`;
  const settings = await getAppSettings();
  const fmt = (iso: string) => formatDate(iso, settings);
  const copy = noticeCopy({
    mode: "welcome",
    docTitle: "",
    actorName: primary.actor_name,
    count: policies.length,
    titles: policies.map((p) => p.title),
  });
  const errors: string[] = [];

  let mail: { subject: string; text: string; html: string } | null = null;
  if (ctx.mailer) {
    try {
      mail = await renderEmail(
        "ack_welcome",
        {
          count: String(policies.length),
          policy_list: policies.map((p) => `- ${p.title}${p.due_at ? ` (due ${fmt(p.due_at)})` : ""}`).join("\n"),
          portal_url: url,
        },
        origin
      );
    } catch (e) {
      console.error("Welcome email render failed:", e);
      errors.push(`Email template: ${errorMessage(e)}`);
    }
  }

  // In-app and webhook, unless an earlier attempt reached them there.
  const channels: AckNoticeChannel[] = [];
  if (!already || already.channels.length === 0) {
    try {
      const reached = await notify(
        [userId],
        { kind: "ack_requested", title: copy.title, body: copy.body, link, actorName: primary.actor_name, origin },
        { heartbeat: ctx.heartbeat }
      );
      if (reached.inboxIds.includes(userId)) channels.push("inapp");
      if (reached.webhookIds.includes(userId)) channels.push("webhook");
      if (reached.inboxError) errors.push(`Inbox: ${reached.inboxError}`);
    } catch (e) {
      console.error("Welcome inbox notification failed:", e);
      errors.push(`Inbox: ${errorMessage(e)}`);
    }
  }

  // The record, one row per policy named, before the slow part.
  let noticeIds: number[];
  if (!already) {
    noticeIds = await recordNotices(
      policies.map((p) => ({
        user_id: userId,
        user_name: person.name,
        user_email: person.email,
        document_id: p.id,
        document_title: p.title,
        kind: "welcome" as const,
        channels: [...channels],
        by_user_id: primary.actor_id,
        by_name: primary.actor_name || "system",
        outbox_id: primary.id,
      }))
    );
    out.noticed = noticeIds.length;
  } else {
    noticeIds = await ackNoticeIdsFor(primary.id, userId);
    for (const id of noticeIds) for (const ch of channels) await addAckNoticeChannel(id, ch);
  }

  if (mail && person.email) {
    const prefs = await getNotifyPrefsFor([userId]).catch(() => new Map<number, Record<string, Record<string, boolean>>>());
    if (notifyPrefAllows(prefs.get(userId), "ack_requested", "email")) {
      try {
        await ctx.mailer!([person.email], mail.subject, mail.text, mail.html);
        out.emailed = 1;
        for (const id of noticeIds) await addAckNoticeChannel(id, "email");
      } catch (e) {
        console.error(`Welcome email to user #${userId} failed:`, e);
        errors.push(`Email to user #${userId}: ${errorMessage(e)}`);
      }
    }
  }
  out.errors = errors;
  return out;
}

// --- The sweeps' deliveries (E2, 1.13.0) -----------------------------------------
//
// 'due' and 'escalation' rows are the hourly sweep's (remindDueAcks and
// escalateOverdueAcks below). They are delivered here rather than through
// notifyAckRequest: their words are each person's own (their due date, due
// soon or overdue), their inbox kind and email template are their own
// (ack_due / ack_escalation, honouring the matching per-kind email choice
// and, like every compliance mail, ignoring the master switch), and a
// person named on more than three 'due' rows of one batch is told once,
// "You have 5 policies to confirm", across all of them. The record is the
// same as every other notice: one ack_notices row per person and policy,
// written before the mail goes out, resumed from on a retry (people an
// earlier attempt reached in-app are emailed only, never told twice).

/** A person is bundled when more than this many 'due' rows of one batch name them. */
export const DUE_BUNDLE_OVER = 3;

interface SweepCtx {
  origin: string;
  mailer: Mailer | null;
  heartbeat: () => Promise<void>;
  every: number;
  /** The workspace's date formatter (its format and time zone), as the Due chips show dates. */
  fmt: DayFormatter;
}

/** One (policy, outbox row) a delivery records for a person: the row an earlier attempt wrote, if any, and what reached them then. */
interface SweepRecord {
  document_id: number;
  document_title: string;
  outbox_id: number;
  noticeId?: number;
  channels: AckNoticeChannel[];
}

interface SweepTarget {
  id: number;
  name: string;
  email: string;
  records: SweepRecord[];
}

interface SweepMessage {
  kind: "ack_due" | "ack_escalation";
  noticeKind: AckNoticeKind;
  title: string;
  body: string;
  link: string;
  template: string;
  vars: Record<string, string>;
}

/** What the sweep put on a 'due' row: each person's due date and whether the grace period has passed. */
interface DuePayloadRow {
  user_id: number;
  due_at: string | null;
  overdue: boolean;
}

/** What the sweep put on an 'escalation' row. */
interface EscalationPayload {
  days: number;
  overdue: { user_id: number; name: string; due_at: string | null }[];
  recipients: { id: number; via: EscalationVia }[];
}

function duePayloadRows(row: ClaimedAckOutboxRow): Map<number, DuePayloadRow> {
  const map = new Map<number, DuePayloadRow>();
  const p = row.payload as { rows?: Partial<DuePayloadRow>[] } | null | undefined;
  for (const r of p?.rows ?? []) {
    if (typeof r?.user_id !== "number") continue;
    map.set(r.user_id, { user_id: r.user_id, due_at: r.due_at ?? null, overdue: Boolean(r.overdue) });
  }
  return map;
}

function escalationPayload(row: ClaimedAckOutboxRow): EscalationPayload {
  const p = row.payload as Partial<EscalationPayload> | null | undefined;
  return {
    days: typeof p?.days === "number" ? p.days : 0,
    overdue: Array.isArray(p?.overdue) ? p.overdue.filter((o) => o && typeof o.user_id === "number") : [],
    recipients: Array.isArray(p?.recipients) ? p.recipients.filter((r) => r && typeof r.id === "number") : [],
  };
}

/** A record an earlier attempt completed (the mail went out) needs nothing more. */
function recordDone(rec: { channels: AckNoticeChannel[] } | undefined): boolean {
  return Boolean(rec && rec.channels.includes("email"));
}

/**
 * Deliver one message to a set of people and record it per person and
 * policy: the inbox and webhooks through notify() for anyone with a record
 * nothing has reached yet, the record rows (one per policy, with the
 * channels reached so far) before the slow part, then one mail per person
 * who still lacks the email channel on any of their records, adding
 * 'email' to those records as the server accepts the mail. Failures are
 * collected, never thrown, so the caller can retry the rows.
 */
async function deliverSweepMessage(
  msg: SweepMessage,
  targets: SweepTarget[],
  ctx: SweepCtx
): Promise<{ emailed: number; noticed: number; errors: string[] }> {
  const errors: string[] = [];
  const reached = new Map<number, AckNoticeChannel[]>();
  const fresh = targets.filter((t) => t.records.some((r) => r.noticeId == null || r.channels.length === 0));
  for (const t of fresh) reached.set(t.id, []);
  if (fresh.length > 0) {
    try {
      const r = await notify(
        fresh.map((t) => t.id),
        { kind: msg.kind, title: msg.title, body: msg.body, link: msg.link, origin: ctx.origin },
        { heartbeat: ctx.heartbeat, heartbeatEvery: ctx.every }
      );
      for (const id of r.inboxIds) reached.get(id)?.push("inapp");
      for (const id of r.webhookIds) reached.get(id)?.push("webhook");
      if (r.inboxError) errors.push(`Inbox: ${r.inboxError}`);
    } catch (e) {
      console.error("Ack sweep inbox notifications failed:", e);
      errors.push(`Inbox: ${errorMessage(e)}`);
    }
  }

  // The record, before the mail: a new row per (person, policy) nothing
  // was written for; a row that said nothing reached them gets the channels
  // added to it.
  const inserts: AckNoticeInput[] = [];
  const inserted: SweepRecord[] = [];
  for (const t of fresh) {
    const channels = reached.get(t.id) ?? [];
    for (const rec of t.records) {
      if (rec.noticeId == null) {
        inserts.push({
          user_id: t.id,
          user_name: t.name,
          user_email: t.email,
          document_id: rec.document_id,
          document_title: rec.document_title,
          kind: msg.noticeKind,
          channels,
          by_user_id: null,
          by_name: "system",
          outbox_id: rec.outbox_id,
        });
        inserted.push(rec);
      } else if (rec.channels.length === 0) {
        for (const ch of channels) await addAckNoticeChannel(rec.noticeId, ch);
        rec.channels = [...channels];
      }
    }
  }
  const ids = await recordNotices(inserts);
  inserted.forEach((rec, i) => {
    rec.noticeId = ids[i];
    rec.channels = [...(inserts[i].channels ?? [])];
  });

  // Email, once per person, for anyone whose records still lack it. The
  // error names the person by id, never by address.
  let emailed = 0;
  const need = targets.filter((t) => t.email && t.records.some((r) => r.noticeId != null && !r.channels.includes("email")));
  if (ctx.mailer && need.length > 0) {
    let mail: { subject: string; text: string; html: string } | null = null;
    try {
      mail = await renderEmail(msg.template, msg.vars, ctx.origin);
    } catch (e) {
      console.error("Ack sweep email render failed:", e);
      errors.push(`Email template: ${errorMessage(e)}`);
    }
    if (mail) {
      const prefs = await getNotifyPrefsFor(need.map((t) => t.id)).catch(
        () => new Map<number, Record<string, Record<string, boolean>>>()
      );
      let attempted = 0;
      for (const t of need) {
        if (!notifyPrefAllows(prefs.get(t.id), msg.kind, "email")) continue;
        try {
          await ctx.mailer([t.email], mail.subject, mail.text, mail.html);
          emailed++;
          for (const rec of t.records) {
            if (rec.noticeId == null || rec.channels.includes("email")) continue;
            await addAckNoticeChannel(rec.noticeId, "email");
            rec.channels.push("email");
          }
        } catch (e) {
          console.error(`Ack sweep email to user #${t.id} failed:`, e);
          errors.push(`Email to user #${t.id}: ${errorMessage(e)}`);
        }
        if (++attempted % ctx.every === 0) await ctx.heartbeat();
      }
    }
  }
  return { emailed, noticed: ids.length, errors };
}

/** Per 'due' row: who was told in a bundle instead (left out of the row's own notice), and what failed for them. */
interface DueBundlePlan {
  bundled: Map<number, Set<number>>;
  errors: Map<number, string[]>;
}

/**
 * The bundles of a batch: for every person named on more than
 * DUE_BUNDLE_OVER deliverable 'due' rows, one notice "You have {n}
 * policies to confirm" listing the titles and due dates, linking My
 * policies, with one ack_notices row per policy (kind 'due', each under
 * its own outbox row) and one mail (template ack_due_bundle). A failure is
 * charged to every row of the bundle, so they are retried together and the
 * retry resumes the bundle from the record.
 */
async function planDueBundles(rows: ClaimedAckOutboxRow[], ctx: SweepCtx): Promise<DueBundlePlan> {
  const plan: DueBundlePlan = { bundled: new Map(), errors: new Map() };
  const dueRows = rows.filter((r) => r.mode === "due" && r.document_id != null);
  if (dueRows.length <= DUE_BUNDLE_OVER) return plan;

  interface Item {
    row: ClaimedAckOutboxRow;
    doc: { id: number; title: string };
    due: DuePayloadRow | undefined;
    had: { id: number; channels: AckNoticeChannel[] } | undefined;
  }
  const people = new Map<number, { id: number; name: string; email: string }>();
  const perUser = new Map<number, Item[]>();
  for (const row of dueRows) {
    const doc = await ackNoticeDocument(row.document_id!);
    if (!doc || !doc.deliverable) continue;
    const payload = duePayloadRows(row);
    const [recipients, already] = await Promise.all([ackNoticeRecipients(doc.id, row.user_ids), ackNoticesForOutbox([row.id])]);
    for (const u of recipients) {
      people.set(u.id, u);
      const items = perUser.get(u.id) ?? [];
      items.push({ row, doc, due: payload.get(u.id), had: already.get(u.id) });
      perUser.set(u.id, items);
    }
  }

  const charge = (rowId: number, errors: string[]) => {
    if (errors.length === 0) return;
    plan.errors.set(rowId, [...(plan.errors.get(rowId) ?? []), ...errors]);
  };
  for (const [userId, items] of perUser) {
    if (items.length <= DUE_BUNDLE_OVER) continue;
    for (const it of items) {
      const set = plan.bundled.get(it.row.id) ?? new Set<number>();
      set.add(userId);
      plan.bundled.set(it.row.id, set);
    }
    // Everything an earlier attempt completed needs nothing more.
    if (items.every((it) => recordDone(it.had))) continue;
    const person = people.get(userId)!;
    const policies = items.map((it) => ({ title: it.doc.title, due_at: it.due?.due_at ?? null, overdue: it.due?.overdue ?? false }));
    const link = "/compliance";
    const msg: SweepMessage = {
      kind: "ack_due",
      noticeKind: "due",
      title: bundleTitle(items.length),
      body: bundleBody(policies, ctx.fmt),
      link,
      template: "ack_due_bundle",
      vars: {
        count: String(items.length),
        policy_list: bundleList(policies, ctx.fmt),
        portal_url: `${ctx.origin}${link}`,
      },
    };
    const target: SweepTarget = {
      ...person,
      records: items.map((it) => ({
        document_id: it.doc.id,
        document_title: it.doc.title,
        outbox_id: it.row.id,
        noticeId: it.had?.id,
        channels: [...(it.had?.channels ?? [])],
      })),
    };
    try {
      const r = await deliverSweepMessage(msg, [target], ctx);
      for (const it of items) charge(it.row.id, r.errors);
    } catch (e) {
      console.error(`[ack] bundled reminder for user #${userId} failed:`, e);
      for (const it of items) charge(it.row.id, [errorMessage(e)]);
    }
  }
  return plan;
}

/** The words of one person's automatic reminder for one policy (E2). */
function dueMessage(doc: { id: number; title: string }, dueAt: string | null, overdue: boolean, ctx: SweepCtx): SweepMessage {
  const link = `/doc/${doc.id}#confirm-reading`;
  return {
    kind: "ack_due",
    noticeKind: "due",
    title: dueNoticeTitle(doc.title, dueAt, overdue),
    body: dueNoticeBody(doc.title, dueAt, ctx.fmt),
    link,
    template: "ack_due",
    vars: {
      doc_title: doc.title,
      doc_url: `${ctx.origin}${link}`,
      due_date: dueAt ? ctx.fmt(dueAt) : "",
      due_line: dueLine(dueAt, ctx.fmt),
      status_label: dueStatusLabel(dueAt, overdue),
    },
  };
}

/**
 * One 'due' row: everyone it names who is still active, minus the people
 * the batch bundled, grouped by their status and date (people who share
 * both share a message), each group through deliverSweepMessage. The
 * bundle's failures for this row are reported with the row's own.
 */
async function deliverDue(row: ClaimedAckOutboxRow, plan: DueBundlePlan, ctx: SweepCtx): Promise<GroupOutcome> {
  const none: GroupOutcome = { deliverable: false, pending: 0, skippedRecent: 0, emailed: 0, noticed: 0, errors: [] };
  const doc = row.document_id != null ? await ackNoticeDocument(row.document_id) : undefined;
  if (!doc || !doc.deliverable) return none;
  const payload = duePayloadRows(row);
  const [recipients, already] = await Promise.all([ackNoticeRecipients(doc.id, row.user_ids), ackNoticesForOutbox([row.id])]);
  const bundled = plan.bundled.get(row.id) ?? new Set<number>();
  const errors = [...(plan.errors.get(row.id) ?? [])];

  const groups = new Map<string, { dueAt: string | null; overdue: boolean; targets: SweepTarget[] }>();
  for (const u of recipients) {
    if (bundled.has(u.id)) continue;
    const had = already.get(u.id);
    if (recordDone(had)) continue;
    const p = payload.get(u.id);
    const dueAt = p?.due_at ?? null;
    const overdue = p?.overdue ?? false;
    const key = `${overdue ? "overdue" : "due"}|${dueAt ?? ""}`;
    const g = groups.get(key) ?? { dueAt, overdue, targets: [] };
    g.targets.push({
      ...u,
      records: [{ document_id: doc.id, document_title: doc.title, outbox_id: row.id, noticeId: had?.id, channels: [...(had?.channels ?? [])] }],
    });
    groups.set(key, g);
  }
  let emailed = 0;
  let noticed = 0;
  for (const g of groups.values()) {
    const r = await deliverSweepMessage(dueMessage(doc, g.dueAt, g.overdue, ctx), g.targets, ctx);
    emailed += r.emailed;
    noticed += r.noticed;
    errors.push(...r.errors);
  }
  return { deliverable: true, pending: recipients.length, skippedRecent: 0, emailed, noticed, errors, bundled: bundled.size };
}

/**
 * One 'escalation' row: the recipients it names (the owner or their
 * stand-ins, and the overdue people's group leads), each told once about
 * this policy, leads linked to their team view and the others to the
 * policy in the portal (two messages at most), the record under kind
 * 'escalation'.
 */
async function deliverEscalation(row: ClaimedAckOutboxRow, ctx: SweepCtx): Promise<GroupOutcome> {
  const none: GroupOutcome = { deliverable: false, pending: 0, skippedRecent: 0, emailed: 0, noticed: 0, errors: [] };
  const doc = row.document_id != null ? await ackNoticeDocument(row.document_id) : undefined;
  if (!doc || !doc.deliverable) return none;
  const payload = escalationPayload(row);
  const [recipients, already] = await Promise.all([ackNoticeRecipients(doc.id, row.user_ids), ackNoticesForOutbox([row.id])]);
  const via = new Map(payload.recipients.map((r) => [r.id, r.via]));
  const byLink = new Map<string, SweepTarget[]>();
  for (const u of recipients) {
    const had = already.get(u.id);
    if (recordDone(had)) continue;
    const link = via.get(u.id) === "lead" ? "/compliance/team" : `/compliance/policies?policy=${doc.id}`;
    const targets = byLink.get(link) ?? [];
    targets.push({
      ...u,
      records: [{ document_id: doc.id, document_title: doc.title, outbox_id: row.id, noticeId: had?.id, channels: [...(had?.channels ?? [])] }],
    });
    byLink.set(link, targets);
  }
  const names = payload.overdue.map((o) => o.name);
  const errors: string[] = [];
  let emailed = 0;
  let noticed = 0;
  for (const [link, targets] of byLink) {
    const msg: SweepMessage = {
      kind: "ack_escalation",
      noticeKind: "escalation",
      title: escalationTitle(names.length, doc.title),
      body: escalationBody(payload.days, names),
      link,
      template: "ack_escalation",
      vars: {
        policy_title: doc.title,
        overdue_count: String(names.length),
        overdue_list: escalationList(payload.overdue, ctx.fmt),
        portal_url: `${ctx.origin}${link}`,
      },
    };
    const r = await deliverSweepMessage(msg, targets, ctx);
    emailed += r.emailed;
    noticed += r.noticed;
    errors.push(...r.errors);
  }
  return { deliverable: true, pending: recipients.length, skippedRecent: 0, emailed, noticed, errors };
}

// --- Reminders and escalation (E2, 1.13.0) ---------------------------------------
//
// The hourly sweep. Each claim is one statement in lib/db (claimAckReminders,
// claimAckEscalations: the UPDATE stamps the column its WHERE tests, FOR
// UPDATE SKIP LOCKED in the subquery), so every instance may run it and a
// row is claimed once; a crash between the claim and the outbox row drops
// that cycle's reminder, as the training sweep does. The claimed people are
// handed to the outbox, one row per policy, which the minute tick delivers
// (deliverDue / deliverEscalation above), so the tick never waits on mail.

/** The sweep's actor on the outbox rows and the audit rows. */
const SWEEP_ACTOR: AckActor = { id: null, name: "system" };

/**
 * The five numbers the SQL claims take as COALESCE fallbacks: the workspace
 * layer (ack_defaults' seven numbers, the ones an admin set) resolved over
 * the built-ins. Loaded once per tick and passed into every claim.
 */
export function sweepDefaults(workspace: PolicyDefaultsLayer | null | undefined): AckSweepDefaults {
  const v = resolveDefaults({ workspace }).values;
  return {
    remind_before_days: v.remind_before_days,
    remind_every_days: v.remind_every_days,
    escalate_after_days: v.escalate_after_days,
    nudge_every_days: v.nudge_every_days,
    overdue_grace_days: v.overdue_grace_days,
  };
}

export interface SweepOptions {
  /** Limit the claim to these policies (tests sharing a database; the tick passes nothing). */
  documentIds?: number[];
  /** The workspace-resolved numbers; read from the settings when absent. */
  defaults?: AckSweepDefaults;
}

async function sweepDefaultsFromSettings(): Promise<AckSweepDefaults> {
  return sweepDefaults(await workspaceDueDefaults());
}

/**
 * Remind everyone whose confirmation is due or overdue (the cadence per
 * policy: remind_before_days ahead of the date, every remind_every_days
 * after, nudge_every_days for a policy with no date). One claim across all
 * live policies; then one 'due' outbox row per policy with the claimed
 * people and their dates, and ack.reminder_auto {policy, reminded,
 * overdue} by the system. The drain bundles a person with more than three
 * policies into one notice and writes a second ack.reminder_auto per row
 * with the delivery counts.
 */
export async function remindDueAcks(opts: SweepOptions = {}): Promise<{ claimed: number; policies: number; outbox_ids: number[] }> {
  const defaults = opts.defaults ?? (await sweepDefaultsFromSettings());
  const rows = await claimAckReminders(defaults, { documentIds: opts.documentIds });
  const byDoc = new Map<number, typeof rows>();
  for (const r of rows) {
    const list = byDoc.get(r.document_id) ?? [];
    list.push(r);
    byDoc.set(r.document_id, list);
  }
  const outboxIds: number[] = [];
  for (const [docId, claimed] of byDoc) {
    const outboxId = await insertAckOutbox(null, {
      document_id: docId,
      mode: "due",
      source: "",
      actor: SWEEP_ACTOR,
      user_ids: claimed.map((r) => r.user_id),
      payload: { rows: claimed.map((r) => ({ user_id: r.user_id, due_at: r.due_at, overdue: r.overdue })) },
      delay_minutes: 0,
      origin: "",
    });
    outboxIds.push(outboxId);
    await auditAck("ack.reminder_auto", { id: docId, title: claimed[0].title }, {
      actor: SWEEP_ACTOR,
      details: {
        policy: docId,
        reminded: claimed.length,
        overdue: claimed.filter((r) => r.overdue).length,
        outbox_id: outboxId,
      },
    });
  }
  return { claimed: rows.length, policies: byDoc.size, outbox_ids: outboxIds };
}

/**
 * Escalate everyone past due_at + overdue_grace_days + escalate_after_days
 * (once per row: escalated_at; extending the due date re-arms it). The
 * recipients are resolved once per policy (escalationRecipients: the owner,
 * else requested_by, else the space's approvers, plus the overdue people's
 * group leads who can see the space); one 'escalation' outbox row per
 * policy carries them and the overdue names, and ack.escalated {policy,
 * overdue, recipients} is written by the system. A policy nobody can be
 * told about (no owner, no approver, no lead) is still stamped and audited
 * with recipients 0, so it is not escalated again next hour.
 */
export async function escalateOverdueAcks(
  opts: SweepOptions = {}
): Promise<{ claimed: number; policies: number; recipients: number; outbox_ids: number[] }> {
  const defaults = opts.defaults ?? (await sweepDefaultsFromSettings());
  const rows = await claimAckEscalations(defaults, { documentIds: opts.documentIds });
  const byDoc = new Map<number, typeof rows>();
  for (const r of rows) {
    const list = byDoc.get(r.document_id) ?? [];
    list.push(r);
    byDoc.set(r.document_id, list);
  }
  const recipients = await escalationRecipients(
    [...byDoc].map(([document_id, claimed]) => ({ document_id, space_id: claimed[0].space_id, user_ids: claimed.map((r) => r.user_id) }))
  );
  const outboxIds: number[] = [];
  let told = 0;
  for (const [docId, claimed] of byDoc) {
    const to = recipients.get(docId) ?? [];
    let outboxId: number | null = null;
    if (to.length > 0) {
      outboxId = await insertAckOutbox(null, {
        document_id: docId,
        mode: "escalation",
        source: "",
        actor: SWEEP_ACTOR,
        user_ids: to.map((r) => r.id),
        payload: {
          days: claimed[0].days,
          overdue: claimed.map((r) => ({ user_id: r.user_id, name: r.name, due_at: r.due_at })),
          recipients: to.map((r) => ({ id: r.id, via: r.via })),
        },
        delay_minutes: 0,
        origin: "",
      });
      outboxIds.push(outboxId);
      told += to.length;
    }
    await auditAck("ack.escalated", { id: docId, title: claimed[0].title }, {
      actor: SWEEP_ACTOR,
      details: {
        policy: docId,
        overdue: claimed.length,
        recipients: to.length,
        days: claimed[0].days,
        user_ids: claimed.map((r) => r.user_id),
        recipient_ids: to.map((r) => r.id),
        outbox_id: outboxId,
      },
    });
  }
  return { claimed: rows.length, policies: byDoc.size, recipients: told, outbox_ids: outboxIds };
}

/**
 * The hourly tick's read-confirmation work (instrumentation.ts, after
 * trainingHourly), gated on the policy_ack entitlement: the audience
 * reconcile, expired exemptions, due and overdue reminders, escalations,
 * then the re-confirmation cycles. The workspace defaults are read once and
 * passed into every claim. Each step has its own catch, tagged
 * [compliance], so one failing step never stops the others; every step is
 * an atomic claim, so every instance may run this at once.
 */
export async function complianceHourly(): Promise<void> {
  if (!(await featureEnabled("policy_ack"))) return;
  const layer = await workspaceDueDefaults();
  const defaults = sweepDefaults(layer);
  const step = async (name: string, run: () => Promise<unknown>) => {
    try {
      await run();
    } catch (e) {
      console.error(`[compliance] ${name} failed:`, e);
    }
  };
  await step("audience reconcile", () => reconcileAllPolicies());
  await step("expired exemptions", () => expireExemptions());
  await step("reminders", () => remindDueAcks({ defaults }));
  await step("escalation", () => escalateOverdueAcks({ defaults }));
  await step("re-confirmation", () => recertifyDueAcks({ defaults: layer }));
}
