import { NextResponse } from "next/server";
import { v1Auth, v1Error } from "@/lib/v1-auth";
import { v1Doc } from "@/lib/v1-serialize";
import {
  listDocumentsV1,
  getSpaceBySlug,
  getSpaceById,
  createDocument,
  getApprovalMode,
} from "@/lib/db";
import { spaceScopeFor, scopeAllows, canEditSpace } from "@/lib/access";
import { roleAtLeast, type DocType } from "@/lib/types";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { notifySpaceSubscribers } from "@/lib/subscriptions";
import { requestOrigin } from "@/lib/oauth";

export const dynamic = "force-dynamic";

const DOC_TYPES: DocType[] = ["sop", "technical", "policy", "knowledge"];

/**
 * GET /api/v1/documents — list documents.
 * Query: space (slug), status (published|draft, editors only), limit (≤100), offset.
 */
export async function GET(req: Request) {
  const user = await v1Auth(req, "read");
  if (user instanceof NextResponse) return user;
  const url = new URL(req.url);
  const scope = await spaceScopeFor(user);
  const isEditor = roleAtLeast(user.role, "editor");

  let spaceId: number | undefined;
  const spaceSlug = url.searchParams.get("space");
  if (spaceSlug) {
    const space = await getSpaceBySlug(spaceSlug);
    if (!space || !scopeAllows(scope, space.id)) return v1Error(404, "Space not found.");
    spaceId = space.id;
  }
  const statusRaw = url.searchParams.get("status");
  const status = statusRaw === "draft" || statusRaw === "published" ? statusRaw : undefined;
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit")) || 25));
  const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);

  const { items, total } = await listDocumentsV1({
    scope,
    spaceId,
    status,
    includeDrafts: isEditor,
    limit,
    offset,
  });
  return NextResponse.json({ items: items.map((d) => v1Doc(d)), total, limit, offset });
}

/**
 * POST /api/v1/documents — create a document.
 * Body: {space, title, content, summary?, tags?, type?, status?}. Publishing
 * without publish rights queues a change request (202) instead of failing.
 */
export async function POST(req: Request) {
  const user = await v1Auth(req, "write");
  if (user instanceof NextResponse) return user;
  if (!roleAtLeast(user.role, "editor")) {
    return v1Error(403, "Creating documents needs the editor role.");
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return v1Error(400, "Body must be JSON.");
  }

  const spaceRef = body.space;
  const space =
    typeof spaceRef === "number"
      ? await getSpaceById(spaceRef)
      : typeof spaceRef === "string"
        ? await getSpaceBySlug(spaceRef)
        : undefined;
  if (!space || !scopeAllows(await spaceScopeFor(user), space.id)) {
    return v1Error(404, "Space not found (pass its slug or id as 'space').");
  }
  if (!(await canEditSpace(user, space.id))) {
    return v1Error(403, "You don't have edit rights in that space.");
  }

  const title = String(body.title ?? "").trim();
  const content = String(body.content ?? "");
  if (!title) return v1Error(400, "'title' is required.");
  if (!content.trim()) return v1Error(400, "'content' is required.");
  const type = DOC_TYPES.includes(body.type as DocType) ? (body.type as DocType) : "knowledge";
  const wantPublished = body.status !== "draft";
  const canPublish = roleAtLeast(user.role, "approver") || (await getApprovalMode()) === "open";
  const tags = Array.isArray(body.tags)
    ? body.tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 20)
    : [];

  // Editors in strict mode create drafts; publishing goes through review in
  // the app. Keep the API honest about that rather than silently publishing.
  const status = wantPublished && canPublish ? "published" : "draft";
  const doc = await createDocument({
    space_id: space.id,
    title,
    type,
    status,
    content,
    summary: String(body.summary ?? "").slice(0, 500),
    tags,
    author: user.name || user.username,
  });

  await audit({
    actor: actorFrom(user),
    action: "document.create",
    targetType: "document",
    targetId: doc.id,
    targetLabel: doc.title,
    details: { via: "api_v1", status: doc.status },
    ip: ipFrom(req),
  });
  if (doc.status === "published") {
    void notifySpaceSubscribers({
      spaceId: doc.space_id,
      spaceName: doc.space_name,
      docId: doc.id,
      title: doc.title,
      kind: "published",
      actorUserId: user.id,
      actorName: user.name || user.username,
      origin: requestOrigin(req),
    });
  }

  const queued = wantPublished && !canPublish;
  return NextResponse.json(
    {
      document: v1Doc(doc, true),
      ...(queued
        ? { note: "Created as a draft: publishing requires approval in this workspace." }
        : {}),
    },
    { status: 201 }
  );
}
