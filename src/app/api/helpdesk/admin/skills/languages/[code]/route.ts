// DELETE /api/helpdesk/admin/skills/languages/[code]   remove a language from the workspace and every agent;
//        refused (409) while an assignment rule needs agents who speak it. Tickets keep their language.
// Helpdesk 1.19.2 (agent W2). teams.manage. Audited as helpdesk.skills.language_removed.

import { NextResponse } from "next/server";
import { hdCapGate } from "@/lib/helpdesk/roles";
import { auditSkills, notFound, skillsErrorResponse } from "@/lib/helpdesk/skills/routes";
import { removeLanguage } from "@/lib/helpdesk/skills/store";
import { isLanguageCode, languageName } from "@/lib/helpdesk/skills/shared";

export const dynamic = "force-dynamic";

export async function DELETE(req: Request, ctx: { params: Promise<{ code: string }> }) {
  const gate = await hdCapGate("teams.manage");
  if (gate instanceof NextResponse) return gate;
  const code = (await ctx.params).code;
  if (!isLanguageCode(code)) return notFound();
  try {
    const gone = await removeLanguage(code);
    if (!gone) return notFound();
    await auditSkills(req, gate, "helpdesk.skills.language_removed", { type: "helpdesk_language", label: languageName(code) }, { code, agents: gone.agents });
    return NextResponse.json({ ok: true });
  } catch (e) {
    const r = skillsErrorResponse(e);
    if (r) return r;
    throw e;
  }
}
