import { requireRole } from "@/lib/auth";
import { listTemplates } from "@/lib/doc-templates";
import { TemplatesPanel } from "@/components/TemplatesPanel";

export const dynamic = "force-dynamic";

export default async function TemplatesPage() {
  await requireRole("admin");
  const templates = await listTemplates(true);
  return <TemplatesPanel initial={templates} />;
}
