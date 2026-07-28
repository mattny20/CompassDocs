import "server-only";
import { notify } from "./notifications";
import { getSmtpConfig, smtpConfigured } from "./smtp-config";
import { sendMail } from "./mailer";
import { renderEmail } from "./email-templates";

// Notifications for the central compliance portal: when an admin requests
// acknowledgement of a document (or sends a reminder), every affected user
// gets an inbox notification (the sidebar bell) and an email with a direct
// link.
//
// Compliance emails deliberately do NOT honor the personal notification-email
// switch — an acknowledgement request is a workplace requirement, not a
// courtesy update. (Documented in the admin guide.)

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
  const mailReady = smtpConfigured(await getSmtpConfig());
  const verb = input.mode === "reminder" ? "Reminder" : "Action required";

  // Same message for every target, so render the template once.
  let mail: { subject: string; text: string; html: string } | null = null;
  if (mailReady) {
    try {
      mail = await renderEmail(
        "ack_request",
        {
          requester_name: input.requesterName,
          doc_title: input.docTitle,
          doc_url: url,
          request_type: input.mode === "reminder" ? "sent a reminder" : "requested",
          request_label: verb,
        },
        input.origin
      );
    } catch (e) {
      console.error("Ack email render failed:", e);
    }
  }

  let emailed = 0;
  let noticed = 0;
  try {
    await notify(
      input.users.map((u) => u.id),
      {
        kind: "ack_requested",
        title: `${verb}: acknowledge "${input.docTitle}"`,
        body:
          input.mode === "reminder"
            ? `You still need to read and acknowledge "${input.docTitle}".`
            : `Please read and acknowledge "${input.docTitle}".`,
        link: `/doc/${input.docId}`,
        actorName: input.requesterName,
        origin: input.origin,
      }
    );
    noticed = input.users.length;
  } catch (e) {
    console.error("Ack inbox notifications failed:", e);
  }

  // Per-user routing: skip anyone who turned the ack email channel off.
  const { getNotifyPrefsFor } = await import("./db");
  const { notifyPrefAllows } = await import("./notifications");
  const prefs = await getNotifyPrefsFor(input.users.map((u) => u.id)).catch(
    () => new Map<number, Record<string, Record<string, boolean>>>()
  );
  for (const target of input.users) {
    if (!mail || !target.email) continue;
    if (!notifyPrefAllows(prefs.get(target.id), "ack_requested", "email")) continue;
    try {
      await sendMail([target.email], mail.subject, mail.text, mail.html);
      emailed++;
    } catch (e) {
      console.error(`Ack email to ${target.email} failed:`, e);
    }
  }
  return { emailed, noticed };
}
