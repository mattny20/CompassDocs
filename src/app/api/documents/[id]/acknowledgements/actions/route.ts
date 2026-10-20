import { NextResponse } from "next/server";
import { getDocument } from "@/lib/db";
import { apiGuard } from "@/lib/api-auth";
import { spaceScopeFor, scopeAllows, canSeeDrafts, userHolds } from "@/lib/access";
import { featureEnabled } from "@/lib/ee";
import { actorFrom, ipFrom } from "@/lib/audit";
import { requestOrigin } from "@/lib/oauth";
import { parseAssignmentRequest } from "@/lib/ack-assignments";
import { runAssignmentAction } from "@/lib/ack-assignment-actions";
import type { SessionUser } from "@/lib/types";

export const dynamic = "force-dynamic";

// POST { action, assignment_ids, days?, reason?, until? }: the space-scoped
// twin of POST /api/admin/compliance/assignments (D2, 1.13.0), so a steward
// of the policy's space acts on its roster without the Compliance section.
// The same actions, bodies and answers; the one difference is the bound:
// every write runs WHERE id = ANY($ids) AND document_id = $docId, so ids
// from another document (another space's roster) are never touched and
// come back in `skipped`.
//
// Guards, in order (A7's shape): session and CSRF (apiGuard), the viewer's
// space scope (404, so a hidden document stays hidden), the draft rule
// (404 for a draft the caller may not read), the licence (402),
// document.ack_require on the space OR compliance.program_manage (403;
// apiGuard takes one permission, so the OR is written out), then the body
// (400 with the first problem named; 400 for the caller's own row on
// exempt).
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await apiGuard("approver", "document.ack_require");
  if (gate instanceof NextResponse) return gate;
  const user = gate as SessionUser;

  const { id } = await params;
  const doc = await getDocument(Number(id));
  if (!doc || !scopeAllows(await spaceScopeFor(user), doc.space_id)) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  if (doc.status === "draft" && !(await canSeeDrafts(user, doc.space_id))) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  if (!(await featureEnabled("policy_ack"))) {
    return NextResponse.json({ error: "Read confirmations are not included in your license." }, { status: 402 });
  }
  const allowed =
    (await userHolds(user, "document.ack_require", { spaceId: doc.space_id, legacyMin: "approver" })) ||
    (await userHolds(user, "compliance.program_manage", { legacyMin: "admin" }));
  if (!allowed) {
    return NextResponse.json({ error: "You don't have permission for that." }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }
  const parsed = parseAssignmentRequest(body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const outcome = await runAssignmentAction(parsed.req, {
    doc: { id: doc.id, title: doc.title },
    actor: { id: user.id, name: user.name || user.username },
    audit: { actor: actorFrom(user), ip: ipFrom(req) },
    origin: requestOrigin(req),
  });
  return NextResponse.json(outcome.body, { status: outcome.status });
}
