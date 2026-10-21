import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/api-auth";
import { featureEnabled } from "@/lib/ee";
import { userPolicyTranscript } from "@/lib/db";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { csvCell } from "@/lib/csv";
import { RECORD_CSV_HEADER, recordCsvCells } from "@/lib/read-evidence";

export const dynamic = "force-dynamic";

// One person's compliance record (F3, 1.14.0): every policy they must
// confirm with the evidence, their prior confirmations, the closed
// assignments, the rows on retired policies and the notices they were sent.
// JSON, or ?format=csv (the 21 columns of RECORD_CSV_HEADER). `me` is the
// viewer's own record.
//
// Any signed-in account may ask; who sees what is the four-way rule in
// lib/db userPolicyTranscript (the person, the Compliance section, a group
// lead within their own spaces, a space roster reader within theirs), and
// everyone else is answered 404, the same 404 an unknown id gets, so the
// route never says whether an account exists. The filter runs in SQL: a
// lead's JSON and CSV carry no private-space title, IP or row, only the
// count of hidden policies. Every CSV download writes ack.record_exported
// before the response streams.

function notFound(): NextResponse {
  return NextResponse.json({ error: "No such person." }, { status: 404 });
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await apiGuard("viewer");
  if (gate instanceof NextResponse) return gate;
  const viewer = gate;

  if (!(await featureEnabled("policy_ack"))) {
    return NextResponse.json({ error: "Read confirmations are not included in your license." }, { status: 402 });
  }

  const { id } = await params;
  const userId = id === "me" ? viewer.id : Number(id);
  if (!Number.isInteger(userId) || userId <= 0) return notFound();

  const transcript = await userPolicyTranscript(userId, viewer);
  if (!transcript) return notFound();

  const url = new URL(req.url);
  if (url.searchParams.get("format") === "csv") {
    const rows = [...transcript.current, ...transcript.history];
    const csv = [RECORD_CSV_HEADER, ...rows.map((r) => recordCsvCells(r).map(csvCell).join(","))].join("\n") + "\n";
    // On the record before the response streams, as every compliance export is.
    await audit({
      actor: actorFrom(viewer),
      action: "ack.record_exported",
      targetType: "user",
      targetId: transcript.person.id,
      targetLabel: transcript.person.name || transcript.person.username,
      details: {
        user_id: transcript.person.id,
        rows: rows.length,
        viewer_kind: transcript.viewer_kind,
        hidden: transcript.hidden,
      },
      ip: ipFrom(req),
    });
    const stem = transcript.person.username.replace(/[^A-Za-z0-9._-]+/g, "_") || String(transcript.person.id);
    return new Response(csv, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="compliance-record-${stem}.csv"`,
      },
    });
  }

  return NextResponse.json(transcript);
}
