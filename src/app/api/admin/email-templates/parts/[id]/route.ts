import { NextResponse } from "next/server";
import { emailTemplatesGate, readJsonBody, BAD_JSON } from "@/lib/email-parts-access";
import { deletePart, getPart, partTags, updatePart } from "@/lib/email-parts";
import { audit, actorFrom, ipFrom } from "@/lib/audit";

export const dynamic = "force-dynamic";

// One part: GET (with its tags and where it is used), PATCH {name?,
// subject?, content?} (built-ins too), DELETE (custom parts that no
// composition names and that are not their kind's default; 409 lists the
// emails using it).

type Ctx = { params: Promise<{ id: string }> };

const NOT_FOUND = () => NextResponse.json({ error: "That part doesn't exist." }, { status: 404 });

export async function GET(_req: Request, { params }: Ctx) {
  const gate = await emailTemplatesGate();
  if (gate instanceof NextResponse) return gate;
  const part = await getPart(Number((await params).id));
  if (!part) return NOT_FOUND();
  return NextResponse.json({ part, tags: partTags(part.kind, part.event_key) });
}

export async function PATCH(req: Request, { params }: Ctx) {
  const gate = await emailTemplatesGate("manage");
  if (gate instanceof NextResponse) return gate;
  const id = Number((await params).id);
  const body = await readJsonBody(req);
  if (!body) return BAD_JSON();
  const before = await getPart(id);
  if (!before) return NOT_FOUND();
  const out = await updatePart(id, { name: body.name, subject: body.subject, content: body.content });
  if ("error" in out) return NextResponse.json({ error: out.error }, { status: out.status });
  const changed = (["name", "subject", "content"] as const).filter((k) => before[k] !== out[k]);
  if (changed.length > 0) {
    await audit({
      actor: actorFrom(gate.user),
      action: "email_template.part_updated",
      targetType: "email_template_part",
      targetId: out.id,
      targetLabel: out.name,
      details: { kind: out.kind, event_key: out.event_key, changed, ...(before.name !== out.name ? { previous_name: before.name } : {}) },
      ip: ipFrom(req),
    });
  }
  return NextResponse.json({ part: { ...out, used_by: before.used_by } });
}

export async function DELETE(req: Request, { params }: Ctx) {
  const gate = await emailTemplatesGate("manage");
  if (gate instanceof NextResponse) return gate;
  const out = await deletePart(Number((await params).id));
  if ("error" in out) {
    return NextResponse.json({ error: out.error, ...(out.used_by ? { used_by: out.used_by } : {}) }, { status: out.status });
  }
  await audit({
    actor: actorFrom(gate.user),
    action: "email_template.part_deleted",
    targetType: "email_template_part",
    targetId: out.part.id,
    targetLabel: out.part.name,
    details: { kind: out.part.kind, event_key: out.part.event_key },
    ip: ipFrom(req),
  });
  return NextResponse.json({ ok: true });
}
