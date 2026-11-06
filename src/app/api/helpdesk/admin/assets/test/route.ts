// POST /api/helpdesk/admin/assets/test  { url?, api_key? } → { ok: true, total } | { ok: false, error }
// Tests the typed address and key, or the saved ones. A saved key is only sent to the address it
// was saved for. Changes nothing, so it is not audited. Helpdesk 1.19.3 (lib/helpdesk/assets).
// Desk capability settings.manage.

import { NextResponse } from "next/server";
import { readJson } from "@/lib/helpdesk/access";
import { hdCapGate } from "@/lib/helpdesk/roles";
import { testConnection } from "@/lib/helpdesk/assets";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const gate = await hdCapGate("settings.manage");
  if (gate instanceof NextResponse) return gate;
  const b = (await readJson(req, 16 * 1024)) ?? {};
  return NextResponse.json(await testConnection({ url: b.url, api_key: b.api_key }));
}
