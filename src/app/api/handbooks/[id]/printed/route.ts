import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/api-auth";
import { HandbookError, recordHandbookPrinted } from "@/lib/handbooks";
import type { SessionUser } from "@/lib/types";

export const dynamic = "force-dynamic";

// POST — the print page was sent to the printer (1.18.0): audits
// handbook.printed. The page calls it from `beforeprint`, which the Print
// button, the ?print=1 dialog and the browser's own Ctrl+P all raise. A
// handbook the caller may not read is 404, the shape every handbook route
// answers for "not yours"; the read check is lib/handbooks'.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await apiGuard("viewer");
  if (gate instanceof NextResponse) return gate;
  const user = gate as SessionUser;
  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: "Not found." }, { status: 404 });
  try {
    await recordHandbookPrinted(user, id, req);
  } catch (e) {
    if (e instanceof HandbookError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  return new NextResponse(null, { status: 204 });
}
