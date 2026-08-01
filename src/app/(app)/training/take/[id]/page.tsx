import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { featureEnabled } from "@/lib/ee";
import { getMyTrainingAssignment, getUserByUsername } from "@/lib/db";
import { parseDeck, publicQuiz, defaultComplianceText } from "@/lib/training";
import { TrainingPlayer } from "@/components/TrainingPlayer";

export const dynamic = "force-dynamic";

// The deck player. The assignment is the access grant — reachable only by
// its assignee, whatever space the underlying document lives in.

export default async function TrainingTakePage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!(await featureEnabled("training"))) notFound();
  const { id } = await params;
  const assignment = await getMyTrainingAssignment(Number(id), user.id);
  if (!assignment) notFound();

  const { slides, quizzes, complianceText } = parseDeck(assignment.content);
  // E-signature: local accounts also re-enter their password; SSO accounts
  // (no local password) sign by typed name alone.
  const record =
    assignment.require_signature === 1 ? await getUserByUsername(user.username) : undefined;
  return (
    <TrainingPlayer
      assignmentId={assignment.assignment_id}
      title={assignment.title}
      spaceName={assignment.space_name}
      slides={slides}
      // Questions only — the answer key never reaches the client.
      quizzes={publicQuiz(quizzes)}
      passPct={assignment.pass_pct}
      quizScore={assignment.quiz_score}
      quizTotal={assignment.quiz_total}
      complianceText={complianceText ?? defaultComplianceText()}
      initialSlide={Math.min(assignment.last_slide, slides.length)}
      completedAt={assignment.completed_at}
      waived={assignment.source === "waived"}
      dueAt={assignment.due_at}
      signature={
        assignment.require_signature === 1
          ? {
              required: true,
              passwordRequired: Boolean(record?.password_hash && record?.password_salt),
              expectedName: user.name || user.username,
            }
          : undefined
      }
    />
  );
}
