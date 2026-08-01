import { requireRole } from "@/lib/auth";
import { listTemplates } from "@/lib/doc-templates";
import { TemplatesPanel } from "@/components/TemplatesPanel";
import { SettingsPage } from "@/components/SettingsPage";

export const dynamic = "force-dynamic";

export default async function TemplatesPage() {
  await requireRole("admin");
  const templates = await listTemplates(true);
  return <SettingsPage href="/admin/templates"><TemplatesPanel initial={templates} /></SettingsPage>;
}
