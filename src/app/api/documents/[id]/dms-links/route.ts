import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/api-auth";
import { getDocument, listDmsLinks, addDmsLink } from "@/lib/db";
import { canSeeDrafts, spaceScopeFor, scopeAllows, canEditSpace } from "@/lib/access";
import { detectDmsSystem, validateDmsUrl, defaultDmsTitle } from "@/lib/dms";
import { audit, actorFrom, ipFrom } from "@/lib/audit";

export const dynamic = "force-dynamic";

// DMS links follow the attachment rules: seeing the doc lets you see its
// links; adding/removing needs editor rights in the doc's space.

async function loadDocFor(gate: Awaited<ReturnType<typeof apiGuard>>, idRaw: string) {
  if (gate instanceof NextResponse) return gate;
  const doc = await getDocument(Number(idRaw));
  if (!doc) return NextResponse.json({ error: "Document not found." }, { status: 404 });
  if (!scopeAllows(await spaceScopeFor(gate), doc.space_id)) {
    return NextResponse.json({ error: "Document not found." }, { status: 404 });
  }
  if (doc.status === "draft" && !(await canSeeDrafts(gate, doc.space_id))) {
    return NextResponse.json({ error: "Document not found." }, { status: 404 });
  }
  return doc;
}

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = await apiGuard();
  if (gate instanceof NextResponse) return gate;
  const { id } = await ctx.params;
  const doc = await loadDocFor(gate, id);
  if (doc instanceof NextResponse) return doc;
  return NextResponse.json({ links: await listDmsLinks(doc.id) });
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = await apiGuard("editor", "document.dms_link_manage");
  if (gate instanceof NextResponse) return gate;
  const { id } = await ctx.params;
  const doc = await loadDocFor(gate, id);
  if (doc instanceof NextResponse) return doc;
  if (!(await canEditSpace(gate, doc.space_id))) {
    return NextResponse.json({ error: "You can't edit this space." }, { status: 403 });
  }

  let body: { url?: unknown; title?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  const url = String(body.url ?? "").trim();
  const invalid = validateDmsUrl(url);
  if (invalid) return NextResponse.json({ error: invalid }, { status: 400 });

  if ((await listDmsLinks(doc.id)).length >= 50) {
    return NextResponse.json({ error: "A document can have at most 50 links." }, { status: 400 });
  }

  const system = detectDmsSystem(url);
  const title = String(body.title ?? "").trim() || defaultDmsTitle(url, system);
  const link = await addDmsLink({
    document_id: doc.id,
    system,
    title,
    url,
    added_by: gate.name || gate.username,
  });

  await audit({
    actor: actorFrom(gate),
    action: "document.dms_link_add",
    targetType: "document",
    targetId: doc.id,
    targetLabel: doc.title,
    details: { system, title },
    ip: ipFrom(req),
  });
  return NextResponse.json({ link }, { status: 201 });
}
