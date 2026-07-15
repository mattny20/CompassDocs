import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/api-auth";
import { listWebhooks, createWebhook } from "@/lib/db";
import { WEBHOOK_EVENTS, WEBHOOK_FORMATS } from "@/lib/webhooks";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import type { SessionUser } from "@/lib/types";

export const dynamic = "force-dynamic";

/** Webhook URLs embed their secret — only ever return a masked preview. */
function maskUrl(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname.length > 18 ? u.pathname.slice(0, 12) + "…" : u.pathname;
    return `${u.origin}${path}`;
  } catch {
    return url.slice(0, 30) + "…";
  }
}

function view(hooks: Awaited<ReturnType<typeof listWebhooks>>) {
  return hooks.map((h) => ({
    id: h.id,
    name: h.name,
    url_preview: maskUrl(h.url),
    format: h.format,
    events: h.events,
    enabled: h.enabled === 1,
    last_sent_at: h.last_sent_at,
    last_status: h.last_status,
  }));
}

export async function GET() {
  const gate = await apiGuard("admin");
  if (gate instanceof NextResponse) return gate;
  return NextResponse.json({ webhooks: view(await listWebhooks()) });
}

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

  const url = String(body?.url ?? "").trim();
  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) throw new Error();
  } catch {
    return NextResponse.json({ error: "Enter a valid http(s) webhook URL." }, { status: 400 });
  }
  const format = WEBHOOK_FORMATS.includes(body?.format) ? body.format : "generic";
  const events = (Array.isArray(body?.events) ? body.events : []).filter((e: string) =>
    (WEBHOOK_EVENTS as readonly string[]).includes(e)
  );
  if (!events.length) {
    return NextResponse.json({ error: "Pick at least one event." }, { status: 400 });
  }

  await createWebhook({ name: String(body?.name ?? "").trim(), url, format, events });
  await audit({
    actor: actorFrom(user),
    action: "settings.webhook_created",
    details: { format, events },
    ip: ipFrom(req),
  });
  return NextResponse.json({ ok: true, webhooks: view(await listWebhooks()) }, { status: 201 });
}
