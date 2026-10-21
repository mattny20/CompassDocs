import { NextResponse } from "next/server";
import { complianceGuard } from "@/lib/api-auth";
import { featureEnabled } from "@/lib/ee";
import {
  getComplianceSettings,
  parseComplianceSettingsPatch,
  saveComplianceSettings,
  validateReportRecipients,
} from "@/lib/compliance-settings";
import { actorFrom, ipFrom } from "@/lib/audit";

export const dynamic = "force-dynamic";

// Program settings (E4): the defaults every policy inherits. Both handlers
// need `compliance.program_manage` (F6's complianceGuard: the Compliance
// section plus the key) and the policy_ack licence. PUT validates every key
// and refuses an unknown one with 400; each changed key writes its own
// `settings.compliance` audit row (lib/compliance-settings). The report
// block's recipients (F2) must be active accounts, the check PUT
// /api/admin/compliance/report makes, before anything is written.

async function gated() {
  const gate = await complianceGuard("compliance.program_manage");
  if (gate instanceof NextResponse) return { denied: gate };
  if (!(await featureEnabled("policy_ack"))) {
    return {
      denied: NextResponse.json(
        { error: "Read confirmations are not included in your license." },
        { status: 402 }
      ),
    };
  }
  return { user: gate };
}

export async function GET() {
  const { denied, user } = await gated();
  if (denied || !user) return denied!;
  return NextResponse.json({ settings: await getComplianceSettings() });
}

export async function PUT(req: Request) {
  const { denied, user } = await gated();
  if (denied || !user) return denied!;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }
  const parsed = parseComplianceSettingsPatch(body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  if (parsed.patch.ack_report?.recipients) {
    const problem = await validateReportRecipients(parsed.patch.ack_report.recipients);
    if (problem) return NextResponse.json({ error: problem }, { status: 400 });
  }

  const { settings, changes } = await saveComplianceSettings(parsed.patch, {
    actor: actorFrom(user),
    ip: ipFrom(req),
  });
  return NextResponse.json({ ok: true, settings, changed: changes.map((c) => c.key) });
}
