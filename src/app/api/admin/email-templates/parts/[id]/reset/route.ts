import { NextResponse } from "next/server";
import { emailTemplatesGate } from "@/lib/email-parts-access";
import { getPart, resetPart } from "@/lib/email-parts";
import { audit, actorFrom, ipFrom } from "@/lib/audit";

export const dynamic = "force-dynamic";

// POST: put a built-in part back to what CompassDocs shipped (name, subject
// and content). 400 for a custom part.

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await emailTemplatesGate("manage");
  if (gate instanceof NextResponse) return gate;
  const out = await resetPart(Number((await params).id));
  if ("error" in out) return NextResponse.json({ error: out.error }, { status: out.status });
  await audit({
    actor: actorFrom(gate.user),
    action: "email_template.part_reset",
    targetType: "email_template_part",
    targetId: out.id,
    targetLabel: out.name,
    details: { kind: out.kind, event_key: out.event_key, builtin_key: out.builtin_key },
    ip: ipFrom(req),
  });
  return NextResponse.json({ part: await getPart(out.id) });
}
