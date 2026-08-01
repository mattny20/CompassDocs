import { NextResponse } from "next/server";
import { sectionApiGuard } from "@/lib/api-auth";
import { featureEnabled } from "@/lib/ee";
import { setSetting } from "@/lib/db";
import { getTrainingReportSettings } from "@/lib/training";
import { audit, actorFrom } from "@/lib/audit";
import type { SessionUser } from "@/lib/types";

export const dynamic = "force-dynamic";

// Monthly report settings: who gets the scheduled training summary email.
export async function GET() {
  const gate = await sectionApiGuard("training");
  if (gate instanceof NextResponse) return gate;
  if (!(await featureEnabled("training"))) {
    return NextResponse.json(
      { error: "Training is not included in your license." },
      { status: 402 }
    );
  }
  return NextResponse.json(await getTrainingReportSettings());
}

export async function PUT(req: Request) {
  const gate = await sectionApiGuard("training");
  if (gate instanceof NextResponse) return gate;
  if (!(await featureEnabled("training"))) {
    return NextResponse.json(
      { error: "Training is not included in your license." },
      { status: 402 }
    );
  }
  const user = gate as SessionUser;
  const body = (await req.json().catch(() => ({}))) as {
    enabled?: boolean;
    user_ids?: number[];
  };
  const settings = {
    enabled: body.enabled === true,
    user_ids: Array.isArray(body.user_ids)
      ? body.user_ids.map(Number).filter(Number.isInteger).slice(0, 100)
      : [],
  };
  await setSetting("training_report", JSON.stringify(settings));
  await audit({
    actor: actorFrom(user),
    action: "training.report_settings",
    details: { enabled: settings.enabled, recipients: settings.user_ids.length },
  });
  return NextResponse.json({ ok: true, ...settings });
}
