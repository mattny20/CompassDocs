import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/api-auth";
import { answer, jsonBody } from "@/lib/handbook-api";
import { canCreateHandbooks, createHandbook, listHandbooks, parseHandbookInput } from "@/lib/handbooks";

export const dynamic = "force-dynamic";

// Handbooks (1.18.0).
//
//   GET  → { handbooks: HandbookSummary[], can_create }: the published
//          handbooks the caller is in the audience of, plus every handbook
//          (any status) they may edit, by title. `progress` is filled for
//          editors and compliance readers only (lib/handbooks).
//   POST { title, space_id?, introduction?, audience?, group_ids?,
//          confirm_whole?, require_signature? } → 201 { handbook } (the
//          editor's view: forEdit). A new handbook is a draft with one
//          empty section. space_id null/absent = a workspace handbook,
//          which needs handbook.manage held globally; a space handbook
//          needs it on that space. 400 with the first problem named, 403
//          "You can't own a handbook there.". Audited as handbook.created.
//
// Reading needs only a session (the audience decides); writing needs
// handbook.manage somewhere (admin under the legacy break-glass), then the
// per-handbook check in lib/handbooks.

export async function GET() {
  const gate = await apiGuard("viewer");
  if (gate instanceof NextResponse) return gate;
  return answer(async () => ({ handbooks: await listHandbooks(gate), can_create: await canCreateHandbooks(gate) }));
}

export async function POST(req: Request) {
  const gate = await apiGuard("admin", "handbook.manage");
  if (gate instanceof NextResponse) return gate;
  const b = await jsonBody(req);
  if ("denied" in b) return b.denied;
  const parsed = parseHandbookInput(b.body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  return answer(async () => ({ handbook: await createHandbook(gate, parsed.value, req) }), 201);
}
