import { listSpaces } from "@/lib/db";
import { SpacesManager } from "@/components/SpacesManager";

export const dynamic = "force-dynamic";

export default async function SpacesPage() {
  const spaces = await listSpaces();
  return <SpacesManager initial={spaces} />;
}
