import { NextResponse } from "next/server";
import { complianceGuard, type ComplianceKey } from "@/lib/api-auth";
import { featureEnabled } from "@/lib/ee";
import {
  readComplianceSettings,
  saveComplianceSettings,
  parseAckReportPatch,
  validateReportRecipients,
} from "@/lib/compliance-settings";
import { listUsers, lastComplianceReportSent } from "@/lib/db";
import { actorFrom, ipFrom } from "@/lib/audit";
import type { SessionUser } from "@/lib/types";

export const dynamic = "force-dynamic";

// The scheduled programme report's settings (F2, 1.14.0): `ack_report`
// = { enabled, cadence: 'weekly' | 'monthly', recipients: user ids }.
// GET (compliance.export) answers the settings with the recipients named
// and when the report last went out; PUT (compliance.program_manage) takes
// any subset, refuses the first problem with 400 (an unknown key, a bad
// value, a recipient that is not an active account) before anything is
// written, and audits each changed key as ack.report_settings
// (lib/compliance-settings saveComplianceSettings).

async function gated(key: ComplianceKey): Promise<{ denied: NextResponse } | { user: SessionUser }> {
  const gate = await complianceGuard(key);
  if (gate instanceof NextResponse) return { denied: gate };
  if (!(await featureEnabled("policy_ack"))) {
    return {
      denied: NextResponse.json({ error: "Read confirmations are not included in your license." }, { status: 402 }),
    };
  }
  return { user: gate };
}

async function answer() {
  const [{ ack_report }, users, last_sent] = await Promise.all([readComplianceSettings(), listUsers(), lastComplianceReportSent()]);
  const byId = new Map(users.map((u) => [u.id, u]));
  return {
    settings: ack_report,
    recipients: ack_report.recipients
      .map((id) => byId.get(id))
      .filter((u): u is NonNullable<typeof u> => Boolean(u))
      .map((u) => ({ id: u.id, name: u.name || u.username, username: u.username, email: u.email, status: u.status })),
    last_sent,
  };
}

export async function GET() {
  const gate = await gated("compliance.export");
  if ("denied" in gate) return gate.denied;
  return NextResponse.json(await answer(), { headers: { "Cache-Control": "no-store" } });
}

export async function PUT(req: Request) {
  const gate = await gated("compliance.program_manage");
  if ("denied" in gate) return gate.denied;
  const { user } = gate;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }
  const parsed = parseAckReportPatch(body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  if (parsed.patch.recipients) {
    const problem = await validateReportRecipients(parsed.patch.recipients);
    if (problem) return NextResponse.json({ error: problem }, { status: 400 });
  }
  const { changes } = await saveComplianceSettings({ ack_report: parsed.patch }, { actor: actorFrom(user), ip: ipFrom(req) });
  return NextResponse.json({ ok: true, changed: changes.map((c) => c.key), ...(await answer()) });
}
