import { NextResponse } from "next/server";
import { getDocument, ackStatusForDocument } from "@/lib/db";
import { apiGuard } from "@/lib/api-auth";
import { spaceScopeFor, scopeAllows } from "@/lib/access";
import { featureEnabled } from "@/lib/ee";
import type { SessionUser } from "@/lib/types";

export const dynamic = "force-dynamic";

// The compliance record: who has (and hasn't) acknowledged the current
// revision. Approver+; ?format=csv downloads it.
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await apiGuard("approver");
  if (gate instanceof NextResponse) return gate;
  const user = gate as SessionUser;

  if (!(await featureEnabled("policy_ack"))) {
    return NextResponse.json(
      { error: "Policy acknowledgements are not included in your license." },
      { status: 402 }
    );
  }

  const { id } = await params;
  const doc = await getDocument(Number(id));
  if (!doc || !scopeAllows(await spaceScopeFor(user), doc.space_id)) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  const rows = await ackStatusForDocument(doc.id);
  const url = new URL(req.url);
  if (url.searchParams.get("format") === "csv") {
    const esc = (v: string) => `"${String(v).replace(/"/g, '""')}"`;
    const csv = [
      "name,username,email,role,status,acknowledged_at,document,revision_as_of",
      ...rows.map((r) =>
        [
          esc(r.name),
          esc(r.username),
          esc(r.email),
          r.role,
          r.acknowledged_at ? "acknowledged" : "pending",
          r.acknowledged_at ?? "",
          esc(doc.title),
          doc.updated_at,
        ].join(",")
      ),
    ].join("\n");
    return new Response(csv, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="acknowledgements-doc-${doc.id}.csv"`,
      },
    });
  }
  return NextResponse.json({
    doc: { id: doc.id, title: doc.title, updated_at: doc.updated_at, ack_required: doc.ack_required },
    rows,
  });
}
