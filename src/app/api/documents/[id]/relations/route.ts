import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/api-auth";
import { getDocument } from "@/lib/db";
import { spaceScopeFor, scopeAllows, canEditSpace } from "@/lib/access";
import { relationsFor, addRelation, removeRelation, RELATION_KINDS } from "@/lib/relations";
import type { RelationKind } from "@/lib/relations";
import { roleAtLeast } from "@/lib/types";
import type { NextRequest } from "next/server";
import type { SessionUser } from "@/lib/types";

export const dynamic = "force-dynamic";

// Typed document relationships. Viewing follows document visibility; managing
// requires the editor role plus edit rights on the document's space. The
// "direction" field controls which side of a directional kind this doc is on:
// "out" = this doc → target (this doc is a procedure for the target),
// "in"  = target → this doc (the target is a procedure for this doc).

async function visibleDoc(user: SessionUser, id: number) {
  const doc = await getDocument(id);
  if (!doc || doc.branch_of !== null) return null;
  if (!scopeAllows(await spaceScopeFor(user), doc.space_id)) return null;
  if (doc.status === "draft" && !roleAtLeast(user.role, "editor")) return null;
  return doc;
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await apiGuard("viewer");
  if (gate instanceof NextResponse) return gate;
  const user = gate as SessionUser;
  const { id } = await params;
  const doc = await visibleDoc(user, Number(id));
  if (!doc) return NextResponse.json({ error: "Not found." }, { status: 404 });

  const relations = await relationsFor(
    doc.id,
    await spaceScopeFor(user),
    roleAtLeast(user.role, "editor")
  );
  return NextResponse.json({ relations });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await apiGuard("editor");
  if (gate instanceof NextResponse) return gate;
  const user = gate as SessionUser;
  const { id } = await params;
  const doc = await visibleDoc(user, Number(id));
  if (!doc) return NextResponse.json({ error: "Not found." }, { status: 404 });
  if (!(await canEditSpace(user, doc.space_id))) {
    return NextResponse.json({ error: "You don't have edit access to this space." }, { status: 403 });
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }
  const kind = RELATION_KINDS.find((k) => k.kind === body?.kind)?.kind as RelationKind | undefined;
  if (!kind) return NextResponse.json({ error: "Unknown relation kind." }, { status: 400 });

  const target = await visibleDoc(user, Number(body?.target_id));
  if (!target) return NextResponse.json({ error: "Target document not found." }, { status: 404 });
  if (target.id === doc.id) {
    return NextResponse.json({ error: "A document can't relate to itself." }, { status: 400 });
  }

  // Directional kinds can be authored from either side.
  const [from, to] = body?.direction === "in" ? [target.id, doc.id] : [doc.id, target.id];
  const created = await addRelation(from, to, kind, user.id);
  if (!created) {
    return NextResponse.json({ error: "These documents are already linked this way." }, { status: 409 });
  }
  const relations = await relationsFor(
    doc.id,
    await spaceScopeFor(user),
    roleAtLeast(user.role, "editor")
  );
  return NextResponse.json({ ok: true, relations }, { status: 201 });
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await apiGuard("editor");
  if (gate instanceof NextResponse) return gate;
  const user = gate as SessionUser;
  const { id } = await params;
  const doc = await visibleDoc(user, Number(id));
  if (!doc) return NextResponse.json({ error: "Not found." }, { status: 404 });
  if (!(await canEditSpace(user, doc.space_id))) {
    return NextResponse.json({ error: "You don't have edit access to this space." }, { status: 403 });
  }

  const rid = Number(req.nextUrl.searchParams.get("rid"));
  if (!rid || !(await removeRelation(rid, doc.id))) {
    return NextResponse.json({ error: "Link not found." }, { status: 404 });
  }
  const relations = await relationsFor(
    doc.id,
    await spaceScopeFor(user),
    roleAtLeast(user.role, "editor")
  );
  return NextResponse.json({ ok: true, relations });
}
