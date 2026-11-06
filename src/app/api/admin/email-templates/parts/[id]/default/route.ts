import { NextResponse } from "next/server";
import { emailTemplatesGate } from "@/lib/email-parts-access";
import { getPart, setDefaultPart } from "@/lib/email-parts";
import { audit, actorFrom, ipFrom } from "@/lib/audit";

export const dynamic = "force-dynamic";

// POST: make this header, signature or footer the default of its kind:
// every email whose composition names none of that kind uses it from now
// on. 400 for a body (a body belongs to its event).

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await emailTemplatesGate("manage");
  if (gate instanceof NextResponse) return gate;
  const out = await setDefaultPart(Number((await params).id));
  if ("error" in out) return NextResponse.json({ error: out.error }, { status: out.status });
  if (out.changed) {
    await audit({
      actor: actorFrom(gate.user),
      action: "email_template.default_changed",
      targetType: "email_template_part",
      targetId: out.part.id,
      targetLabel: out.part.name,
      details: { kind: out.part.kind, previous_id: out.previous?.id ?? null, previous_name: out.previous?.name ?? null },
      ip: ipFrom(req),
    });
  }
  return NextResponse.json({ part: await getPart(out.part.id) });
}
