import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/api-auth";
import {
  EMAIL_TEMPLATES,
  templateDef,
  templateOverride,
  saveTemplateOverride,
  resetTemplate,
  previewEmail,
} from "@/lib/email-templates";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { requestOrigin } from "@/lib/oauth";
import type { SessionUser } from "@/lib/types";

export const dynamic = "force-dynamic";

// Admin-editable email templates (Settings → Notifications → Email templates).
// GET lists every template with its default and any override; PUT saves an
// override; DELETE resets one to the default; POST renders a live preview of
// unsaved subject/body with realistic sample values.

const MAX_SUBJECT = 300;
const MAX_BODY = 20_000;

export async function GET() {
  const gate = await apiGuard("admin");
  if (gate instanceof NextResponse) return gate;

  const templates = await Promise.all(
    EMAIL_TEMPLATES.map(async (t) => {
      const override = await templateOverride(t.key);
      return {
        key: t.key,
        label: t.label,
        description: t.description,
        tags: t.tags,
        default_subject: t.subject,
        default_body: t.body,
        subject: override?.subject ?? t.subject,
        body: override?.body ?? t.body,
        customized: !!override,
      };
    })
  );
  return NextResponse.json({ templates });
}

export async function PUT(req: Request) {
  const gate = await apiGuard("admin");
  if (gate instanceof NextResponse) return gate;
  const user = gate as SessionUser;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }
  const def = templateDef(String(body?.key ?? ""));
  if (!def) return NextResponse.json({ error: "Unknown template." }, { status: 404 });
  const subject = String(body?.subject ?? "").trim();
  const md = String(body?.body ?? "").trim();
  if (!subject || !md) {
    return NextResponse.json({ error: "Subject and body are both required." }, { status: 400 });
  }
  if (subject.length > MAX_SUBJECT || md.length > MAX_BODY) {
    return NextResponse.json({ error: "Template is too long." }, { status: 400 });
  }

  // Saving the untouched default = no override.
  if (subject === def.subject && md === def.body) {
    await resetTemplate(def.key);
  } else {
    await saveTemplateOverride(def.key, subject, md);
  }
  await audit({
    actor: actorFrom(user),
    action: "settings.email_template",
    targetType: "email_template",
    targetId: def.key,
    targetLabel: def.label,
    ip: ipFrom(req),
  });
  return NextResponse.json({ ok: true, customized: !(subject === def.subject && md === def.body) });
}

export async function DELETE(req: Request) {
  const gate = await apiGuard("admin");
  if (gate instanceof NextResponse) return gate;
  const user = gate as SessionUser;

  const key = new URL(req.url).searchParams.get("key") ?? "";
  const def = templateDef(key);
  if (!def) return NextResponse.json({ error: "Unknown template." }, { status: 404 });
  await resetTemplate(def.key);
  await audit({
    actor: actorFrom(user),
    action: "settings.email_template_reset",
    targetType: "email_template",
    targetId: def.key,
    targetLabel: def.label,
    ip: ipFrom(req),
  });
  return NextResponse.json({ ok: true, subject: def.subject, body: def.body });
}

export async function POST(req: Request) {
  const gate = await apiGuard("admin");
  if (gate instanceof NextResponse) return gate;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }
  const def = templateDef(String(body?.key ?? ""));
  if (!def) return NextResponse.json({ error: "Unknown template." }, { status: 404 });
  const subject = String(body?.subject ?? def.subject).slice(0, MAX_SUBJECT);
  const md = String(body?.body ?? def.body).slice(0, MAX_BODY);
  const rendered = await previewEmail(def.key, subject, md, requestOrigin(req));
  return NextResponse.json(rendered);
}
