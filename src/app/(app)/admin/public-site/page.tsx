import { requireRole } from "@/lib/auth";
import { getPublicSiteConfig } from "@/lib/public-site";
import { listPublicSpaces } from "@/lib/db";
import { PublicSitePanel } from "@/components/PublicSitePanel";

export const dynamic = "force-dynamic";

export default async function PublicSiteAdminPage() {
  await requireRole("admin");
  const [config, spaces] = await Promise.all([getPublicSiteConfig(), listPublicSpaces()]);
  return (
    <PublicSitePanel
      initial={config}
      publicSpaces={spaces.map((s) => ({ id: s.id, name: s.name, slug: s.slug, doc_count: s.doc_count }))}
    />
  );
}
