// Content review reminders: mark a document for periodic re-review and get
// nudged when it's due, so knowledge doesn't quietly go out of date. A
// document with an interval has a due date; "mark as reviewed" (or any real
// content edit) pushes the due date a full interval out. When a review comes
// due, approvers get one email per document (via the editable review_due
// template) and due docs surface on the dashboard and the doc page.

import "server-only";
import { pool } from "./db";

async function q<T = any>(sql: string, params: any[] = []): Promise<T[]> {
  return (await pool().query(sql, params)).rows as T[];
}

export const REVIEW_INTERVALS = [30, 60, 90, 180, 365];

/** Set (interval in days) or clear (null) a document's review schedule. */
export async function setReviewSchedule(docId: number, intervalDays: number | null): Promise<void> {
  if (intervalDays === null) {
    await q(
      `UPDATE documents SET review_interval_days = NULL, review_due_at = NULL,
         review_reminded_at = NULL WHERE id = $1`,
      [docId]
    );
    return;
  }
  // A fresh schedule starts a full interval from now; changing the interval
  // on an existing schedule re-anchors from now as well (simplest to reason
  // about: "review every N days, starting today").
  await q(
    `UPDATE documents SET review_interval_days = $2,
       review_due_at = now() + make_interval(days => $2),
       review_reminded_at = NULL
     WHERE id = $1`,
    [docId, intervalDays]
  );
}

/** Record an explicit review: due date moves a full interval out. */
export async function markReviewed(docId: number, reviewerName: string): Promise<boolean> {
  const r = await pool().query(
    `UPDATE documents SET last_reviewed_at = now(), last_reviewed_by = $2,
       review_due_at = now() + make_interval(days => review_interval_days),
       review_reminded_at = NULL
     WHERE id = $1 AND review_interval_days IS NOT NULL`,
    [docId, reviewerName]
  );
  return (r.rowCount ?? 0) > 0;
}

export interface ReviewDueDoc {
  id: number;
  title: string;
  review_due_at: string;
  space_name: string;
  space_slug: string;
  space_icon: string;
}

/** Published, live documents whose review is due, oldest due first. */
export async function listReviewsDue(scope: number[] | "all", limit = 20): Promise<ReviewDueDoc[]> {
  const scopeFilter = scope === "all" ? "" : "AND d.space_id = ANY($2)";
  return q<ReviewDueDoc>(
    `SELECT d.id, d.title, d.review_due_at,
            s.name AS space_name, s.slug AS space_slug, s.icon AS space_icon
     FROM documents d JOIN spaces s ON s.id = d.space_id
     WHERE d.review_due_at IS NOT NULL AND d.review_due_at <= now()
       AND d.deleted_at IS NULL AND d.branch_of IS NULL AND d.status = 'published'
       ${scopeFilter}
     ORDER BY d.review_due_at
     LIMIT $1`,
    scope === "all" ? [limit] : [limit, scope]
  );
}

/**
 * Email approvers/admins about reviews that just came due (one email per
 * document, sent once per due-cycle). Driven by the hourly scheduler tick.
 */
export async function remindDueReviews(): Promise<void> {
  const { getSmtpConfig, smtpConfigured } = await import("./smtp-config");
  if (!smtpConfigured(await getSmtpConfig())) return;

  // Claim atomically so concurrent instances can't double-send.
  const due = await q<{ id: number; title: string; space_name: string; review_due_at: string }>(
    `UPDATE documents d SET review_reminded_at = now()
     FROM spaces s
     WHERE s.id = d.space_id
       AND d.review_due_at IS NOT NULL AND d.review_due_at <= now()
       AND (d.review_reminded_at IS NULL OR d.review_reminded_at < d.review_due_at)
       AND d.deleted_at IS NULL AND d.branch_of IS NULL AND d.status = 'published'
     RETURNING d.id, d.title, s.name AS space_name, d.review_due_at`
  );
  if (due.length === 0) return;

  const recipients = await q<{ email: string }>(
    `SELECT email FROM users
     WHERE status = 'active' AND role IN ('approver', 'admin')
       AND email IS NOT NULL AND email <> ''`
  );
  if (recipients.length === 0) return;

  const { renderEmail } = await import("./email-templates");
  const { sendMail } = await import("./mailer");
  const { getAppSettings } = await import("./settings-store");
  const { formatDate } = await import("./format");
  const settings = await getAppSettings();
  // No request context in the scheduler: the configured custom domain is the
  // best origin we have (links degrade to relative paths without one).
  const origin = settings.custom_domain ? `https://${settings.custom_domain}` : "";

  for (const doc of due) {
    try {
      const { subject, text, html } = await renderEmail(
        "review_due",
        {
          doc_title: doc.title,
          space_name: doc.space_name,
          due_date: formatDate(doc.review_due_at, settings),
          doc_url: `${origin}/doc/${doc.id}`,
        },
        origin
      );
      for (const r of recipients) {
        try {
          await sendMail([r.email], subject, text, html);
        } catch (e) {
          console.error(`[reviews] reminder to ${r.email} failed:`, e);
        }
      }
    } catch (e) {
      console.error(`[reviews] reminder for doc ${doc.id} failed:`, e);
    }
  }
}
