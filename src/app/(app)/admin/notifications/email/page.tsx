import Link from "next/link";
import { requireSettingsSection } from "@/lib/auth";
import { SmtpPanel } from "@/components/WebhooksPanel";
import { getSmtpConfig, smtpConfigured } from "@/lib/smtp-config";
import { EMAIL_TEMPLATES, templateOverride } from "@/lib/email-templates";

import { settingsMetadata } from "@/lib/settings-sections";
export const dynamic = "force-dynamic";
export const metadata = settingsMetadata("/admin/notifications", "Email");

export default async function EmailPage() {
  await requireSettingsSection("/admin/notifications");
  const smtp = await getSmtpConfig();
  const customized = (
    await Promise.all(EMAIL_TEMPLATES.map((t) => templateOverride(t.key)))
  ).filter(Boolean).length;
  return (
    <div>
      <SmtpPanel
        initial={{
          host: smtp.host,
          port: smtp.port,
          secure: smtp.secure,
          user: smtp.user,
          has_pass: Boolean(smtp.pass),
          from: smtp.from,
          configured: smtpConfigured(smtp),
        }}
      />
      <p className="mt-6 text-sm text-slate-500">
        {customized > 0
          ? `${customized} of ${EMAIL_TEMPLATES.length} email templates are customized.`
          : `All ${EMAIL_TEMPLATES.length} email templates are at their defaults.`}{" "}
        <Link href="/admin/notifications/templates" className="link font-medium">
          Edit email templates
        </Link>
      </p>
    </div>
  );
}
