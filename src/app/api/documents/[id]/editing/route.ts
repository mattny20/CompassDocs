import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/api-auth";
import {
  getDocument,
  touchEditingPresence,
  clearEditingPresence,
  listOtherEditors,
} from "@/lib/db";
import { spaceScopeFor, scopeAllows } from "@/lib/access";

export const dynamic = "force-dynamic";

// Editing presence: the editor heartbeats here while open, and asks who else
// is in. Deliberately lightweight — no locking, just awareness.

async function gateDoc(gate: Awaited<ReturnType<typeof apiGuard>>, idRaw: string) {
  if (gate instanceof NextResponse) return gate;
  const doc = await getDocument(Number(idRaw));
  if (!doc || !scopeAllows(await spaceScopeFor(gate), doc.space_id)) {
    return NextResponse.json({ error: "Document not found." }, { status: 404 });
  }
  return doc;
}

/** POST — heartbeat ({leaving: true} clears it on editor close). */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = await apiGuard("editor", "document.presence");
  if (gate instanceof NextResponse) return gate;
  const { id } = await ctx.params;
  const doc = await gateDoc(gate, id);
  if (doc instanceof NextResponse) return doc;

  let leaving = false;
  try {
    leaving = Boolean((await req.json())?.leaving);
  } catch {
    // Empty body = normal heartbeat.
  }
  if (leaving) await clearEditingPresence(doc.id, gate.id);
  else await touchEditingPresence(doc.id, gate.id, gate.name || gate.username);

  return NextResponse.json({ others: await listOtherEditors(doc.id, gate.id) });
}
