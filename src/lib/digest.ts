// Weekly digest email: a personal Monday-morning summary for users who opt in
// (Account → Notifications). Per recipient it collects, scoped to what THEY
// can see: what changed in their subscribed spaces this week, reviews they
// should handle (approvers/admins), and the week's most-read documents. Users
// with nothing to report get no email at all.
//
// Timing: the hourly instrumentation tick calls maybeSendWeeklyDigests(). It
// fires on the first tick at/after Monday 08:00 server time, claimed once per
// ISO week through an atomic settings upsert — safe across instances.

import "server-only";
import { pool, getSetting } from "./db";
import { sendMail } from "./mailer";
import { smtpConfigured, getSmtpConfig } from "./smtp-config";
import { audit } from "./audit";

async function q<T = any>(sql: string, params: any[] = []): Promise<T[]> {
  return (await pool().query(sql, params)).rows as T[];
}

const SEND_DOW = 1; // Monday
const SEND_HOUR = 8; // first hourly tick at/after 08:00 local
const MAX_ROWS = 8; // per section

function isoWeek(d: Date): string {
  // ISO-8601 week id, e.g. "2026-W31".
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/** Claim this week's send. True exactly once per ISO week across instances. */
async function claimWeek(week: string): Promise<boolean> {
  const rows = await q(
    `INSERT INTO settings (key, value) VALUES ('digest_last_week', $1)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
     WHERE settings.value <> EXCLUDED.value
     RETURNING key`,
    [week]
  );
  return rows.length > 0;
}

interface DigestRow {
  id: number;
  title: string;
  space_name: string;
  extra?: string;
}

function section(title: string, rows: DigestRow[], origin: string): { text: string; html: string } | null {
  if (rows.length === 0) return null;
  const text =
    `${title}\n` +
    rows.map((r) => `  - ${r.title} (${r.space_name})${r.extra ? ` — ${r.extra}` : ""}\n    ${origin}/doc/${r.id}`).join("\n");
  const html =
    `<h3 style="margin:18px 0 6px;font-size:15px;color:#0f172a">${title}</h3><ul style="margin:0;padding-left:18px;color:#334155;font-size:14px;line-height:1.7">` +
    rows
      .map(
        (r) =>
          `<li><a href="${origin}/doc/${r.id}" style="color:#2e75bd;text-decoration:none;font-weight:600">${escapeHtml(
            r.title
          )}</a> <span style="color:#94a3b8">· ${escapeHtml(r.space_name)}${r.extra ? ` · ${escapeHtml(r.extra)}` : ""}</span></li>`
      )
      .join("") +
    `</ul>`;
  return { text, html };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export async function maybeSendWeeklyDigests(now = new Date()): Promise<void> {
  // Send window: any tick from Monday 08:00 through Sunday of the SAME ISO
  // week may claim it (claimWeek dedups) — so an instance that was down on
  // Monday still catches up instead of silently dropping the week.
  const isoDay = (now.getDay() + 6) % 7; // 0 = Monday … 6 = Sunday
  if (isoDay === 0 && now.getHours() < SEND_HOUR) return;
  if (!smtpConfigured(await getSmtpConfig())) return;

  // Anyone opted in at all? (cheap pre-check before claiming the week)
  const [{ n }] = await q<{ n: number }>(
    `SELECT count(*)::int AS n FROM users
     WHERE status = 'active' AND email <> '' AND email_notifications = 1 AND weekly_digest = 1`
  );
  if (n === 0) return;

  const week = isoWeek(now);
  if (!(await claimWeek(week))) return;

  // Origin for links: the configured custom domain (same fallback the
  // subscriber emails use).
  let origin = "";
  const domain = (await getSetting("custom_domain"))?.trim();
  if (domain) origin = `https://${domain}`;

  const recipients = await q<{ id: number; email: string; name: string; role: string }>(
    `SELECT id, email, name, role FROM users
     WHERE status = 'active' AND email <> '' AND email_notifications = 1 AND weekly_digest = 1`
  );

  let sent = 0;
  let failed = 0;
  for (const u of recipients) {
    try {
      // Spaces this user can see: admins see all, others their grant set.
      // Mirrors accessibleSpaceIdsFor(): non-private spaces plus private
      // spaces granted via one of the user's groups.
      const scopeFilter =
        u.role === "admin"
          ? ""
          : ` AND d.space_id IN (
               SELECT sp.id FROM spaces sp WHERE sp.visibility IN ('public','internal')
               UNION
               SELECT sg.space_id FROM space_groups sg
                 JOIN group_members gm ON gm.group_id = sg.group_id
               WHERE gm.user_id = $1
             )`;

      // 1) Updated this week in spaces the user subscribes to. "Subscribed"
      // means the same thing it means for per-change emails
      // (listSubscriberRecipients): a direct subscription, or membership in
      // an admin-subscribed group that the user hasn't personally muted.
      const inYourSpaces = await q<DigestRow>(
        `SELECT d.id, d.title, s.name AS space_name
         FROM documents d
         JOIN spaces s ON s.id = d.space_id
         WHERE d.deleted_at IS NULL AND d.branch_of IS NULL AND d.status = 'published'
           AND d.updated_at > now() - interval '7 days'
           AND (
             EXISTS (SELECT 1 FROM space_subscriptions ss
                     WHERE ss.space_id = d.space_id AND ss.user_id = $1 AND ss.state = 'subscribed')
             OR (
               EXISTS (SELECT 1 FROM space_subscription_groups sg
                       JOIN group_members gm ON gm.group_id = sg.group_id
                       WHERE sg.space_id = d.space_id AND gm.user_id = $1)
               AND NOT EXISTS (SELECT 1 FROM space_subscriptions ss
                               WHERE ss.space_id = d.space_id AND ss.user_id = $1 AND ss.state = 'muted')
             )
           ) ${scopeFilter}
         ORDER BY d.updated_at DESC
         LIMIT ${MAX_ROWS}`,
        [u.id]
      );

      // 2) Reviews due (approvers and admins).
      const reviews =
        u.role === "admin" || u.role === "approver"
          ? await q<DigestRow>(
              `SELECT d.id, d.title, s.name AS space_name,
                      to_char(d.review_due_at, 'Mon DD') AS extra
               FROM documents d JOIN spaces s ON s.id = d.space_id
               WHERE d.deleted_at IS NULL AND d.branch_of IS NULL
                 AND d.review_due_at IS NOT NULL AND d.review_due_at < now() + interval '7 days'
                 ${scopeFilter}
               ORDER BY d.review_due_at ASC
               LIMIT ${MAX_ROWS}`,
              u.role === "admin" ? [] : [u.id]
            )
          : [];

      // 3) Most read this week, visibility-scoped.
      const trending = await q<DigestRow>(
        `SELECT d.id, d.title, s.name AS space_name, count(v.id)::text || ' views' AS extra
         FROM doc_views v
         JOIN documents d ON d.id = v.document_id AND d.deleted_at IS NULL AND d.branch_of IS NULL AND d.status = 'published'
         JOIN spaces s ON s.id = d.space_id
         WHERE v.viewed_at > now() - interval '7 days' ${scopeFilter}
         GROUP BY d.id, d.title, s.name
         ORDER BY count(v.id) DESC
         LIMIT 5`,
        u.role === "admin" ? [] : [u.id]
      );

      const sections = [
        section("Updated in your spaces", inYourSpaces, origin),
        section("Reviews to handle", reviews, origin),
        section("Most read this week", trending, origin),
      ].filter((s): s is { text: string; html: string } => s !== null);
      if (sections.length === 0) continue; // nothing to say — no email

      const subject = `Your weekly knowledge-base digest`;
      const text =
        `Hi ${u.name || "there"},\n\nHere's what happened this week:\n\n` +
        sections.map((s) => s.text).join("\n\n") +
        `\n\n—\nYou get this because the weekly digest is on under Account → Notifications.`;
      const html =
        `<div style="font-family:ui-sans-serif,system-ui,sans-serif;max-width:560px">` +
        `<p style="font-size:14px;color:#334155">Hi ${escapeHtml(u.name || "there")}, here's what happened this week:</p>` +
        sections.map((s) => s.html).join("") +
        `<p style="margin-top:22px;font-size:12px;color:#94a3b8">You get this because the weekly digest is on under Account → Notifications.</p>` +
        `</div>`;

      await sendMail([u.email], subject, text, html);
      sent++;
    } catch (e) {
      failed++;
      console.error(`[digest] failed for user ${u.id}:`, e);
    }
  }

  // Nothing went out at all (e.g. the relay was down for the whole loop):
  // release the claim so a later tick this week retries, instead of marking
  // the week silently done.
  if (sent === 0 && failed > 0) {
    await q("UPDATE settings SET value = '' WHERE key = 'digest_last_week' AND value = $1", [week]);
  }

  await audit({
    actor: { name: "system" },
    action: "digest.sent",
    details: { week, recipients: recipients.length, sent, failed },
  });
}
