import { requireSettingsSection } from "@/lib/auth";
import { listWebhooks, listSpaces } from "@/lib/db";
import { featureEnabled } from "@/lib/ee";
import { WebhooksPanel } from "@/components/WebhooksPanel";
import { EVERY_SPACE_UNFILTERED } from "@/lib/space-scope";

import { settingsMetadata } from "@/lib/settings-sections";
export const dynamic = "force-dynamic";
export const metadata = settingsMetadata("/admin/notifications", "Webhooks");

function maskUrl(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname.length > 18 ? u.pathname.slice(0, 12) + "…" : u.pathname;
    return `${u.origin}${path}`;
  } catch {
    return url.slice(0, 30) + "…";
  }
}

export default async function WebhooksPage() {
  await requireSettingsSection("/admin/notifications");
  // The five compliance events (H3, 1.14.0) are offered only while read
  // confirmations are licensed; the route validates against WEBHOOK_EVENTS
  // either way, so a hook saved with one keeps it.
  const [hooks, spaces, licensed] = await Promise.all([
    listWebhooks(),
    listSpaces(EVERY_SPACE_UNFILTERED),
    featureEnabled("policy_ack"),
  ]);
  return (
    <WebhooksPanel
      licensed={licensed}
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
  );
}
