import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/api-auth";
import { getDocument } from "@/lib/db";
import { spaceScopeFor, scopeAllows } from "@/lib/access";
import { documentDetail } from "@/lib/analytics";
import type { SessionUser } from "@/lib/types";

export const dynamic = "force-dynamic";

// Per-document drill-down for the analytics dashboard.

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await apiGuard("approver");
  if (gate instanceof NextResponse) return gate;
  const user = gate as SessionUser;

  const { id } = await params;
  const doc = await getDocument(Number(id));
  if (!doc) return NextResponse.json({ error: "Not found." }, { status: 404 });
  if (!scopeAllows(await spaceScopeFor(user), doc.space_id)) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  const url = new URL(req.url);
  const days = [7, 30, 90, 365].includes(Number(url.searchParams.get("days")))
    ? Number(url.searchParams.get("days"))
    : 30;
  const detail = await documentDetail(doc.id, days);
  return NextResponse.json({
    doc: {
      id: doc.id,
      title: doc.title,
      author: doc.author,
      space_name: doc.space_name,
      space_icon: doc.space_icon,
      status: doc.status,
    },
    ...detail,
  });
}
