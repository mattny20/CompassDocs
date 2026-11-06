// /desk/assets: search the asset list (1.19.3, lib/helpdesk/assets). Agents only.

import { requireUser } from "@/lib/auth";
import { DeskPageForbidden } from "@/components/helpdesk/desk/DeskGate";
import { AssetSearch } from "@/components/helpdesk/desk/assets/AssetSearch";
import { deskRoleCaps } from "../../desk-access";

export const dynamic = "force-dynamic";
export const metadata = { title: "Assets" };

export default async function AssetsPage() {
  const user = await requireUser();
  if (!(await deskRoleCaps(user)).role) return <DeskPageForbidden what="Assets" />;
  return (
    <div className="min-w-0 flex-1 overflow-y-auto">
      <AssetSearch />
    </div>
  );
}
