// GET /api/helpdesk/assets?q= → { assets: HdAsset[], search_all, notice }: the desk's asset search
// (tag, serial, name, model or person). Every asset with "Agents can search all assets" on, else
// only the agent's people's. While Snipe-IT isn't connected, only assets linked to tickets
// (with a notice). 1.19.4: each with its Intune line; a disconnected source's assets only where a
// ticket links them; an Intune device a Snipe-IT asset stands for is listed once, as that asset.
// Helpdesk 1.19.3 (lib/helpdesk/assets). Agents only.

import { NextResponse } from "next/server";
import { helpdeskGate } from "@/lib/helpdesk/access";
import { ASSET_LIMITS, getAssetSettings, searchAssets, views } from "@/lib/helpdesk/assets";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const gate = await helpdeskGate("agent");
  if (gate instanceof NextResponse) return gate;
  const q = (new URL(req.url).searchParams.get("q") ?? "").slice(0, ASSET_LIMITS.q);
  const settings = await getAssetSettings();
  const { rows, notice } = await searchAssets(gate, q, { settings, limit: 50 });
  return NextResponse.json({ assets: await views(rows, settings), search_all: settings.agents_search_all, notice });
}
