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
} from "./db";
import type { AckOutboxInput, AckNoticeInput, AckActor, Queryable, ClaimedAckOutboxRow } from "./db";
import type { AckNoticeMode, AckNoticeChannel, AckSource } from "./types";
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
}): NoticeCopy {
  const t = input.docTitle;
  const who = input.actorName || "Someone";
  const by = input.dueAt ? ` by ${formatDay(input.dueAt)}` : "";
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
    case "reminder":
    case "due":
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
    case "request":
    case "welcome":
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
    case "due":
    case "overdue":
      return "ack.reminder_sent";
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
   * channels go onto that row instead of a new one.
   */
  users: { id: number; name: string; email: string; noticeId?: number }[];
  /** People an earlier attempt reached in-app but could not email: email only, then the channel is added to their row. */
  resumeEmail?: { id: number; name: string; email: string; noticeId: number }[];
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
  const copy = noticeCopy({
    mode: input.mode,
    source: input.source,
    docTitle: input.docTitle,
    actorName: input.requesterName,
    reason: input.reason,
    dueAt: input.dueAt,
  });
  const link = `/doc/${input.docId}#confirm-reading`;
  const origin = input.origin || "";
  const url = `${origin}${link}`;
  const mailer = input.mailer === undefined ? await defaultMailer() : input.mailer;
  const every = Math.max(1, input.heartbeatEvery ?? ACK_NOTICE_HEARTBEAT_EVERY);
  const heartbeat = input.heartbeat ?? (async () => {});
  const errors: string[] = [];
  const channels = new Map<number, AckNoticeChannel[]>();

  // Same message for every target, so render the template once. A template
  // that will not render is a failure to retry, not a reason to skip the
  // inbox: people still see the bell, and the row comes back for the email.
  // The free-text tags (title, names, change note, reason) are rendered as
  // written, never as markdown or HTML: the template marks them as text.
  let mail: { subject: string; text: string; html: string } | null = null;
  if (mailer) {
    try {
      const daysLeft = input.dueAt
        ? String(Math.max(0, Math.ceil((new Date(input.dueAt).getTime() - Date.now()) / 86_400_000)))
        : "";
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
          due_date: input.dueAt ? formatDay(input.dueAt) : "",
          days_left: daysLeft,
        },
        origin
      );
    } catch (e) {
      console.error("Ack email render failed:", e);
      errors.push(`Email template: ${errorMessage(e)}`);
    }
  }

  // In-app and webhook, for the people not yet reached. An inbox that took
  // no rows is a delivery failure like a refused mail: the row comes back
  // and these people (their row says nothing reached them) are fed to
  // notify() again on the retry.
  const fresh = input.users;
  for (const u of fresh) channels.set(u.id, []);
  if (fresh.length > 0) {
    try {
      const reached = await notify(
        fresh.map((u) => u.id),
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
  if (mail && targets.length > 0) {
    const prefs = await getNotifyPrefsFor(targets.map((u) => u.id)).catch(
      () => new Map<number, Record<string, Record<string, boolean>>>()
    );
    let attempted = 0;
    for (const target of targets) {
      if (!target.email) continue;
      if (!notifyPrefAllows(prefs.get(target.id), "ack_requested", "email")) continue;
      try {
        await mailer!([target.email], mail.subject, mail.text, mail.html);
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
}

async function deliverGroup(
  group: ClaimedAckOutboxRow[],
  primary: ClaimedAckOutboxRow,
  ctx: { origin: string; mailer: Mailer | null; heartbeat: () => Promise<void>; heartbeatEvery?: number }
): Promise<GroupOutcome> {
  const none: GroupOutcome = { deliverable: false, pending: 0, skippedRecent: 0, emailed: 0, noticed: 0, errors: [] };
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
  const recipients = await ackNoticeRecipients(doc.id, primary.user_ids);
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

  for (const group of groupOutbox(rows)) {
    const ids = group.map((r) => r.id);
    const primary = group[group.length - 1];
    const attempts = Math.max(...group.map((r) => r.attempts));
    const retire = attempts >= ACK_NOTICE_MAX_ATTEMPTS;
    const actor = { id: primary.actor_id, name: primary.actor_name || "system" };
    const docRef = { id: primary.document_id ?? 0, title: "" };
    try {
      await heartbeat();
      const outcome = await deliverGroup(group, primary, {
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
