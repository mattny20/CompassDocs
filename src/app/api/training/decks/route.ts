import { NextResponse } from "next/server";
import { sectionApiGuard } from "@/lib/api-auth";
import { featureEnabled } from "@/lib/ee";
import {
  createTrainingDeck,
  listTrainingDecks,
  trainingCandidateDocs,
  getDocument,
  listUsers,
  listGroups,
} from "@/lib/db";
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

// Manager view: decks with stats, candidate docs, and assignment audiences.
export async function GET() {
  const { denied } = await gated();
  if (denied) return denied;
  const [decks, candidates, users, groups] = await Promise.all([
    listTrainingDecks(),
    trainingCandidateDocs(),
    listUsers(),
    listGroups(),
  ]);
  return NextResponse.json({
    decks,
    candidates,
    users: users
      .filter((u) => u.status === "active")
      .map((u) => ({ id: u.id, label: u.name, sublabel: `${u.username} · ${u.role}` })),
    groups: groups.map((g) => ({ id: g.id, label: g.name, sublabel: `${g.member_count} members` })),
  });
}

// Create a deck from a published document.
export async function POST(req: Request) {
  const { denied, user } = await gated();
  if (denied || !user) return denied!;
  const body = (await req.json().catch(() => ({}))) as {
    document_id?: number;
    due_days?: number | null;
    assign_new_members?: boolean;
  };
  const docId = Number(body.document_id);
  const doc = Number.isInteger(docId) ? await getDocument(docId) : undefined;
  if (!doc || doc.status !== "published") {
    return NextResponse.json(
      { error: "Pick a published document to turn into a training deck." },
      { status: 400 }
    );
  }
  const dueDays =
    body.due_days === null || body.due_days === undefined
      ? null
      : Math.min(365, Math.max(1, Math.floor(Number(body.due_days) || 0))) || null;
  const created = await createTrainingDeck(
    doc.id,
    { due_days: dueDays, assign_new_members: body.assign_new_members === true },
    user.id
  );
  if (!created) {
    return NextResponse.json({ error: "That document is already a training deck." }, { status: 409 });
  }
  await audit({
    actor: actorFrom(user),
    action: "training.deck_create",
    targetType: "document",
    targetId: doc.id,
    targetLabel: doc.title,
  });
  return NextResponse.json({ ok: true, id: created.id }, { status: 201 });
}
