import { requireRole } from "@/lib/auth";
import { listWebhooks, listSpaces } from "@/lib/db";
import { WebhooksPanel, SmtpPanel } from "@/components/WebhooksPanel";
import { getSmtpConfig, smtpConfigured } from "@/lib/smtp-config";

export const dynamic = "force-dynamic";

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
  await requireRole("admin");
  const [hooks, spaces, smtp] = await Promise.all([listWebhooks(), listSpaces(), getSmtpConfig()]);
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
    </div>
  );
}