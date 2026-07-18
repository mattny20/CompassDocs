import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/api-auth";
import {
  getDocument,
  listDocComments,
  createDocComment,
  getMentionTargets,
} from "@/lib/db";
import { spaceScopeFor, scopeAllows } from "@/lib/access";
import { getAppSettings } from "@/lib/settings-store";
import { findBlockedWord, notifyMentions, COMMENT_MAX_LEN } from "@/lib/comments";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { requestOrigin } from "@/lib/oauth";
import { roleAtLeast } from "@/lib/types";

export const dynamic = "force-dynamic";

// Comments live under the same access rules as the document: you must be able
// to see the doc to read or write its comments. The workspace-wide enable
// switch and the restricted-word list are enforced server-side here — the UI
// checks are cosmetic.

async function loadDocFor(userGate: Awaited<ReturnType<typeof apiGuard>>, idRaw: string) {
  if (userGate instanceof NextResponse) return userGate;
  const doc = await getDocument(Number(idRaw));
  if (!doc) return NextResponse.json({ error: "Document not found." }, { status: 404 });
  if (!scopeAllows(await spaceScopeFor(userGate), doc.space_id)) {
    return NextResponse.json({ error: "Document not found." }, { status: 404 });
  }
  if (doc.status === "draft" && !roleAtLeast(userGate.role, "editor")) {
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

  const settings = await getAppSettings();
  if (!settings.comments_enabled) {
    return NextResponse.json({ enabled: false, comments: [] });
  }
  return NextResponse.json({ enabled: true, comments: await listDocComments(doc.id) });
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = await apiGuard();
  if (gate instanceof NextResponse) return gate;
  const { id } = await ctx.params;
  const doc = await loadDocFor(gate, id);
  if (doc instanceof NextResponse) return doc;

  const settings = await getAppSettings();
  if (!settings.comments_enabled) {
    return NextResponse.json({ error: "Comments are turned off." }, { status: 403 });
  }

  let payload: { body?: unknown; mention_ids?: unknown };
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const body = String(payload.body ?? "").trim();
  if (!body) return NextResponse.json({ error: "Comment is empty." }, { status: 400 });
  if (body.length > COMMENT_MAX_LEN) {
    return NextResponse.json(
      { error: `Comments are limited to ${COMMENT_MAX_LEN} characters.` },
      { status: 400 }
    );
  }

  // Workplace-safety: restricted words block the whole comment, with a clear
  // reason so the author can fix it.
  const blocked = findBlockedWord(body, settings.comments_blocked_words);
  if (blocked) {
    return NextResponse.json(
      { error: `Comment contains a restricted word ("${blocked}"). Please rephrase.` },
      { status: 400 }
    );
  }

  // Mentions: ids come from the composer's picker, but we only honor ones
  // whose user is active — and notifications only go to users actually
  // resolvable at save time.
  const rawIds = Array.isArray(payload.mention_ids) ? payload.mention_ids : [];
  const mentionIds = [...new Set(rawIds.map(Number).filter((n) => Number.isInteger(n) && n > 0))].slice(0, 20);

  const comment = await createDocComment({
    document_id: doc.id,
    user_id: gate.id,
    author_name: gate.name || gate.username,
    body,
    mention_user_ids: mentionIds,
  });

  await audit({
    actor: actorFrom(gate),
    action: "comment.create",
    targetType: "document",
    targetId: doc.id,
    targetLabel: doc.title,
    details: comment.mentions.length ? { mentions: comment.mentions.map((m) => m.name) } : undefined,
    ip: ipFrom(req),
  });

  if (comment.mentions.length > 0) {
    const targets = await getMentionTargets(comment.mentions.map((m) => m.id));
    void notifyMentions({
      targets,
      comment,
      authorId: gate.id,
      authorName: gate.name || gate.username,
      docId: doc.id,
      docTitle: doc.title,
      orgName: settings.company_name,
      origin: requestOrigin(req),
    });
  }

  return NextResponse.json({ comment }, { status: 201 });
}
