import Link from "next/link";
import { MailPlus, ChevronRight } from "lucide-react";
import { requireRole } from "@/lib/auth";
import { listWebhooks, listSpaces } from "@/lib/db";
import { WebhooksPanel, SmtpPanel } from "@/components/WebhooksPanel";
import { getSmtpConfig, smtpConfigured } from "@/lib/smtp-config";
import { EMAIL_TEMPLATES, templateOverride } from "@/lib/email-templates";

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
  const customized = (
    await Promise.all(EMAIL_TEMPLATES.map((t) => templateOverride(t.key)))
  ).filter(Boolean).length;
  return (
    <div>
    <Link
      href="/admin/notifications/templates"
      className="mb-6 flex items-center gap-3 rounded-xl border border-slate-200 bg-surface px-4 py-3 shadow-sm transition hover:border-compass-300 hover:bg-compass-50/40"
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-compass-50 text-compass-600">
        <MailPlus className="h-5 w-5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block font-medium text-slate-800">Email templates</span>
        <span className="block text-sm text-slate-500">
          Edit the subject and body of every alert email — dynamic tags, doc editor, reset to
          default.{" "}
          {customized > 0
            ? `${customized} of ${EMAIL_TEMPLATES.length} customized.`
            : `${EMAIL_TEMPLATES.length} templates, all defaults.`}
        </span>
      </span>
      <ChevronRight className="h-4 w-4 shrink-0 text-slate-400" />
    </Link>
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