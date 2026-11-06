import { NextResponse } from "next/server";
import {
  emailTemplatesGate,
  canComposeEvent,
  readJsonBody,
  allowTestSend,
  BAD_JSON,
  FORBIDDEN,
} from "@/lib/email-parts-access";
import { previewComposition } from "@/lib/email-parts";
import type { PreviewInput } from "@/lib/email-parts";
import { sendMail } from "@/lib/mailer";
import { getSmtpConfig, smtpConfigured } from "@/lib/smtp-config";
import { requestOrigin } from "@/lib/oauth";
import { logEvent } from "@/lib/log";

export const dynamic = "force-dynamic";

// POST, the preview's body: render the combination with sample values and
// send it to the caller's own address only, subject prefixed "[Test] ".
// Five per person in ten minutes. Who may: whoever may save the event's
// composition.

export async function POST(req: Request) {
  const gate = await emailTemplatesGate();
  if (gate instanceof NextResponse) return gate;
  const body = await readJsonBody(req);
  if (!body) return BAD_JSON();
  const event = String(body.event_key ?? body.event ?? "");
  if (event && !canComposeEvent(gate, event)) return FORBIDDEN();
  const to = (gate.user.email || "").trim();
  if (!/^[^\s@<>]+@[^\s@<>]+$/.test(to)) {
    return NextResponse.json({ error: "Your account has no email address. Add one under Account → Profile." }, { status: 400 });
  }
  if (!smtpConfigured(await getSmtpConfig())) {
    return NextResponse.json({ error: "Email isn't set up yet. Add the SMTP server under Settings → Notifications → Email." }, { status: 409 });
  }
  const out = await previewComposition(body as PreviewInput, requestOrigin(req));
  if ("error" in out) return NextResponse.json({ error: out.error }, { status: out.status });
  if (!allowTestSend(gate.user.id)) {
    return NextResponse.json({ error: "That's a lot of test emails. Try again in a few minutes." }, { status: 429 });
  }
  try {
    await sendMail([to], `[Test] ${out.subject.replace(/[\r\n]+/g, " ")}`.slice(0, 400), out.text, out.html);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    logEvent("error", "email_template.test_failed", { event, error: message });
    return NextResponse.json({ error: `The test email couldn't be sent: ${message}` }, { status: 502 });
  }
  return NextResponse.json({ ok: true, to });
}
