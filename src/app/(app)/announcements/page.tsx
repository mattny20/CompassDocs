import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { canAccessSection } from "@/lib/section-access";
import { listAllAnnouncements, listGroups, listWebhooks } from "@/lib/db";
import { getSmtpConfig, smtpConfigured } from "@/lib/smtp-config";
import { AnnouncementsAdmin } from "@/components/AnnouncementsAdmin";
import { PageContainer } from "@/components/PageWidth";

export const dynamic = "force-dynamic";

// Operational home for announcements (main navigation). Admins plus anyone
// granted the Announcements section (Settings → Section access).

export default async function AnnouncementsPage() {
  const user = await requireUser();
  if (!(await canAccessSection(user, "announcements"))) redirect("/");
  const [announcements, groups, hooks, smtp] = await Promise.all([
    listAllAnnouncements(),
    listGroups(),
    listWebhooks(),
    getSmtpConfig(),
  ]);
  return (
    <PageContainer>
    <AnnouncementsAdmin
      initial={announcements}
      groups={groups.map((g) => ({ id: g.id, name: g.name, member_count: g.member_count }))}
      smtpReady={smtpConfigured(smtp)}
      webhookCount={
        hooks.filter((h) => h.enabled === 1 && (h.events ?? []).includes("announcement.posted"))
          .length
      }
    />
    </PageContainer>
  );
}
