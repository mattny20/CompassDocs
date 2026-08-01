import { NextResponse } from "next/server";
import { sectionApiGuard } from "@/lib/api-auth";
import { featureEnabled } from "@/lib/ee";
import {
  getTrainingDeck,
  getTrainingProgram,
  updateTrainingProgram,
  deleteTrainingProgram,
  assignTraining,
  expandTrainingAudience,
} from "@/lib/db";
import { notifyTrainingAssigned } from "@/lib/training";
import { publicOrigin } from "@/lib/oauth";
import { audit, actorFrom } from "@/lib/audit";
import type { SessionUser } from "@/lib/types";

export const dynamic = "force-dynamic";

async function gated(idRaw: string) {
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
  const program = await getTrainingProgram(Number(idRaw));
  if (!program) {
    return { denied: NextResponse.json({ error: "No such program." }, { status: 404 }) };
  }
  return { user: gate as SessionUser, program };
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { denied, program, user } = await gated(id);
  if (denied || !program || !user) return denied!;
  const body = (await req.json().catch(() => ({}))) as {
    name?: string;
    active?: boolean;
    assign_new_members?: boolean;
    deck_ids?: number[];
  };
  await updateTrainingProgram(program.id, {
    name: typeof body.name === "string" && body.name.trim() ? body.name.trim() : undefined,
    active: typeof body.active === "boolean" ? body.active : undefined,
    assign_new_members:
      typeof body.assign_new_members === "boolean" ? body.assign_new_members : undefined,
    deck_ids: Array.isArray(body.deck_ids) ? body.deck_ids.filter(Number.isInteger) : undefined,
  });
  await audit({
    actor: actorFrom(user),
    action: "training.program_update",
    targetLabel: program.name,
  });
  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { denied, program, user } = await gated(id);
  if (denied || !program || !user) return denied!;
  await deleteTrainingProgram(program.id);
  await audit({
    actor: actorFrom(user),
    action: "training.program_delete",
    targetLabel: program.name,
  });
  return NextResponse.json({ ok: true });
}

// Assign the whole program (every deck) to users + groups, or everyone.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { denied, program, user } = await gated(id);
  if (denied || !program || !user) return denied!;
  const body = (await req.json().catch(() => ({}))) as {
    user_ids?: number[];
    group_ids?: number[];
    everyone?: boolean;
  };
  const userIds = Array.isArray(body.user_ids) ? body.user_ids.filter(Number.isInteger) : [];
  const groupIds = Array.isArray(body.group_ids) ? body.group_ids.filter(Number.isInteger) : [];
  const audience = await expandTrainingAudience(userIds, groupIds, body.everyone === true);
  if (!audience.length) {
    return NextResponse.json({ error: "Pick at least one person or group." }, { status: 400 });
  }
  if (!program.decks.length) {
    return NextResponse.json({ error: "This program has no decks." }, { status: 400 });
  }

  // Assign every deck; notify each person once about the program rather than
  // once per deck (a six-deck program should not mean six emails).
  const source = body.everyone ? "everyone" : groupIds.length ? "group" : "manual";
  const notifiedIds = new Set<number>();
  let newAssignments = 0;
  for (const d of program.decks) {
    const deck = await getTrainingDeck(d.id);
    if (!deck || deck.archived_at || deck.active === 0) continue;
    const dueAt = deck.due_days
      ? new Date(Date.now() + deck.due_days * 86_400_000).toISOString()
      : null;
    const assigned = await assignTraining(
      deck.id,
      audience,
      user.name || user.username,
      source,
      dueAt
    );
    newAssignments += assigned.length;
    for (const uid of assigned) notifiedIds.add(uid);
  }

  if (notifiedIds.size) {
    void notifyTrainingAssigned({
      userIds: [...notifiedIds],
      deckTitle: `${program.name} (${program.decks.length} decks)`,
      dueAt: null,
      assignerName: user.name || user.username,
      origin: await publicOrigin(req),
    });
  }
  await audit({
    actor: actorFrom(user),
    action: "training.program_assigned",
    targetLabel: program.name,
    details: { new_assignments: newAssignments, audience: audience.length, source },
  });
  return NextResponse.json({ ok: true, assigned: newAssignments, people: notifiedIds.size });
}
