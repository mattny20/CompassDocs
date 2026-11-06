// POST /api/helpdesk/admin/retention/preview   { settings? } → { plan, sentence }
// Helpdesk 1.19.1 (desk capability settings.manage): the dry run. What the next nightly
// run would close, anonymise or delete, with the settings sent (the page's unsaved
// choices; none = the saved ones) and the first 50 tickets of each kind. Reads only,
// with the same SQL as the run (lib/helpdesk/retention planRetention).

import { NextResponse } from "next/server";
import { readJson } from "@/lib/helpdesk/access";
import { hdCapGate } from "@/lib/helpdesk/roles";
import { getRetentionSettings, planRetention } from "@/lib/helpdesk/retention";
import { normalizeRetention, planSentence, retentionPatchError } from "@/lib/helpdesk/retention-shared";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const gate = await hdCapGate("settings.manage");
  if (gate instanceof NextResponse) return gate;
  const body = (await readJson(req, 8 * 1024)) ?? {};
  const draft = body.settings && typeof body.settings === "object" ? (body.settings as Record<string, unknown>) : null;
  if (draft) {
    const err = retentionPatchError(draft);
    if (err) return NextResponse.json({ error: err }, { status: 400 });
  }
  const settings = draft ? normalizeRetention({ ...(await getRetentionSettings()), ...draft }) : await getRetentionSettings();
  const plan = await planRetention({ settings, listLimit: 50 });
  return NextResponse.json({ plan, sentence: planSentence(plan) });
}
