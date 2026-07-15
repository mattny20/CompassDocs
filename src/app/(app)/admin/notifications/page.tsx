import { requireRole } from "@/lib/auth";
import { listWebhooks } from "@/lib/db";
import { WebhooksPanel } from "@/components/WebhooksPanel";

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
  const hooks = await listWebhooks();
  return (
    <WebhooksPanel
      initial={hooks.map((h) => ({
        id: h.id,
        name: h.name,
        url_preview: maskUrl(h.url),
        format: h.format,
        events: h.events,
        enabled: h.enabled === 1,
        last_sent_at: h.last_sent_at,
        last_status: h.last_status,
      }))}
    />
  );
}
