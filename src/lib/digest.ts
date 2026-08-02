// Weekly digest email: a personal Monday-morning summary for users who opt in
// (Account → Notifications). Per recipient it collects, scoped to what THEY
// can see: what changed in their subscribed spaces this week, reviews they
// should handle (approvers/admins), and the week's most-read documents. Users
// with nothing to report get no email at all.
//
// Timing: the hourly instrumentation tick calls maybeSendWeeklyDigests().
// Each recipient gets their digest on the first tick at/after Monday 08:00
// in THEIR time zone (Account → Preferences; empty = server time), claimed
// per user through an atomic users.digest_last_week update — safe across
// instances. Ticks later in the same ISO week still catch up missed sends.

import "server-only";
import { pool, getSetting } from "./db";
import { sendMail } from "./mailer";
import { formatDate, settingsForUser } from "./format";
import { smtpConfigured, getSmtpConfig } from "./smtp-config";
import { audit } from "./audit";

async function q<T = any>(sql: string, params: any[] = []): Promise<T[]> {
  return (await pool().query(sql, params)).rows as T[];
}

const SEND_DOW = 1; // Monday
const SEND_HOUR = 8; // first hourly tick at/after 08:00 local
const MAX_ROWS = 8; // per section

function isoWeekYmd(year: number, month0: number, day: number): string {
  // ISO-8601 week id, e.g. "2026-W31", from a calendar date.
  const t = new Date(Date.UTC(year, month0, day));
  const dow = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - dow);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

const DOW: Record<string, number> = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };

/** The wall clock in a recipient's zone: ISO day (0=Mon), hour, ISO week id. */
function localParts(
  now: Date,
  tz: string
): { isoDay: number; hour: number; week: string } | null {
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tz || undefined, // empty → server zone
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      hour12: false,
      weekday: "short",
    });
    const p = Object.fromEntries(fmt.formatToParts(now).map((x) => [x.type, x.value]));
    const isoDay = DOW[p.weekday as string];
    if (isoDay === undefined) return null;
    return {
      isoDay,
      hour: Number(p.hour) % 24,
      week: isoWeekYmd(Number(p.year), Number(p.month) - 1, Number(p.day)),
    };
  } catch {
    return null; // bad stored zone — skip rather than guess
  }
}

/** Claim this week's send for one user. True exactly once per ISO week. */
async function claimUserWeek(userId: number, week: string): Promise<boolean> {
  const rows = await q(
    "UPDATE users SET digest_last_week = $1 WHERE id = $2 AND digest_last_week <> $1 RETURNING id",
    [week, userId]
  );
  return rows.length > 0;
}

interface DigestRow {
  id: number;
  title: string;
  space_name: string;
  extra?: string;
  /** Raw ISO instant for rows whose `extra` is a date (see the reviews query). */
  extra_at?: string;
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
  if (!smtpConfigured(await getSmtpConfig())) return;

  const recipients = await q<{
    id: number;
    email: string;
    name: string;
    role: string;
    timezone: string;
    date_format: string;
    digest_last_week: string;
  }>(
    `SELECT id, email, name, role, timezone, date_format, digest_last_week FROM users
     WHERE status = 'active' AND email <> '' AND email_notifications = 1 AND weekly_digest = 1`
  );
  if (recipients.length === 0) return;

  // Pre-0.73 the claim was one global settings row. Seed unclaimed users from
  // it once so the release week isn't sent twice.
  const legacyWeek = (await getSetting("digest_last_week"))?.trim() ?? "";

  // Origin for links: the configured custom domain (same fallback the
  // subscriber emails use).
  let origin = "";
  const domain = (await getSetting("custom_domain"))?.trim();
  if (domain) origin = `https://${domain}`;

  // Zone fallback chain: personal preference → workspace zone → server zone.
  const { getAppSettings } = await import("./settings-store");
  const workspaceSettings = await getAppSettings();
  const workspaceTz = workspaceSettings.timezone || "";

  let sent = 0;
  let failed = 0;
  let claimedWeek = ""; // for the audit line (weeks can differ across zones)
  for (const u of recipients) {
    // Send window: any tick from Monday 08:00 local time through Sunday of
    // the same ISO week may claim it — an instance down on Monday still
    // catches up instead of silently dropping the week.
    const local = localParts(now, u.timezone || workspaceTz);
    if (!local) continue;
    if (local.isoDay === 0 && local.hour < SEND_HOUR) continue;
    if (u.digest_last_week === "" && legacyWeek === local.week) {
      await claimUserWeek(u.id, local.week);
      continue;
    }
    if (!(await claimUserWeek(u.id, local.week))) continue;
    claimedWeek = local.week;
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
                      d.review_due_at AS extra_at
               FROM documents d JOIN spaces s ON s.id = d.space_id
               WHERE d.deleted_at IS NULL AND d.branch_of IS NULL
                 AND d.review_due_at IS NOT NULL AND d.review_due_at < now() + interval '7 days'
                 ${scopeFilter}
               ORDER BY d.review_due_at ASC
               LIMIT ${MAX_ROWS}`,
              u.role === "admin" ? [] : [u.id]
            ).then((rows) =>
              rows.map((r) => ({
                ...r,
                extra: formatDate(r.extra_at, settingsForUser(workspaceSettings, u)),
              }))
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
      // Release this user's claim so a later tick this week retries, instead
      // of marking their week silently done.
      await q("UPDATE users SET digest_last_week = '' WHERE id = $1 AND digest_last_week = $2", [
        u.id,
        local.week,
      ]).catch(() => {});
    }
  }

  if (sent > 0 || failed > 0) {
    await audit({
      actor: { name: "system" },
      action: "digest.sent",
      details: { week: claimedWeek, recipients: recipients.length, sent, failed },
    });
  }
}
