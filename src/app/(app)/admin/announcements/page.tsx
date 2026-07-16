import { requireRole } from "@/lib/auth";
import { listAllAnnouncements, listGroups, listWebhooks } from "@/lib/db";
import { getSmtpConfig, smtpConfigured } from "@/lib/smtp-config";
import { AnnouncementsAdmin } from "@/components/AnnouncementsAdmin";

export const dynamic = "force-dynamic";

export default async function AnnouncementsAdminPage() {
  await requireRole("admin");
  const [announcements, groups, hooks, smtp] = await Promise.all([
    listAllAnnouncements(),
    listGroups(),
    listWebhooks(),
    getSmtpConfig(),
  ]);
  return (
    <AnnouncementsAdmin
      initial={announcements}
      groups={groups.map((g) => ({ id: g.id, name: g.name, member_count: g.member_count }))}
      smtpReady={smtpConfigured(smtp)}
      webhookCount={
        hooks.filter((h) => h.enabled === 1 && (h.events ?? []).includes("announcement.posted"))
          .length
      }
    />
  );
}
