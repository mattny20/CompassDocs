import { NextResponse } from "next/server";
import { sectionApiGuard } from "@/lib/api-auth";
import { featureEnabled } from "@/lib/ee";
import { createTrainingProgram, listTrainingPrograms } from "@/lib/db";
import { audit, actorFrom } from "@/lib/audit";
import type { SessionUser } from "@/lib/types";

export const dynamic = "force-dynamic";

async function gated() {
  const gate = await sectionApiGuard("training");
  if (gate instanceof NextResponse) return { denied: gate };
  if (!(await featureEnabled("training"))) {
    return {
      denied: NextResponse.json(
        { error: "Training is not included in your license." },
        { status: 402 }
      ),
    };
  }
  return { user: gate as SessionUser };
}

export async function GET() {
  const { denied } = await gated();
  if (denied) return denied;
  return NextResponse.json({ programs: await listTrainingPrograms() });
}

// Create an onboarding program: a named, ordered bundle of decks.
export async function POST(req: Request) {
  const { denied, user } = await gated();
  if (denied || !user) return denied!;
  const body = (await req.json().catch(() => ({}))) as {
    name?: string;
    deck_ids?: number[];
  };
  const name = String(body.name ?? "").trim();
  const deckIds = Array.isArray(body.deck_ids) ? body.deck_ids.filter(Number.isInteger) : [];
  if (!name) {
    return NextResponse.json({ error: "Give the program a name." }, { status: 400 });
  }
  if (!deckIds.length) {
    return NextResponse.json({ error: "Pick at least one deck." }, { status: 400 });
  }
  const id = await createTrainingProgram(name, deckIds, user.id);
  await audit({
    actor: actorFrom(user),
    action: "training.program_create",
    targetLabel: name,
    details: { decks: deckIds.length },
  });
  return NextResponse.json({ ok: true, id }, { status: 201 });
}
