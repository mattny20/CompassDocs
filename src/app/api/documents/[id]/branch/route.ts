import { NextResponse } from "next/server";
import { getDocument, createDocument, listBranches } from "@/lib/db";
import { apiGuard } from "@/lib/api-auth";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { spaceScopeFor, scopeAllows, canEditSpace } from "@/lib/access";
import type { SessionUser } from "@/lib/types";

export const dynamic = "force-dynamic";

// Create a draft branch: a private working copy of the document that can be
// edited freely (it's hidden from listings and search) and later merged back.

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await apiGuard("editor");
  if (gate instanceof NextResponse) return gate;
  const user = gate as SessionUser;

  const { id } = await params;
  const source = await getDocument(Number(id));
  if (!source) return NextResponse.json({ error: "Not found." }, { status: 404 });
  if (!scopeAllows(await spaceScopeFor(user), source.space_id)) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  if (!(await canEditSpace(user, source.space_id))) {
    return NextResponse.json(
      { error: "You don't have edit access to this space." },
      { status: 403 }
    );
  }
  if (source.branch_of) {
    return NextResponse.json(
      { error: "This document is already a draft branch — branch the original instead." },
      { status: 400 }
    );
  }

  const branch = await createDocument({
    space_id: source.space_id,
    title: source.title,
    type: source.type,
    status: "draft",
    content: source.content,
    summary: source.summary,
    tags: source.tags,
    author: user.name || user.username,
    category_id: source.category_id,
    branch_of: source.id,
  });
  await audit({
    actor: actorFrom(user),
    action: "document.branch_create",
    targetType: "document",
    targetId: source.id,
    targetLabel: source.title,
    details: { branchId: branch.id },
    ip: ipFrom(req),
  });
  const branches = await listBranches(source.id);
  return NextResponse.json({ branch, branchCount: branches.length });
}
