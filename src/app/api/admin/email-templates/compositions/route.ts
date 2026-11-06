import { NextResponse } from "next/server";
import { emailTemplatesGate, canSeeEvent } from "@/lib/email-parts-access";
import { isHelpdeskEvent, isScope, listCompositions, listTeamVariants, SCOPE_ALL } from "@/lib/email-parts";
import { EMAIL_TEMPLATES } from "@/lib/email-templates";

export const dynamic = "force-dynamic";

// GET ?scope=all|hd_team:<id>: every email event with the four parts its
// mail is built from for that scope (and where each comes from), the email
// events themselves (label, description, tags), and which team variants
// exist. A helpdesk admin who is not a template reader sees the hd_*
// events only.

export async function GET(req: Request) {
  const gate = await emailTemplatesGate();
  if (gate instanceof NextResponse) return gate;
  const scope = new URL(req.url).searchParams.get("scope") || SCOPE_ALL;
  if (!isScope(scope)) return NextResponse.json({ error: "Unknown scope: use 'all' or 'hd_team:<id>'." }, { status: 400 });
  const events = EMAIL_TEMPLATES.filter(
    (t) => canSeeEvent(gate, t.key) && (scope === SCOPE_ALL || isHelpdeskEvent(t.key))
  );
  const compositions = await listCompositions(scope, events.map((t) => t.key));
  const variants = (await listTeamVariants()).filter((v) => canSeeEvent(gate, v.event_key));
  return NextResponse.json({
    scope,
    events: events.map((t) => ({
      key: t.key,
      label: t.label,
      description: t.description,
      tags: t.tags,
      helpdesk: isHelpdeskEvent(t.key),
    })),
    compositions,
    variants,
    can_manage: gate.manage,
  });
}
