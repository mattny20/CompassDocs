import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/api-auth";
import { featureEnabled } from "@/lib/ee";
import {
  getMyTrainingAssignment,
  setTrainingProgress,
  setTrainingQuizScore,
  completeTraining,
} from "@/lib/db";
import { gradeQuiz, deckQuestions } from "@/lib/training";
import { verifyAttestation, signedNameFrom } from "@/lib/attestation";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import type { SessionUser } from "@/lib/types";

export const dynamic = "force-dynamic";

// Progress + completion for the signed-in assignee. The assignment itself is
// the access grant: training must be completable even when the deck's doc
// lives in a space the assignee can't browse.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await apiGuard("viewer", "training.progress_own");
  if (gate instanceof NextResponse) return gate;
  const user = gate as SessionUser;
  if (!(await featureEnabled("training"))) {
    return NextResponse.json({ error: "Training is not included in your license." }, { status: 402 });
  }

  const { id } = await params;
  const assignment = await getMyTrainingAssignment(Number(id), user.id);
  if (!assignment) {
    return NextResponse.json({ error: "No such training assignment." }, { status: 404 });
  }

  // The password is taken out of the body first, so nothing below can log
  // or audit it (the shared rule of lib/attestation's callers).
  const { password, ...body } = (await req.json().catch(() => ({}))) as {
    action?: string;
    slide?: number;
    answers?: number[][];
    typed_name?: string;
    password?: string;
  };
  if (body.action === "progress") {
    await setTrainingProgress(assignment.assignment_id, user.id, Number(body.slide) || 0);
    return NextResponse.json({ ok: true });
  }

  // Quiz: grade server-side against the doc (the answer key never leaves the
  // server) and store the latest attempt. Retakes are allowed pre-completion.
  if (body.action === "quiz") {
    const answers = Array.isArray(body.answers)
      ? body.answers.map((a) => (Array.isArray(a) ? a.map(Number) : []))
      : [];
    const graded = gradeQuiz(assignment.content, answers);
    if (graded.total === 0) {
      return NextResponse.json({ error: "This deck has no quiz." }, { status: 400 });
    }
    await setTrainingQuizScore(
      assignment.assignment_id,
      user.id,
      graded.score,
      graded.total,
      graded.results
    );
    const passed = graded.score / graded.total >= assignment.pass_pct / 100;
    return NextResponse.json({
      ok: true,
      score: graded.score,
      total: graded.total,
      passed,
      pass_pct: assignment.pass_pct,
      results: graded.results,
    });
  }

  if (body.action === "confirm") {
    // Quiz gate: a deck with questions requires a passing latest attempt.
    const total = deckQuestions(assignment.content).length;
    if (total > 0) {
      const score = assignment.quiz_score;
      const scored = assignment.quiz_total ?? 0;
      if (score === null || scored !== total || score / total < assignment.pass_pct / 100) {
        return NextResponse.json(
          {
            error: `Pass the quiz first — ${assignment.pass_pct}% or better is required to confirm.`,
          },
          { status: 409 }
        );
      }
    }
    // E-signature gate: the deck can demand a typed full name and (for local
    // accounts) the account password before the confirmation is recorded.
    // The check is lib/attestation's, shared with the read confirmation
    // route (C2, 1.12.0); this route keeps its own two sentences and the
    // helper's for the throttle it gained with the extraction. A wrong
    // password is audited as the sign-in form audits a miss
    // (auth.login_failed with `via: "attestation"`, and auth.lockout when
    // it engaged the throttle), against the deck; `signed` never carries
    // the password.
    let signedName: string | null = null;
    if (assignment.require_signature === 1) {
      const ip = ipFrom(req);
      const signed = await verifyAttestation(user, { signed_name: body.typed_name, password }, { ip });
      if (!signed.ok) {
        if (signed.code === "password") {
          await audit({
            actor: actorFrom(user),
            action: "auth.login_failed",
            targetType: "document",
            targetId: assignment.document_id,
            targetLabel: assignment.title,
            details: { via: "attestation" },
            ip,
          });
          if (signed.lock_engaged) {
            await audit({
              actor: actorFrom(user),
              action: "auth.lockout",
              targetType: "document",
              targetId: assignment.document_id,
              targetLabel: assignment.title,
              details: { minutes: 15 },
              ip,
            });
          }
        }
        const expected = user.name || user.username;
        const error =
          signed.code === "name"
            ? `Type your full name exactly as it appears on your account (${expected}).`
            : signed.code === "password"
              ? "Password check failed — re-enter your account password to sign."
              : signed.error;
        return NextResponse.json({ error }, { status: signed.status });
      }
      signedName = signedNameFrom(body.typed_name);
    }
    // The SHA-256 of the exact content confirmed is stored on every
    // completion — cheap, and it lets an auditor tie the record to the text.
    const contentSha256 = createHash("sha256").update(assignment.content).digest("hex");
    const done = await completeTraining(assignment.assignment_id, user.id, {
      contentSha256,
      signedName,
    });
    if (!done) return NextResponse.json({ ok: true, already: true });
    await audit({
      actor: actorFrom(user),
      action: "training.completed",
      targetType: "document",
      targetId: assignment.document_id,
      targetLabel: assignment.title,
      details: {
        confirmed_version: done.confirmed_version,
        quiz_score: assignment.quiz_score,
        quiz_total: assignment.quiz_total,
        content_sha256: contentSha256,
        ...(signedName ? { signed_name: signedName } : {}),
      },
    });
    return NextResponse.json({ ok: true });
  }
  return NextResponse.json({ error: "action must be progress, quiz, or confirm." }, { status: 400 });
}
