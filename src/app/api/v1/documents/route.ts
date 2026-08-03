import { NextResponse } from "next/server";
import { v1Auth, v1Error, v1Requires, v1Holds } from "@/lib/v1-auth";
import { v1Doc } from "@/lib/v1-serialize";
import {
  listDocumentsV1,
  getSpaceBySlug,
  getSpaceById,
  createDocument,
  getApprovalMode,
} from "@/lib/db";
import { spaceScopeFor, scopeAllows, canEditSpace } from "@/lib/access";
import { type DocType } from "@/lib/types";
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
  // Drafts are their own permission. Space-scoped, but this listing can span
  // spaces, so it asks the unscoped question: "may they see drafts anywhere?"
  // — and the scope filter below still bounds which spaces' drafts appear.
  const canSeeDrafts = await v1Holds(user, "document.read_draft");

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
    includeDrafts: canSeeDrafts,
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
  // Same pair the app's own create route uses: the permission, then the
  // space's edit rights. Scoped to the space, so a role granted on one space
  // authorises creating there and nowhere else.
  const mayCreate = await v1Requires(user, "document.create", {
    spaceId: space.id,
    message: "You don't have permission to create documents.",
  });
  if (mayCreate) return mayCreate;
  if (!(await canEditSpace(user, space.id))) {
    return v1Error(403, "You don't have edit rights in that space.");
  }

  const title = String(body.title ?? "").trim();
  const content = String(body.content ?? "");
  if (!title) return v1Error(400, "'title' is required.");
  if (!content.trim()) return v1Error(400, "'content' is required.");
  const type = DOC_TYPES.includes(body.type as DocType) ? (body.type as DocType) : "knowledge";
  const wantPublished = body.status !== "draft";
  const canPublish =
    (await v1Holds(user, "document.publish", space.id)) || (await getApprovalMode()) === "open";
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
