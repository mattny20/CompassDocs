import { requireRole } from "@/lib/auth";
import { listNewsletters, listGroups } from "@/lib/db";
import { getSmtpConfig, smtpConfigured } from "@/lib/smtp-config";
import { NewsletterComposer } from "@/components/NewsletterComposer";

export const dynamic = "force-dynamic";

export default async function NewsletterAdminPage() {
  await requireRole("admin");
  const [newsletters, groups, smtp] = await Promise.all([
    listNewsletters(),
    listGroups(),
    getSmtpConfig(),
  ]);
  return (
    <NewsletterComposer
      initial={newsletters}
      groups={groups.map((g) => ({ id: g.id, name: g.name, member_count: g.member_count }))}
      smtpReady={smtpConfigured(smtp)}
    />
  );
}
