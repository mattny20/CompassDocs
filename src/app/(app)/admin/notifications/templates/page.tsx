import { requireRole } from "@/lib/auth";
import { EMAIL_TEMPLATES, templateOverride } from "@/lib/email-templates";
import { EmailTemplatesPanel } from "@/components/EmailTemplatesPanel";

export const dynamic = "force-dynamic";

export default async function EmailTemplatesPage() {
  await requireRole("admin");
  const initial = await Promise.all(
    EMAIL_TEMPLATES.map(async (t) => {
      const override = await templateOverride(t.key);
      return {
        key: t.key,
        label: t.label,
        description: t.description,
        tags: t.tags,
        default_subject: t.subject,
        default_body: t.body,
        subject: override?.subject ?? t.subject,
        body: override?.body ?? t.body,
        customized: !!override,
      };
    })
  );
  return <EmailTemplatesPanel initial={initial} />;
}
