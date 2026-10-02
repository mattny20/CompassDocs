import { requireSettingsSection } from "@/lib/auth";
import { listWebhooks, listSpaces } from "@/lib/db";
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
  const [hooks, spaces] = await Promise.all([listWebhooks(), listSpaces(EVERY_SPACE_UNFILTERED)]);
  return (
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
  );
}
