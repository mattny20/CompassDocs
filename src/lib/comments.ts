// Document comments: workplace-safety rules + @mention notifications.
// Server-only. The rules live here so every write path enforces them:
//   - comments can be disabled workspace-wide (admin setting),
//   - bodies are checked against the admin's restricted-word list,
//   - @mentions notify the mentioned user by email (comment + doc link) AND
//     by a dashboard announcement targeted at just them, with a doc link.

import "server-only";
import { createAnnouncement, type DocComment } from "./db";
import { getSmtpConfig, smtpConfigured } from "./smtp-config";
import { sendMail } from "./mailer";

export const COMMENT_MAX_LEN = 4000;

/**
 * Parse the admin's restricted-word list (comma- or newline-separated,
 * case-insensitive). Returns the first restricted term found in `body`, or
 * null. Single words match on word boundaries ("ban" never flags "banana");
 * multi-word phrases match as substrings.
 */
export function findBlockedWord(body: string, blockedList: string): string | null {
  const terms = blockedList
    .split(/[\n,]+/)
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
  if (terms.length === 0) return null;
  const lower = body.toLowerCase();
  for (const term of terms) {
    if (/\s/.test(term)) {
      if (lower.includes(term)) return term;
    } else {
      const esc = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (new RegExp(`(^|[^\\p{L}\\p{N}_])${esc}($|[^\\p{L}\\p{N}_])`, "u").test(lower)) return term;
    }
  }
  return null;
}

export interface MentionTarget {
  id: number;
  name: string;
  email: string;
  email_notifications: number;
}

/**
 * Notify each mentioned user: an email with the comment text + a link to the
 * document, and a dashboard announcement visible only to them with the same
 * link. Fire-and-forget from the write path (call with `void`); every failure
 * is logged, none block the comment.
 */
export async function notifyMentions(input: {
  targets: MentionTarget[];
  comment: Pick<DocComment, "body">;
  authorId: number;
  authorName: string;
  docId: number;
  docTitle: string;
  orgName: string;
  origin: string;
}): Promise<void> {
  const url = `${input.origin}/doc/${input.docId}#comments`;
  const excerpt =
    input.comment.body.length > 500 ? input.comment.body.slice(0, 500) + "…" : input.comment.body;

  const mailReady = smtpConfigured(await getSmtpConfig());

  for (const target of input.targets) {
    if (target.id === input.authorId) continue; // self-mentions don't notify

    // Dashboard announcement, targeted at just this user; auto-expires so
    // old mention notices don't pile up. Dismissible like any announcement.
    try {
      await createAnnouncement({
        title: `💬 ${input.authorName} mentioned you`,
        body: `In "${input.docTitle}": ${excerpt}`,
        level: "info",
        author_name: input.authorName,
        created_by: input.authorId,
        expires_days: 14,
        target_user_id: target.id,
        link: `/doc/${input.docId}#comments`,
      });
    } catch (e) {
      console.error(`Mention announcement for user ${target.id} failed:`, e);
    }

    // Email (respects the user's notification master switch).
    if (!mailReady || !target.email || target.email_notifications !== 1) continue;
    try {
      const subject = `[${input.orgName}] ${input.authorName} mentioned you in "${input.docTitle}"`;
      const text =
        `${input.authorName} mentioned you in a comment on "${input.docTitle}":\n\n` +
        `${input.comment.body}\n\n` +
        `View the document and reply: ${url}\n\n` +
        `Manage notification emails: ${input.origin}/account/notifications`;
      const html =
        `<p><strong>${esc(input.authorName)}</strong> mentioned you in a comment on ` +
        `<strong>${esc(input.docTitle)}</strong>:</p>` +
        `<blockquote style="margin:12px 0;padding:10px 14px;border-left:3px solid #2e75bd;background:#f8fafc;white-space:pre-line">${esc(input.comment.body)}</blockquote>` +
        `<p><a href="${url}">View the document and reply</a></p>` +
        `<p style="color:#64748b;font-size:13px"><a href="${input.origin}/account/notifications">Manage notification emails</a></p>`;
      await sendMail([target.email], subject, text, html);
    } catch (e) {
      console.error(`Mention email to ${target.email} failed:`, e);
    }
  }
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
