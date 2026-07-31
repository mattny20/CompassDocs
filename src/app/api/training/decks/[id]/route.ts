import { NextResponse } from "next/server";
import { sectionApiGuard } from "@/lib/api-auth";
import { featureEnabled } from "@/lib/ee";
import {
  getTrainingDeck,
  updateTrainingDeck,
  trainingDeckStatus,
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
  const deck = await getTrainingDeck(Number(idRaw));
  if (!deck) {
    return { denied: NextResponse.json({ error: "No such training deck." }, { status: 404 }) };
  }
  return { user: gate as SessionUser, deck };
}

// Per-deck status (JSON, or CSV with ?format=csv).
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { denied, deck } = await gated(id);
  if (denied || !deck) return denied!;
  const rows = await trainingDeckStatus(deck.id);

  const url = new URL(req.url);
  if (url.searchParams.get("format") === "csv") {
    const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const lines = ["training,name,username,email,assigned_at,due_at,completed_at,confirmed_version"];
    for (const r of rows) {
      lines.push(
        [deck.title, r.name, r.username, r.email, r.assigned_at, r.due_at ?? "", r.completed_at ?? "", r.confirmed_version ?? ""]
          .map(esc)
          .join(",")
      );
    }
    return new Response(lines.join("\n") + "\n", {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="training-deck-${deck.id}.csv"`,
      },
    });
  }
  return NextResponse.json({ deck, rows });
}

// Deck settings.
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { denied, deck, user } = await gated(id);
  if (denied || !deck || !user) return denied!;
  const body = (await req.json().catch(() => ({}))) as {
    active?: boolean;
    due_days?: number | null;
    assign_new_members?: boolean;
  };
  await updateTrainingDeck(deck.id, {
    active: typeof body.active === "boolean" ? body.active : undefined,
    due_days:
      body.due_days === undefined
        ? undefined
        : body.due_days === null
          ? null
          : Math.min(365, Math.max(1, Math.floor(Number(body.due_days) || 0))) || null,
    assign_new_members:
      typeof body.assign_new_members === "boolean" ? body.assign_new_members : undefined,
  });
  await audit({
    actor: actorFrom(user),
    action: "training.deck_update",
    targetType: "document",
    targetId: deck.document_id,
    targetLabel: deck.title,
  });
  return NextResponse.json({ ok: true });
}

// Assign: users + groups, or everyone.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { denied, deck, user } = await gated(id);
  if (denied || !deck || !user) return denied!;
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

  const dueAt = deck.due_days
    ? new Date(Date.now() + deck.due_days * 86_400_000).toISOString()
    : null;
  const source = body.everyone ? "everyone" : groupIds.length ? "group" : "manual";
  const assigned = await assignTraining(deck.id, audience, user.name || user.username, source, dueAt);

  if (assigned.length) {
    void notifyTrainingAssigned({
      userIds: assigned,
      deckTitle: deck.title,
      dueAt,
      assignerName: user.name || user.username,
      origin: await publicOrigin(req),
    });
  }
  await audit({
    actor: actorFrom(user),
    action: "training.assigned",
    targetType: "document",
    targetId: deck.document_id,
    targetLabel: deck.title,
    details: { newly_assigned: assigned.length, audience: audience.length, source },
  });
  return NextResponse.json({ ok: true, assigned: assigned.length, already: audience.length - assigned.length });
}
