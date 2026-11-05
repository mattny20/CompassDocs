import { SearchClient } from "@/components/SearchClient";
import { getAppSettings } from "@/lib/settings-store";
import { requireUser } from "@/lib/auth";
import { canSeeDrafts, spaceScopeFor } from "@/lib/access";
import { listPopularDocuments, listSpaces } from "@/lib/db";
import { findScopeFor } from "@/lib/handbook-visibility";

export const dynamic = "force-dynamic";
export const metadata = { title: "Ask" };

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q } = await searchParams;
  const user = await requireUser();
  const [{ company_name }, scope] = await Promise.all([getAppSettings(), spaceScopeFor(user)]);
  // The first-run state (1.9.3): what people here read most, scoped to this
  // viewer, and the spaces they can narrow to.
  const [popular, spaces] = await Promise.all([
    // Handbooks 1.18.0 (H6): handbook-only documents stay out of a reader's suggestions.
    listPopularDocuments(scope, await canSeeDrafts(user), 6, await findScopeFor(user)),
    listSpaces(scope),
  ]);
  return (
    <SearchClient
      initialQuery={q ?? ""}
      companyName={company_name}
      popular={popular.map((d) => ({ id: d.id, title: d.title, type: d.type, space_name: d.space_name, space_icon: d.space_icon }))}
      spaceSlugs={spaces.slice(0, 6).map((s) => s.slug)}
    />
  );
}
