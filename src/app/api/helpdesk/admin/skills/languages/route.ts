// POST /api/helpdesk/admin/skills/languages   { code } → 201   add a language to the workspace (ISO 639-1)
// Helpdesk 1.19.2 (agent W2). teams.manage. Audited as helpdesk.skills.language_added.

import { NextResponse } from "next/server";
import { readJson } from "@/lib/helpdesk/access";
import { hdCapGate } from "@/lib/helpdesk/roles";
import { auditSkills, badRequest, skillsErrorResponse } from "@/lib/helpdesk/skills/routes";
import { addLanguage } from "@/lib/helpdesk/skills/store";
import { isLanguageCode, languageName } from "@/lib/helpdesk/skills/shared";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const gate = await hdCapGate("teams.manage");
  if (gate instanceof NextResponse) return gate;
  const body = await readJson(req, 4 * 1024);
  if (!body) return badRequest("Send the language as JSON.");
  if (!isLanguageCode(body.code)) return badRequest("Choose a language.");
  try {
    const added = await addLanguage(body.code, gate.id);
    if (added) {
      await auditSkills(req, gate, "helpdesk.skills.language_added", { type: "helpdesk_language", label: languageName(body.code) }, { code: body.code });
    }
    return NextResponse.json({ language: { code: body.code, name: languageName(body.code) }, added }, { status: added ? 201 : 200 });
  } catch (e) {
    const r = skillsErrorResponse(e);
    if (r) return r;
    throw e;
  }
}
