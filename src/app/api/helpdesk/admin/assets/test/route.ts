// POST /api/helpdesk/admin/assets/test  { url?, api_key? } → { ok: true, total } | { ok: false, error }
//      1.20.2: { provider: "intune", tenant?, client_id?, secret? } tests Intune: the typed app registration
//      (a saved secret stands in for an empty one, for the same tenant and client ID only), or the one in use.
//      → { ok: true, total, tenant } (the tenant ID signed in to) | { ok: false, error }
// Tests the typed address and key, or the saved ones. A saved key is only sent to the address it
// was saved for. Changes nothing, so it is not audited. Helpdesk 1.19.3 (lib/helpdesk/assets).
// Desk capability settings.manage.

import { NextResponse } from "next/server";
import { readJson } from "@/lib/helpdesk/access";
import { hdCapGate } from "@/lib/helpdesk/roles";
import { checkIntuneCredentials, getAssetSettings, testConnection, testIntune } from "@/lib/helpdesk/assets";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const gate = await hdCapGate("settings.manage");
  if (gate instanceof NextResponse) return gate;
  const b = (await readJson(req, 16 * 1024)) ?? {};
  if (b.provider === "intune") {
    let given;
    if (b.tenant !== undefined || b.client_id !== undefined || b.secret !== undefined) {
      const c = checkIntuneCredentials(b, (await getAssetSettings()).intune);
      if (!c.ok) return NextResponse.json({ ok: false, error: c.error });
      given = c.value;
    }
    const r = await testIntune(given);
    return NextResponse.json(r.ok ? { ok: true, total: r.total, tenant: r.tenant } : r);
  }
  return NextResponse.json(await testConnection({ url: b.url, api_key: b.api_key }));
}
