import { NextResponse } from "next/server";
import { emailTemplatesGate, canSeeEvent, readJsonBody, BAD_JSON, FORBIDDEN } from "@/lib/email-parts-access";
import { previewComposition } from "@/lib/email-parts";
import type { PreviewInput } from "@/lib/email-parts";
import { requestOrigin } from "@/lib/oauth";

export const dynamic = "force-dynamic";

// POST {event (or event_key), scope?, header_id?, body_id?, signature_id?,
// footer_id?, draft?: {kind, subject?, content?}, drafts?: {header?: {content},
// body?: {subject, content}, …}, vars?: {tag: value}}: render any
// combination with the event's sample values. Slots left out are the
// (event, scope) composition as saved; null inherits; a draft replaces its
// slot's text. Answers {subject, html, text, parts}. Nothing is saved.

export async function POST(req: Request) {
  const gate = await emailTemplatesGate();
  if (gate instanceof NextResponse) return gate;
  const body = await readJsonBody(req);
  if (!body) return BAD_JSON();
  const event = String(body.event_key ?? body.event ?? "");
  if (event && !canSeeEvent(gate, event)) return FORBIDDEN();
  const out = await previewComposition(body as PreviewInput, requestOrigin(req));
  if ("error" in out) return NextResponse.json({ error: out.error }, { status: out.status });
  return NextResponse.json(out);
}
