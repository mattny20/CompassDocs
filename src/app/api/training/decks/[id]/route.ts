import { NextResponse } from "next/server";
import { sectionApiGuard } from "@/lib/api-auth";
import { featureEnabled } from "@/lib/ee";
import {
  getTrainingDeck,
  updateTrainingDeck,
  deleteTrainingDeck,
  trainingDeckStatus,
  trainingDropoff,
  reopenCompletedForDeck,
  getTrainingAssignment,
  assignTraining,
  waiveTraining,
  expandTrainingAudience,
} from "@/lib/db";
import { notify } from "@/lib/notifications";
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
    const lines = [
      "training,name,username,email,assigned_at,due_at,completed_at,confirmed_version,status",
    ];
    for (const r of rows) {
      const status = r.completed_at ? (r.source === "waived" ? "waived" : "completed") : "open";
      lines.push(
        [deck.title, r.name, r.username, r.email, r.assigned_at, r.due_at ?? "", r.completed_at ?? "", r.confirmed_version ?? "", status]
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
  return NextResponse.json({ deck, rows, dropoff: await trainingDropoff(deck.id) });
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
    archived?: boolean;
    pass_pct?: number;
    recert_months?: number | null;
  };
  await updateTrainingDeck(deck.id, {
    active: typeof body.active === "boolean" ? body.active : undefined,
    archived: typeof body.archived === "boolean" ? body.archived : undefined,
    pass_pct: typeof body.pass_pct === "number" ? body.pass_pct : undefined,
    recert_months:
      body.recert_months === undefined
        ? undefined
        : body.recert_months === null
          ? null
          : Math.min(60, Math.max(1, Math.floor(Number(body.recert_months) || 0))) || null,
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

// Hard-delete a deck and its assignment history.
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { denied, deck, user } = await gated(id);
  if (denied || !deck || !user) return denied!;
  await deleteTrainingDeck(deck.id);
  await audit({
    actor: actorFrom(user),
    action: "training.deck_delete",
    targetType: "document",
    targetId: deck.document_id,
    targetLabel: deck.title,
  });
  return NextResponse.json({ ok: true });
}

// Assign (or waive) audiences, nudge one person, or reopen completions.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { denied, deck, user } = await gated(id);
  if (denied || !deck || !user) return denied!;
  const body = (await req.json().catch(() => ({}))) as {
    user_ids?: number[];
    group_ids?: number[];
    everyone?: boolean;
    waive?: boolean;
    remind_assignment_id?: number;
    reopen_completed?: boolean;
  };

  // Instant nudge: one person, right now, regardless of the 3-day cadence.
  if (body.remind_assignment_id) {
    const a = await getTrainingAssignment(Number(body.remind_assignment_id));
    if (!a || a.deck_id !== deck.id || a.completed_at) {
      return NextResponse.json({ error: "No open assignment to remind." }, { status: 400 });
    }
    void notify([a.user_id], {
      kind: "training_due",
      title: `Reminder: ${deck.title}`,
      body: a.due_at ? `Due ${new Date(a.due_at).toLocaleDateString()}.` : "Please complete this training.",
      link: "/training",
      actorName: user.name || user.username,
    });
    await audit({
      actor: actorFrom(user),
      action: "training.reminded",
      targetType: "document",
      targetId: deck.document_id,
      targetLabel: deck.title,
      details: { user_id: a.user_id },
    });
    return NextResponse.json({ ok: true });
  }

  // The document changed materially — everyone who completed it goes again.
  // Prior completions are archived to history, so the audit trail keeps both.
  if (body.reopen_completed === true) {
    const reopened = await reopenCompletedForDeck(deck.id);
    if (reopened.length) {
      void notifyTrainingAssigned({
        userIds: reopened.map((r) => r.user_id),
        deckTitle: `${deck.title} (updated — please retake)`,
        dueAt: reopened[0]?.due_at ?? null,
        assignerName: user.name || user.username,
        origin: await publicOrigin(req),
      });
    }
    await audit({
      actor: actorFrom(user),
      action: "training.reopened",
      targetType: "document",
      targetId: deck.document_id,
      targetLabel: deck.title,
      details: { reopened: reopened.length },
    });
    return NextResponse.json({ ok: true, reopened: reopened.length });
  }
  const userIds = Array.isArray(body.user_ids) ? body.user_ids.filter(Number.isInteger) : [];
  const groupIds = Array.isArray(body.group_ids) ? body.group_ids.filter(Number.isInteger) : [];
  const audience = await expandTrainingAudience(userIds, groupIds, body.everyone === true);
  if (!audience.length) {
    return NextResponse.json({ error: "Pick at least one person or group." }, { status: 400 });
  }

  // Waive: mark complete without taking it (rollout grandfathering). No
  // notifications — nothing is being asked of anyone.
  if (body.waive === true) {
    const waived = await waiveTraining(deck.id, audience, user.name || user.username);
    await audit({
      actor: actorFrom(user),
      action: "training.waived",
      targetType: "document",
      targetId: deck.document_id,
      targetLabel: deck.title,
      details: { waived: waived.length, audience: audience.length },
    });
    return NextResponse.json({
      ok: true,
      waived: waived.length,
      already: audience.length - waived.length,
    });
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
