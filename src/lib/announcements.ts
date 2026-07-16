// Announcement email delivery. The dashboard block is the source of truth —
// email is an optional extra blast chosen at post time (everyone, or selected
// groups). Fire-and-forget; a no-op when SMTP isn't configured. Server-only.

import "server-only";
import { listAnnouncementRecipients } from "./db";
import { getSmtpConfig, smtpConfigured } from "./smtp-config";
import { sendMail } from "./mailer";

const MAX_RECIPIENTS = 500;

export async function emailAnnouncement(input: {
  title: string;
  body: string;
  level: "info" | "warning" | "critical";
  authorName: string;
  orgName: string;
  groupIds: number[] | "all";
  origin?: string;
}): Promise<{ sent: number }> {
  if (!smtpConfigured(await getSmtpConfig())) return { sent: 0 };
  const recipients = (await listAnnouncementRecipients(input.groupIds)).slice(0, MAX_RECIPIENTS);
  if (recipients.length === 0) return { sent: 0 };

  const prefix = input.level === "critical" ? "❗ " : input.level === "warning" ? "⚠️ " : "";
  const subject = `${prefix}[${input.orgName}] ${input.title}`;
  const link = input.origin ? `${input.origin}/` : "";
  const text =
    `${input.title}\n\n${input.body}\n\n— ${input.authorName}` +
    (link ? `\n\nSee it on your dashboard: ${link}` : "");
  const html =
    `<h2 style="margin:0 0 12px">${escapeHtml(input.title)}</h2>` +
    `<p style="white-space:pre-line">${escapeHtml(input.body)}</p>` +
    `<p style="color:#64748b">— ${escapeHtml(input.authorName)}</p>` +
    (link
      ? `<p style="color:#64748b;font-size:13px"><a href="${link}">Open ${escapeHtml(input.orgName)}</a></p>`
      : "");

  let sent = 0;
  for (const r of recipients) {
    try {
      await sendMail([r.email], subject, text, html);
      sent++;
    } catch (e) {
      console.error(`Announcement email to ${r.email} failed:`, e);
    }
  }
  return { sent };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
