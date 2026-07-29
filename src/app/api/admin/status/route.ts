import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/api-auth";
import { addStatusService, deleteStatusService } from "@/lib/db";
import { refreshDueStatuses, STATUS_PROVIDERS } from "@/lib/status";
import { requestOrigin } from "@/lib/oauth";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import type { SessionUser } from "@/lib/types";

export const dynamic = "force-dynamic";

// Admin management of tracked services. Adding polls immediately so the row
// has real state by the time the admin looks at the board.
export async function POST(req: Request) {
  const gate = await apiGuard("admin");
  if (gate instanceof NextResponse) return gate;
  const user = gate as SessionUser;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  const name = String(body?.name ?? "").trim().slice(0, 80);
  const provider = String(body?.provider ?? "");
  const sourceUrl = String(body?.source_url ?? "").trim().slice(0, 300);
  if (!name) return NextResponse.json({ error: "A name is required." }, { status: 400 });
  if (!STATUS_PROVIDERS.includes(provider as any)) {
    return NextResponse.json({ error: "Unknown provider." }, { status: 400 });
  }
  const needsUrl = ["statuspage", "rss"].includes(provider);
  if (needsUrl && !/^https:\/\/\S+$/.test(sourceUrl)) {
    return NextResponse.json(
      { error: "This provider needs an https:// status page or feed URL." },
      { status: 400 }
    );
  }

  const service = await addStatusService({ name, provider, source_url: sourceUrl });
  await audit({
    actor: actorFrom(user),
    action: "status.service_added",
    details: { name, provider },
    ip: ipFrom(req),
  });
  // First poll now (fire-and-forget — the row shows "unknown" until it lands).
  void refreshDueStatuses(requestOrigin(req)).catch(() => {});
  return NextResponse.json({ service }, { status: 201 });
}

export async function DELETE(req: Request) {
  const gate = await apiGuard("admin");
  if (gate instanceof NextResponse) return gate;
  const user = gate as SessionUser;
  const id = Number(new URL(req.url).searchParams.get("id"));
  if (!Number.isInteger(id)) {
    return NextResponse.json({ error: "id required." }, { status: 400 });
  }
  const ok = await deleteStatusService(id);
  if (!ok) return NextResponse.json({ error: "Not found." }, { status: 404 });
  await audit({
    actor: actorFrom(user),
    action: "status.service_removed",
    details: { id },
    ip: ipFrom(req),
  });
  return NextResponse.json({ ok: true });
}
