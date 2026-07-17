// Sends scheduled newsletters when their time arrives. Driven by the
// instrumentation tick (once a minute); claimDueNewsletters() clears
// scheduled_at atomically, so multiple app instances can tick concurrently
// without double-sending. Server-only.

import "server-only";
import { join } from "path";
import {
  claimDueNewsletters,
  markNewsletterSent,
  addNewsletterComment,
  listGroups,
  listNewsletterFiles,
} from "./db";
import { sendNewsletter, archiveNewsletter } from "./newsletter";
import { getAppSettings } from "./settings-store";
import { uploadDir } from "./uploads";
import { audit } from "./audit";

export async function sendDueNewsletters(): Promise<void> {
  const due = await claimDueNewsletters();
  if (due.length === 0) return;

  const settings = await getAppSettings();
  for (const n of due) {
    try {
      const groupIds = (n.group_ids || "").split(",").map(Number).filter(Boolean);
      const r = await sendNewsletter({
        subject: n.subject,
        markdown: n.body,
        orgName: settings.company_name || "CompassDocs",
        logoUrl: settings.logo_url || "",
        accent: settings.accent_color || "#2e75bd",
        origin: n.scheduled_origin || "",
        authorName: n.author_name,
        to: n.mode === "groups" ? groupIds : "all",
        from: n.from_address || undefined,
        attachments: (await listNewsletterFiles(n.id)).map((f) => ({
          filename: f.filename,
          path: join(uploadDir(), f.stored_name),
        })),
      });
      if (r.error) {
        // Sending isn't possible right now (SMTP off, no recipients). Leave
        // the piece approved with the schedule cleared and say why in the
        // thread, so an approver can fix the cause and send manually.
        await addNewsletterComment({
          newsletter_id: n.id,
          user_id: null,
          author_name: "Scheduler",
          body: `Scheduled send failed: ${r.error}`,
          kind: "comment",
        });
        console.error(`[newsletter] scheduled send of #${n.id} failed: ${r.error}`);
        continue;
      }

      let audience = "Everyone";
      if (n.mode === "groups") {
        const names = (await listGroups()).filter((g) => groupIds.includes(g.id)).map((g) => g.name);
        audience = `Groups: ${names.join(", ") || groupIds.join(", ")}`;
      }
      await markNewsletterSent(n.id, audience, r.sent);
      await addNewsletterComment({
        newsletter_id: n.id,
        user_id: null,
        author_name: "Scheduler",
        body: `Sent as scheduled to ${audience.toLowerCase() === "everyone" ? "everyone" : audience} — ${r.sent} ${r.sent === 1 ? "recipient" : "recipients"}.`,
        kind: "sent",
      });
      const archivedDocId = await archiveNewsletter(n);
      if (archivedDocId) {
        await addNewsletterComment({
          newsletter_id: n.id,
          user_id: null,
          author_name: "Archive",
          body: `Filed in the archive space as document #${archivedDocId}.`,
          kind: "comment",
        });
      }
      await audit({
        actor: { name: "system" },
        action: "newsletter.sent",
        targetType: "newsletter",
        targetId: n.id,
        targetLabel: n.subject,
        details: { audience, sent: r.sent, scheduled: true },
      });
    } catch (e) {
      // Deliberately no auto-retry: a crash mid-send could have already
      // delivered to some recipients, and resending would double up. The
      // piece stays approved (schedule cleared) for a human to re-send.
      console.error(`[newsletter] scheduled send of #${n.id} crashed:`, e);
      await addNewsletterComment({
        newsletter_id: n.id,
        user_id: null,
        author_name: "Scheduler",
        body: "Scheduled send hit an unexpected error — check the server logs and send manually.",
        kind: "comment",
      }).catch(() => {});
    }
  }
}
