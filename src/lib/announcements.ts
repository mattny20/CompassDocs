// Announcement email delivery. The dashboard block is the source of truth —
// email is an optional extra blast chosen at post time (everyone, or selected
// groups). Fire-and-forget; a no-op when SMTP isn't configured. Server-only.

import "server-only";
import { listAnnouncementRecipients } from "./db";
import { getSmtpConfig, smtpConfigured } from "./smtp-config";
import { sendMail } from "./mailer";
import { renderEmail } from "./email-templates";

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
  const { subject, text, html } = await renderEmail(
    "announcement",
    {
      title: input.title,
      body: input.body,
      author_name: input.authorName,
      org_name: input.orgName,
      dashboard_url: input.origin ? `${input.origin}/` : "",
      level_prefix: prefix,
    },
    input.origin ?? ""
  );

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
