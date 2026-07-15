import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/api-auth";
import { getSmtpConfig, updateSmtpConfig, smtpConfigured } from "@/lib/smtp-config";
import { sendMail } from "@/lib/mailer";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import type { SessionUser } from "@/lib/types";

export const dynamic = "force-dynamic";

// The SMTP password is write-only: GET only reports whether one is stored.
async function view() {
  const cfg = await getSmtpConfig();
  return {
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    user: cfg.user,
    has_pass: Boolean(cfg.pass),
    from: cfg.from,
    configured: smtpConfigured(cfg),
  };
}

export async function GET() {
  const gate = await apiGuard("admin");
  if (gate instanceof NextResponse) return gate;
  return NextResponse.json(await view());
}

export async function PATCH(req: Request) {
  const gate = await apiGuard("admin");
  if (gate instanceof NextResponse) return gate;
  const user = gate as SessionUser;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  // Test delivery to a given address using the SAVED configuration.
  if (body?.action === "test") {
    const to = String(body?.to ?? "").trim();
    if (!to.includes("@")) {
      return NextResponse.json({ error: "Enter a recipient address for the test." }, { status: 400 });
    }
    try {
      await sendMail([to], "CompassDocs test email", "SMTP is configured correctly.");
      return NextResponse.json({ ok: true, status: `sent to ${to}` });
    } catch (e) {
      return NextResponse.json(
        { ok: false, error: e instanceof Error ? e.message : "Send failed." },
        { status: 502 }
      );
    }
  }

  await updateSmtpConfig({
    ...(body?.host !== undefined ? { host: String(body.host) } : {}),
    ...(body?.port !== undefined ? { port: Number(body.port) || 587 } : {}),
    ...(body?.secure !== undefined ? { secure: String(body.secure) } : {}),
    ...(body?.user !== undefined ? { user: String(body.user) } : {}),
    ...(typeof body?.pass === "string" && body.pass !== "" ? { pass: body.pass } : {}),
    ...(body?.clear_pass === true ? { pass: "" } : {}),
    ...(body?.from !== undefined ? { from: String(body.from) } : {}),
  });
  await audit({
    actor: actorFrom(user),
    action: "settings.smtp",
    details: { pass_changed: Boolean(body?.pass) || body?.clear_pass === true },
    ip: ipFrom(req),
  });
  return NextResponse.json({ ok: true, state: await view() });
}
