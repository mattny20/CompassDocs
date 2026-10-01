import { requireSettingsSection } from "@/lib/auth";
import { listTemplates } from "@/lib/doc-templates";
import { TemplatesPanel } from "@/components/TemplatesPanel";
import { SettingsPage } from "@/components/SettingsPage";

import { settingsMetadata } from "@/lib/settings-sections";
export const dynamic = "force-dynamic";
export const metadata = settingsMetadata("/admin/templates");

export default async function TemplatesPage() {
  await requireSettingsSection("/admin/templates");
  const templates = await listTemplates(true);
  return <SettingsPage href="/admin/templates"><TemplatesPanel initial={templates} /></SettingsPage>;
}
