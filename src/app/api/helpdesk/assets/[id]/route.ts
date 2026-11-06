// GET /api/helpdesk/assets/[id] → HdAssetPage: the asset's details (refreshed from the source when
// it answers), the tickets on it the viewer may open (the rest only counted) and its maintenance
// records from the source. 404 for an asset the agent may not see (not one of their people's,
// with "Agents can search all assets" off), that does not exist, or, while its source isn't
// connected, that no ticket links.
// Helpdesk 1.19.3 (lib/helpdesk/assets; mock-up i2). Agents only.

import { NextResponse } from "next/server";
import { helpdeskGate } from "@/lib/helpdesk/access";
import { notFound } from "@/lib/helpdesk/routes";
import { assetPage } from "@/lib/helpdesk/assets";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Ctx) {
  const gate = await helpdeskGate("agent");
  if (gate instanceof NextResponse) return gate;
  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0) return notFound();
  const page = await assetPage(gate, id);
  return page ? NextResponse.json(page) : notFound();
}
