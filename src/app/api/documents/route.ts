import { NextResponse } from "next/server";
import { createDocument, getSpaceBySlug, listSpaces, getApprovalMode } from "@/lib/db";
import { apiGuard } from "@/lib/api-auth";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { notifyWebhooks } from "@/lib/webhooks";
import { notifySpaceSubscribers } from "@/lib/subscriptions";
import { requestOrigin } from "@/lib/oauth";
import { roleAtLeast } from "@/lib/types";
import { spaceScopeFor, scopeAllows, canEditSpace } from "@/lib/access";
import type { DocType, DocStatus, SessionUser } from "@/lib/types";

export const dynamic = "force-dynamic";

const TYPES: DocType[] = ["sop", "technical", "policy", "knowledge"];
const STATUSES: DocStatus[] = ["draft", "published"];

function normalizeTags(input: unknown): string[] {
  if (Array.isArray(input)) return input.map((t) => String(t).trim()).filter(Boolean);
  if (typeof input === "string")
    return input
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
  return [];
}

export async function POST(req: Request) {
  const gate = await apiGuard("editor");
  if (gate instanceof NextResponse) return gate;
  const user = gate as SessionUser;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }

  const title = String(body?.title ?? "").trim();
  if (!title) return NextResponse.json({ error: "Title is required." }, { status: 400 });

  const scope = await spaceScopeFor(user);
  let spaceId: number | undefined;
  if (body?.space_id) spaceId = Number(body.space_id);
  else if (body?.space_slug) spaceId = (await getSpaceBySlug(String(body.space_slug)))?.id;
  if (!spaceId) spaceId = (await listSpaces(scope))[0]?.id;
  if (!spaceId || !scopeAllows(scope, spaceId)) {
    return NextResponse.json({ error: "No space available." }, { status: 400 });
  }
  if (!(await canEditSpace(user, spaceId))) {
    return NextResponse.json(
      { error: "You don't have edit access to this space." },
      { status: 403 }
    );
  }

  const type: DocType = TYPES.includes(body?.type) ? body.type : "knowledge";
  const requested: DocStatus = STATUSES.includes(body?.status) ? body.status : "draft";

  // Editors in strict mode can't publish directly — new docs start as drafts.
  const canPublish = roleAtLeast(user.role, "approver") || (await getApprovalMode()) === "open";
  const status: DocStatus = requested === "published" && !canPublish ? "draft" : requested;

  const doc = await createDocument({
    space_id: spaceId,
    title,
    type,
    status,
    content: String(body?.content ?? ""),
    summary: String(body?.summary ?? "").trim(),
    tags: normalizeTags(body?.tags),
    author: user.name || user.username,
  });

  if (status === "published") {
    void notifyWebhooks("document.published", {
      title: doc.title,
      actor: user.name || user.username,
      url: `${requestOrigin(req)}/doc/${doc.id}`,
      spaceId: doc.space_id,
      spaceName: doc.space_name,
    });
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
  await audit({
    actor: actorFrom(user),
    action: status === "published" ? "document.publish" : "document.create",
    targetType: "document",
    targetId: doc.id,
    targetLabel: doc.title,
    ip: ipFrom(req),
  });

  return NextResponse.json({ doc, downgraded: status !== requested }, { status: 201 });
}
