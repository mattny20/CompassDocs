import Link from "next/link";
import { requireSettingsSection } from "@/lib/auth";
import { listWebhooks, listSpaces } from "@/lib/db";
import { WebhooksPanel, SmtpPanel } from "@/components/WebhooksPanel";
import { ChatAskPanel } from "@/components/ChatAskPanel";
import { getSmtpConfig, smtpConfigured } from "@/lib/smtp-config";
import { EMAIL_TEMPLATES, templateOverride } from "@/lib/email-templates";
import { getChatAskConfig } from "@/lib/chat-ask";
import { getAppSettings } from "@/lib/settings-store";
import { EVERY_SPACE_UNFILTERED } from "@/lib/space-scope";

import { settingsMetadata } from "@/lib/settings-sections";
export const dynamic = "force-dynamic";
export const metadata = settingsMetadata("/admin/notifications");

function maskUrl(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname.length > 18 ? u.pathname.slice(0, 12) + "…" : u.pathname;
    return `${u.origin}${path}`;
  } catch {
    return url.slice(0, 30) + "…";
  }
}

export default async function NotificationsPage() {
  await requireSettingsSection("/admin/notifications");
  const [hooks, spaces, smtp, chatAsk, appSettings] = await Promise.all([
    listWebhooks(),
    listSpaces(EVERY_SPACE_UNFILTERED),
    getSmtpConfig(),
    getChatAskConfig(),
    getAppSettings(),
  ]);
  const chatBase = appSettings.custom_domain
    ? `https://${appSettings.custom_domain}`
    : "https://your-domain";
  const customized = (
    await Promise.all(EMAIL_TEMPLATES.map((t) => templateOverride(t.key)))
  ).filter(Boolean).length;
  return (
    <div>
    <WebhooksPanel
      spaces={spaces.map((sp) => ({ id: sp.id, name: sp.name }))}
      initial={hooks.map((h) => ({
        id: h.id,
        name: h.name,
        url_preview: h.format === "email" ? h.url : maskUrl(h.url),
        format: h.format,
        events: h.events,
        space_ids: h.space_ids ?? [],
        enabled: h.enabled === 1,
        last_sent_at: h.last_sent_at,
        last_status: h.last_status,
      }))}
    />
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
    <div className="mt-6">
      <ChatAskPanel initial={chatAsk} baseUrl={chatBase} />
    </div>
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