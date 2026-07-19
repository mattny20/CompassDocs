import "server-only";
import { createAnnouncement } from "./db";
import { getSmtpConfig, smtpConfigured } from "./smtp-config";
import { sendMail } from "./mailer";
import { getAppSettings } from "./settings-store";

// Notifications for the central compliance portal: when an admin requests
// acknowledgement of a document (or sends a reminder), every affected user
// gets a targeted dashboard notice and an email with a direct link.
//
// Compliance emails deliberately do NOT honor the personal notification-email
// switch — an acknowledgement request is a workplace requirement, not a
// courtesy update. (Documented in the admin guide.)

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export async function notifyAckRequest(input: {
  docId: number;
  docTitle: string;
  users: { id: number; name: string; email: string }[];
  requesterId: number;
  requesterName: string;
  origin: string;
  mode: "request" | "reminder";
}): Promise<{ emailed: number; noticed: number }> {
  const url = `${input.origin}/doc/${input.docId}`;
  const org = (await getAppSettings()).company_name || "CompassDocs";
  const mailReady = smtpConfigured(await getSmtpConfig());
  const verb = input.mode === "reminder" ? "Reminder" : "Action required";

  let emailed = 0;
  let noticed = 0;
  for (const target of input.users) {
    try {
      await createAnnouncement({
        title: `${verb}: acknowledge "${input.docTitle}"`,
        body:
          input.mode === "reminder"
            ? `You still need to read and acknowledge "${input.docTitle}".`
            : `Please read and acknowledge "${input.docTitle}".`,
        level: "warning",
        author_name: input.requesterName,
        created_by: input.requesterId,
        expires_days: 30,
        target_user_id: target.id,
        link: `/doc/${input.docId}`,
      });
      noticed++;
    } catch (e) {
      console.error(`Ack announcement for user ${target.id} failed:`, e);
    }

    if (!mailReady || !target.email) continue;
    try {
      const subject = `[${org}] ${verb}: acknowledge "${input.docTitle}"`;
      const text =
        `${input.requesterName} ${input.mode === "reminder" ? "sent a reminder" : "requested"} that you read and acknowledge:\n\n` +
        `  ${input.docTitle}\n\n` +
        `Open the document and click "I've read and understood": ${url}\n\n` +
        `This acknowledgement is recorded for compliance.`;
      const html =
        `<p><strong>${esc(input.requesterName)}</strong> ${
          input.mode === "reminder" ? "sent a reminder" : "requested"
        } that you read and acknowledge:</p>` +
        `<p style="margin:12px 0;padding:10px 14px;border-left:3px solid #d97706;background:#fffbeb"><strong>${esc(input.docTitle)}</strong></p>` +
        `<p><a href="${url}">Open the document</a> and click <em>"I've read and understood"</em>.</p>` +
        `<p style="color:#64748b;font-size:13px">This acknowledgement is recorded for compliance.</p>`;
      await sendMail([target.email], subject, text, html);
      emailed++;
    } catch (e) {
      console.error(`Ack email to ${target.email} failed:`, e);
    }
  }
  return { emailed, noticed };
}
