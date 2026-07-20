import { NextResponse } from "next/server";
import { getDocument } from "@/lib/db";
import { apiGuard } from "@/lib/api-auth";
import { canEditSpace } from "@/lib/access";
import {
  shareLinksEnabled,
  getActiveShare,
  createShare,
  revokeShare,
  SHARE_EXPIRY_DAYS,
} from "@/lib/shares";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import type { SessionUser } from "@/lib/types";

export const dynamic = "force-dynamic";

async function guard(id: string) {
  const gate = await apiGuard("editor");
  if (gate instanceof NextResponse) return { gate };
  const user = gate as SessionUser;
  if (!(await shareLinksEnabled())) {
    return { gate: NextResponse.json({ error: "Share links are disabled." }, { status: 400 }) };
  }
  const doc = await getDocument(Number(id));
  if (!doc || doc.branch_of !== null) {
    return { gate: NextResponse.json({ error: "Not found." }, { status: 404 }) };
  }
  if (!(await canEditSpace(user, doc.space_id))) {
    return {
      gate: NextResponse.json({ error: "You don't have edit access to this space." }, { status: 403 }),
    };
  }
  return { user, doc };
}

function shareInfo(s: { token: string; created_at: string; expires_at: string | null; view_count: number; last_viewed_at: string | null }) {
  return {
    token: s.token,
    url: `/share/${s.token}`,
    created_at: s.created_at,
    expires_at: s.expires_at,
    view_count: s.view_count,
    last_viewed_at: s.last_viewed_at,
  };
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await guard((await params).id);
  if ("gate" in g) return g.gate;
  const share = await getActiveShare(g.doc.id);
  return NextResponse.json({ share: share ? shareInfo(share) : null });
}

// Create (or regenerate — the previous link is revoked) a share link.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await guard((await params).id);
  if ("gate" in g) return g.gate;
  if (g.doc.status !== "published") {
    return NextResponse.json({ error: "Only published documents can be shared." }, { status: 400 });
  }

  let body: any = {};
  try {
    body = await req.json();
  } catch {
    /* empty body = never expires */
  }
  const expires = body?.expires_days === undefined || body.expires_days === null ? null : Number(body.expires_days);
  if (expires !== null && !SHARE_EXPIRY_DAYS.includes(expires as any)) {
    return NextResponse.json(
      { error: `expires_days must be null or one of: ${SHARE_EXPIRY_DAYS.join(", ")}.` },
      { status: 400 }
    );
  }

  const share = await createShare(g.doc.id, g.user.id, expires);
  await audit({
    actor: actorFrom(g.user),
    action: "document.share_created",
    targetType: "document",
    targetId: g.doc.id,
    targetLabel: g.doc.title,
    details: { expires_days: expires },
    ip: ipFrom(req),
  });
  return NextResponse.json({ ok: true, share: shareInfo(share) }, { status: 201 });
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await guard((await params).id);
  if ("gate" in g) return g.gate;
  const had = await revokeShare(g.doc.id);
  if (had) {
    await audit({
      actor: actorFrom(g.user),
      action: "document.share_revoked",
      targetType: "document",
      targetId: g.doc.id,
      targetLabel: g.doc.title,
      ip: ipFrom(req),
    });
  }
  return NextResponse.json({ ok: true });
}
