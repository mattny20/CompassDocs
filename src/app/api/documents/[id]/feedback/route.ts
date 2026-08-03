import { NextResponse } from "next/server";
import { getDocument, pool } from "@/lib/db";
import { apiGuard } from "@/lib/api-auth";
import { canSeeDrafts, spaceScopeFor, scopeAllows } from "@/lib/access";
import type { SessionUser } from "@/lib/types";

export const dynamic = "force-dynamic";

async function q<T = any>(sql: string, params: any[] = []): Promise<T[]> {
  return (await pool().query(sql, params)).rows as T[];
}

async function visibleDoc(user: SessionUser, idRaw: string) {
  const id = Number(idRaw);
  if (!Number.isInteger(id)) return null;
  const doc = await getDocument(id);
  if (!doc || !scopeAllows(await spaceScopeFor(user), doc.space_id)) return null;
  // Same gate as every other reader path: drafts are invisible below editor,
  // and draft branches are working copies — not something readers rate.
  if (doc.status === "draft" && !(await canSeeDrafts(user, doc.space_id))) return null;
  if (doc.branch_of) return null;
  return doc;
}

async function summary(docId: number, userId: number) {
  const [agg] = await q<{ up: number; down: number }>(
    `SELECT count(*) FILTER (WHERE helpful = 1)::int AS up,
            count(*) FILTER (WHERE helpful = 0)::int AS down
     FROM doc_feedback WHERE document_id = $1`,
    [docId]
  );
  const mine = (
    await q<{ helpful: number }>(
      "SELECT helpful FROM doc_feedback WHERE document_id = $1 AND user_id = $2",
      [docId, userId]
    )
  )[0];
  return { up: agg.up, down: agg.down, mine: mine ? mine.helpful === 1 : null };
}

// "Was this helpful?" — one vote per user per document, revisable.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await apiGuard("viewer", "document.feedback_vote");
  if (gate instanceof NextResponse) return gate;
  const user = gate as SessionUser;
  const doc = await visibleDoc(user, (await params).id);
  if (!doc) return NextResponse.json({ error: "Not found." }, { status: 404 });
  return NextResponse.json(await summary(doc.id, user.id));
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await apiGuard("viewer", "document.feedback_vote");
  if (gate instanceof NextResponse) return gate;
  const user = gate as SessionUser;
  const doc = await visibleDoc(user, (await params).id);
  if (!doc) return NextResponse.json({ error: "Not found." }, { status: 404 });

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  if (typeof body?.helpful !== "boolean") {
    return NextResponse.json({ error: "helpful must be true or false." }, { status: 400 });
  }
  const note = String(body?.note ?? "").trim().slice(0, 500);

  await q(
    `INSERT INTO doc_feedback (document_id, user_id, helpful, note)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (document_id, user_id)
     DO UPDATE SET helpful = EXCLUDED.helpful,
       -- A revote without a note keeps the earlier note instead of erasing it
       -- (the No button votes immediately; the note form submits after).
       note = CASE WHEN EXCLUDED.note = '' THEN doc_feedback.note ELSE EXCLUDED.note END,
       created_at = now()`,
    [doc.id, user.id, body.helpful ? 1 : 0, note]
  );

  return NextResponse.json(await summary(doc.id, user.id));
}
