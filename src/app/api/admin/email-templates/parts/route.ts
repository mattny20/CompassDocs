import { NextResponse } from "next/server";
import { emailTemplatesGate, readJsonBody, BAD_JSON } from "@/lib/email-parts-access";
import { createPart, isPartKind, listParts, partTags, PART_KINDS } from "@/lib/email-parts";
import { audit, actorFrom, ipFrom } from "@/lib/audit";

export const dynamic = "force-dynamic";

// The part libraries (1.19.0): headers, bodies, signatures and footers.
// GET ?kind=header|body|signature|footer&event=<key> lists them, each with
// the compositions that name it; POST creates one (template managers).

export async function GET(req: Request) {
  const gate = await emailTemplatesGate();
  if (gate instanceof NextResponse) return gate;
  const url = new URL(req.url);
  const kind = url.searchParams.get("kind") ?? "";
  const event = url.searchParams.get("event") ?? "";
  if (kind && !isPartKind(kind)) return NextResponse.json({ error: "Unknown part kind." }, { status: 400 });
  const parts = await listParts({ kind: isPartKind(kind) ? kind : undefined, event_key: event || undefined });
  const tags = Object.fromEntries(PART_KINDS.filter((k) => k !== "body").map((k) => [k, partTags(k)]));
  return NextResponse.json({ parts, tags });
}

export async function POST(req: Request) {
  const gate = await emailTemplatesGate("manage");
  if (gate instanceof NextResponse) return gate;
  const body = await readJsonBody(req);
  if (!body) return BAD_JSON();
  const out = await createPart(
    { kind: body.kind, name: body.name, event_key: body.event_key, subject: body.subject, content: body.content },
    gate.user.id
  );
  if ("error" in out) return NextResponse.json({ error: out.error }, { status: out.status });
  await audit({
    actor: actorFrom(gate.user),
    action: "email_template.part_created",
    targetType: "email_template_part",
    targetId: out.id,
    targetLabel: out.name,
    details: { kind: out.kind, event_key: out.event_key },
    ip: ipFrom(req),
  });
  return NextResponse.json({ part: { ...out, used_by: [] } }, { status: 201 });
}
