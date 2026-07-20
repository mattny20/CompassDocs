import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/api-auth";
import { listTemplates, createTemplate } from "@/lib/doc-templates";
import { getDocument } from "@/lib/db";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import type { SessionUser, DocType } from "@/lib/types";

export const dynamic = "force-dynamic";

const TYPES: DocType[] = ["sop", "technical", "policy", "knowledge"];
const MAX_BODY = 100_000;

export async function GET() {
  const gate = await apiGuard("admin");
  if (gate instanceof NextResponse) return gate;
  return NextResponse.json({ templates: await listTemplates(true) });
}

// Create a template — from fields, or from an existing document (from_doc_id).
export async function POST(req: Request) {
  const gate = await apiGuard("admin");
  if (gate instanceof NextResponse) return gate;
  const user = gate as SessionUser;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }

  let input = {
    name: String(body?.name ?? "").trim(),
    description: String(body?.description ?? "").trim(),
    doc_type: (TYPES.includes(body?.doc_type) ? body.doc_type : "knowledge") as DocType,
    title_pattern: String(body?.title_pattern ?? "").trim(),
    summary: String(body?.summary ?? "").trim(),
    tags: String(body?.tags ?? "").trim(),
    body: String(body?.body ?? ""),
  };

  if (body?.from_doc_id) {
    const doc = await getDocument(Number(body.from_doc_id));
    if (!doc) return NextResponse.json({ error: "Source document not found." }, { status: 404 });
    input = {
      name: input.name || doc.title,
      description: input.description || `Based on "${doc.title}".`,
      doc_type: doc.type,
      title_pattern: "{{title}}",
      summary: doc.summary,
      tags: doc.tags.join(", "),
      body: doc.content,
    };
  }

  if (!input.name) return NextResponse.json({ error: "A name is required." }, { status: 400 });
  if (input.body.length > MAX_BODY) {
    return NextResponse.json({ error: "Template body is too long." }, { status: 400 });
  }

  const tpl = await createTemplate({ ...input, created_by: user.id });
  await audit({
    actor: actorFrom(user),
    action: "settings.template_created",
    targetType: "template",
    targetId: tpl.id,
    targetLabel: tpl.name,
    ip: ipFrom(req),
  });
  return NextResponse.json({ ok: true, template: tpl }, { status: 201 });
}
