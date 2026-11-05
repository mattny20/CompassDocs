import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/api-auth";
import { ipFrom } from "@/lib/audit";
import { featureEnabled } from "@/lib/ee";
import { CONFIRM_UNLICENSED, confirmHandbook, loadConfirmView } from "@/lib/handbook-confirm";
import type { SessionUser } from "@/lib/types";

export const dynamic = "force-dynamic";

// Confirm the whole handbook (1.18.0). Read confirmation is licensed
// (policy_ack): both methods answer 402 without it, as /api/documents/[id]/ack
// does. A handbook the caller may not read, or one that is not published,
// is 404, the shape every handbook route answers for "not yours".

function handbookId(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

// GET — where every policy in the handbook stands for the caller: the
// rows of the confirm page, the counts, the statement the server will
// store and whether a signature is asked (never anything about anyone
// else).
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await apiGuard("viewer");
  if (gate instanceof NextResponse) return gate;
  const user = gate as SessionUser;
  if (!(await featureEnabled("policy_ack"))) {
    return NextResponse.json({ error: CONFIRM_UNLICENSED }, { status: 402 });
  }
  const id = handbookId((await params).id);
  const view = id ? await loadConfirmView(user, id) : undefined;
  if (!view) return NextResponse.json({ error: "Not found." }, { status: 404 });
  return NextResponse.json(view, { headers: { "Cache-Control": "no-store" } });
}

// POST — confirm every policy that is waiting for the caller.
//
// Body: { agreed: true; versions: { [doc_id]: version_id }; signed_name?;
// password? }. `versions` is what the page showed for each outstanding
// policy; any that changed since answers 409 { stale: true } and nothing
// is written (the card's rule). `agreed` is the ticked statement (400
// without it). The signature is asked when any outstanding policy requires
// one or the handbook does: lib/attestation, once for the batch (409 /
// 429 with its own sentence). The password leaves the body here, before
// anything below can log or audit it, and is never stored. The rows, their
// audit echo and the handbook-level record are lib/handbook-confirm's.
//
// 200 { ok, confirmed, outstanding, stale, handbook_confirmed }: `stale`
// lists policies that changed between the check and their own write (each
// is its own transaction); the page refreshes into them.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await apiGuard("viewer", "document.ack_submit");
  if (gate instanceof NextResponse) return gate;
  const user = gate as SessionUser;

  const id = handbookId((await params).id);
  if (!id) return NextResponse.json({ error: "Not found." }, { status: 404 });

  const raw: unknown = await req.json().catch(() => null);
  const { password, ...body } = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<
    string,
    unknown
  > & { password?: unknown };

  const outcome = await confirmHandbook(
    user,
    id,
    { agreed: body.agreed, versions: body.versions, signed_name: body.signed_name, password },
    { ip: ipFrom(req), userAgent: req.headers.get("user-agent") ?? "" }
  );
  if (!outcome.ok) {
    return NextResponse.json(
      outcome.stale ? { stale: true, error: outcome.error } : { error: outcome.error },
      { status: outcome.status }
    );
  }
  return NextResponse.json(outcome);
}
