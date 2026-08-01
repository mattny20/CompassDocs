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
  unassignTraining,
  extendTrainingDue,
  setTrainingReminded,
  expandTrainingAudience,
} from "@/lib/db";
import { notifyTrainingAssigned, remindAssignmentsNow } from "@/lib/training";
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
      "training,name,username,email,assigned_at,due_at,completed_at,confirmed_version,quiz_score,quiz_total,prior_completions,status",
    ];
    for (const r of rows) {
      const status = r.completed_at ? (r.source === "waived" ? "waived" : "completed") : "open";
      lines.push(
        [deck.title, r.name, r.username, r.email, r.assigned_at, r.due_at ?? "", r.completed_at ?? "", r.confirmed_version ?? "", r.quiz_score ?? "", r.quiz_total ?? "", r.prior_completions, status]
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
    tag?: string;
  };
  await updateTrainingDeck(deck.id, {
    active: typeof body.active === "boolean" ? body.active : undefined,
    archived: typeof body.archived === "boolean" ? body.archived : undefined,
    pass_pct: typeof body.pass_pct === "number" ? body.pass_pct : undefined,
    tag: typeof body.tag === "string" ? body.tag.trim() : undefined,
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
    waive_assignment_ids?: number[];
    remind_assignment_id?: number;
    remind_assignment_ids?: number[];
    unassign_assignment_ids?: number[];
    extend_assignment_ids?: number[];
    extend_days?: number;
    reopen_assignment_id?: number;
    reopen_completed?: boolean;
  };
  const idList = (v: unknown): number[] =>
    Array.isArray(v) ? v.map(Number).filter(Number.isInteger) : [];

  // Instant nudge (single or bulk): in-app + pref-gated email, right now,
  // and the cadence clock resets so the sweep doesn't double-nudge.
  const remindIds = body.remind_assignment_id
    ? [Number(body.remind_assignment_id)]
    : idList(body.remind_assignment_ids);
  if (remindIds.length) {
    const reminded = await remindAssignmentsNow(deck, remindIds, user.name || user.username);
    if (reminded.length) await setTrainingReminded(reminded);
    await audit({
      actor: actorFrom(user),
      action: "training.reminded",
      targetType: "document",
      targetId: deck.document_id,
      targetLabel: deck.title,
      details: { reminded: reminded.length },
    });
    return NextResponse.json({ ok: true, reminded: reminded.length });
  }

  // Remove open assignments (mis-assignment, leavers). Completed = records.
  if (idList(body.unassign_assignment_ids).length) {
    const n = await unassignTraining(deck.id, idList(body.unassign_assignment_ids));
    await audit({
      actor: actorFrom(user),
      action: "training.unassigned",
      targetType: "document",
      targetId: deck.document_id,
      targetLabel: deck.title,
      details: { removed: n },
    });
    return NextResponse.json({ ok: true, removed: n });
  }

  // Push due dates out (leave, workload) — re-arms escalation.
  if (idList(body.extend_assignment_ids).length) {
    const days = Math.min(365, Math.max(1, Math.floor(Number(body.extend_days) || 7)));
    const n = await extendTrainingDue(deck.id, idList(body.extend_assignment_ids), days);
    await audit({
      actor: actorFrom(user),
      action: "training.due_extended",
      targetType: "document",
      targetId: deck.document_id,
      targetLabel: deck.title,
      details: { extended: n, days },
    });
    return NextResponse.json({ ok: true, extended: n, days });
  }

  // Waive specific assignments (bulk bar in the people table).
  if (idList(body.waive_assignment_ids).length) {
    const rows = await trainingDeckStatus(deck.id);
    const wanted = new Set(idList(body.waive_assignment_ids));
    const userIdsToWaive = rows
      .filter((r) => wanted.has(r.assignment_id) && !r.completed_at)
      .map((r) => r.user_id);
    const waived = await waiveTraining(deck.id, userIdsToWaive, user.name || user.username);
    await audit({
      actor: actorFrom(user),
      action: "training.waived",
      targetType: "document",
      targetId: deck.document_id,
      targetLabel: deck.title,
      details: { waived: waived.length },
    });
    return NextResponse.json({ ok: true, waived: waived.length });
  }

  // Reopen ONE person's completion (individual retraining).
  if (body.reopen_assignment_id) {
    const a = await getTrainingAssignment(Number(body.reopen_assignment_id));
    if (!a || a.deck_id !== deck.id || !a.completed_at) {
      return NextResponse.json({ error: "No completed assignment to reopen." }, { status: 400 });
    }
    const reopened = await reopenCompletedForDeck(deck.id, [a.assignment_id]);
    if (reopened.length) {
      void notifyTrainingAssigned({
        userIds: reopened.map((r) => r.user_id),
        deckTitle: `${deck.title} (please retake)`,
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
      details: { reopened: reopened.length, user_id: a.user_id },
    });
    return NextResponse.json({ ok: true, reopened: reopened.length });
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
