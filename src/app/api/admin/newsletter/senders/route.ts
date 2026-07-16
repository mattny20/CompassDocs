import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/api-auth";
import {
  listNewsletterFromAddresses,
  saveNewsletterFromAddresses,
  isValidFromAddress,
} from "@/lib/newsletter";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import type { SessionUser } from "@/lib/types";

export const dynamic = "force-dynamic";

// The admin-curated list of newsletter From addresses. Composers pick one of
// these per newsletter (or leave the SMTP default).

export async function GET() {
  const gate = await apiGuard("admin");
  if (gate instanceof NextResponse) return gate;
  return NextResponse.json({ from_addresses: await listNewsletterFromAddresses() });
}

export async function PUT(req: Request) {
  const gate = await apiGuard("admin");
  if (gate instanceof NextResponse) return gate;
  const admin = gate as SessionUser;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  if (!Array.isArray(body?.from_addresses)) {
    return NextResponse.json({ error: "from_addresses must be a list." }, { status: 400 });
  }
  const entries = body.from_addresses.map((e: unknown) => String(e ?? "").trim()).filter(Boolean);
  const bad = entries.find((e: string) => !isValidFromAddress(e));
  if (bad) {
    return NextResponse.json(
      { error: `"${bad}" isn't a valid sender — use address@domain or Name <address@domain>.` },
      { status: 400 }
    );
  }
  const saved = await saveNewsletterFromAddresses(entries);
  await audit({
    actor: actorFrom(admin),
    action: "newsletter.senders_updated",
    targetType: "settings",
    targetLabel: "newsletter_from_addresses",
    details: { count: saved.length },
    ip: ipFrom(req),
  });
  return NextResponse.json({ from_addresses: saved });
}
