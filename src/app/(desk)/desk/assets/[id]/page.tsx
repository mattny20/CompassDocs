// /desk/assets/[id]: one asset's page (1.19.3; mock-up i2): its details,
// the tickets on it the viewer may open and its maintenance in Snipe-IT.
// Agents only; the route answers 404 for an asset they may not see.

import { requireUser } from "@/lib/auth";
import { notFound } from "next/navigation";
import { DeskPageForbidden } from "@/components/helpdesk/desk/DeskGate";
import { AssetPageView } from "@/components/helpdesk/desk/assets/AssetPage";
import { deskRoleCaps } from "../../../desk-access";

export const dynamic = "force-dynamic";
export const metadata = { title: "Asset" };

export default async function AssetPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!(await deskRoleCaps(user)).role) return <DeskPageForbidden what="Assets" />;
  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0) notFound();
  return (
    <div className="min-w-0 flex-1 overflow-y-auto">
      <AssetPageView id={id} />
    </div>
  );
}
