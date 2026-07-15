import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/api-auth";
import { getWebhook, updateWebhook, deleteWebhook } from "@/lib/db";
import { WEBHOOK_EVENTS, WEBHOOK_FORMATS, testWebhook } from "@/lib/webhooks";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import type { SessionUser } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await apiGuard("admin");
  if (gate instanceof NextResponse) return gate;
  const user = gate as SessionUser;

  const { id } = await params;
  const hook = await getWebhook(Number(id));
  if (!hook) return NextResponse.json({ error: "Not found." }, { status: 404 });

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  // Test delivery (also updates last_status for the UI).
  if (body?.action === "test") {
    const status = await testWebhook(hook);
    return NextResponse.json({ ok: status.startsWith("ok"), status });
  }

  const patch: any = {};
  if (typeof body?.name === "string") patch.name = body.name.trim();
  if (typeof body?.url === "string" && body.url.trim()) {
    try {
      const parsed = new URL(body.url.trim());
      if (!["http:", "https:"].includes(parsed.protocol)) throw new Error();
      patch.url = body.url.trim();
    } catch {
      return NextResponse.json({ error: "Enter a valid http(s) webhook URL." }, { status: 400 });
    }
  }
  if (WEBHOOK_FORMATS.includes(body?.format)) patch.format = body.format;
  if (Array.isArray(body?.events)) {
    const events = body.events.filter((e: string) =>
      (WEBHOOK_EVENTS as readonly string[]).includes(e)
    );
    if (!events.length) return NextResponse.json({ error: "Pick at least one event." }, { status: 400 });
    patch.events = events;
  }
  if (body?.enabled !== undefined) patch.enabled = Boolean(body.enabled);

  await updateWebhook(hook.id, patch);
  await audit({
    actor: actorFrom(user),
    action: "settings.webhook_updated",
    details: { id: hook.id },
    ip: ipFrom(req),
  });
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await apiGuard("admin");
  if (gate instanceof NextResponse) return gate;
  const user = gate as SessionUser;

  const { id } = await params;
  const ok = await deleteWebhook(Number(id));
  if (!ok) return NextResponse.json({ error: "Not found." }, { status: 404 });
  await audit({
    actor: actorFrom(user),
    action: "settings.webhook_deleted",
    details: { id: Number(id) },
    ip: ipFrom(req),
  });
  return NextResponse.json({ ok: true });
}
