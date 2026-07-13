import { NextResponse } from "next/server";
import {
  getDocument,
  updateDocument,
  deleteDocument,
  createChangeRequest,
  getApprovalMode,
} from "@/lib/db";
import { apiGuard } from "@/lib/api-auth";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { roleAtLeast } from "@/lib/types";
import type { DocType, DocStatus, SessionUser } from "@/lib/types";

export const dynamic = "force-dynamic";

const TYPES: DocType[] = ["sop", "technical", "policy", "knowledge"];
const STATUSES: DocStatus[] = ["draft", "published"];

function normalizeTags(input: unknown): string[] | undefined {
  if (input === undefined) return undefined;
  if (Array.isArray(input)) return input.map((t) => String(t).trim()).filter(Boolean);
  if (typeof input === "string")
    return input
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
  return [];
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await apiGuard("viewer");
  if (gate instanceof NextResponse) return gate;
  const user = gate as SessionUser;

  const { id } = await params;
  const doc = await getDocument(Number(id));
  if (!doc) return NextResponse.json({ error: "Not found." }, { status: 404 });
  if (doc.status === "draft" && !roleAtLeast(user.role, "editor")) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  return NextResponse.json({ doc });
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await apiGuard("editor");
  if (gate instanceof NextResponse) return gate;
  const user = gate as SessionUser;

  const { id } = await params;
  const existing = await getDocument(Number(id));
  if (!existing) return NextResponse.json({ error: "Not found." }, { status: 404 });

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }

  // Resolve the proposed next state, falling back to the current values.
  const proposed = {
    title: typeof body?.title === "string" && body.title.trim() ? body.title.trim() : existing.title,
    content: typeof body?.content === "string" ? body.content : existing.content,
    summary: typeof body?.summary === "string" ? body.summary.trim() : existing.summary,
    type: (TYPES.includes(body?.type) ? body.type : existing.type) as DocType,
    status: (STATUSES.includes(body?.status) ? body.status : existing.status) as DocStatus,
    tags: normalizeTags(body?.tags) ?? existing.tags,
  };

  // A change "affects live content" if the doc is already published, or if this
  // edit would publish it. Those are the changes that require approval.
  const affectsLive = existing.status === "published" || proposed.status === "published";
  const canPublish = roleAtLeast(user.role, "approver") || (await getApprovalMode()) === "open";

  if (affectsLive && !canPublish) {
    // Editor in strict mode: queue a change request; leave the live doc untouched.
    const kind = existing.status === "draft" ? "publish" : "edit";
    const crId = await createChangeRequest({
      document_id: existing.id,
      kind,
      title: proposed.title,
      content: proposed.content,
      summary: proposed.summary,
      tags: proposed.tags,
      type: proposed.type,
      target_status: "published",
      note: String(body?.versionNote ?? "").trim(),
      created_by: user.id,
    });
    await audit({
      actor: actorFrom(user),
      action: "change_request.submit",
      targetType: "document",
      targetId: existing.id,
      targetLabel: proposed.title,
      details: { kind },
      ip: ipFrom(req),
    });
    return NextResponse.json({ pending: true, changeRequestId: crId, docId: existing.id });
  }

  // Otherwise apply directly (draft edit, or a privileged/open-mode change).
  const doc = await updateDocument(existing.id, {
    ...proposed,
    author: user.name || user.username,
    versionNote: String(body?.versionNote ?? "").trim() || "Edited",
  });
  const published = existing.status !== "published" && proposed.status === "published";
  await audit({
    actor: actorFrom(user),
    action: published ? "document.publish" : "document.update",
    targetType: "document",
    targetId: existing.id,
    targetLabel: proposed.title,
    ip: ipFrom(req),
  });
  return NextResponse.json({ doc });
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await apiGuard("editor");
  if (gate instanceof NextResponse) return gate;
  const user = gate as SessionUser;

  const { id } = await params;
  const doc = await getDocument(Number(id));
  if (!doc) return NextResponse.json({ error: "Not found." }, { status: 404 });

  // Editors may only delete drafts; deleting a published doc needs approver+.
  if (doc.status === "published" && !roleAtLeast(user.role, "approver")) {
    return NextResponse.json(
      { error: "Only approvers or admins can delete a published document." },
      { status: 403 }
    );
  }

  await deleteDocument(doc.id);
  await audit({
    actor: actorFrom(user),
    action: "document.delete",
    targetType: "document",
    targetId: doc.id,
    targetLabel: doc.title,
    ip: ipFrom(req),
  });
  return NextResponse.json({ ok: true });
}
