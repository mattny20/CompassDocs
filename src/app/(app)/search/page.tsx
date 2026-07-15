import { SearchClient } from "@/components/SearchClient";
import { getAppSettings } from "@/lib/settings-store";

export const dynamic = "force-dynamic";

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q } = await searchParams;
  const { company_name } = await getAppSettings();
  return <SearchClient initialQuery={q ?? ""} companyName={company_name} />;
}
