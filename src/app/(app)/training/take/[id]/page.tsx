import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { featureEnabled } from "@/lib/ee";
import { getMyTrainingAssignment } from "@/lib/db";
import { splitSlides, defaultComplianceText } from "@/lib/training";
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

  const { slides, complianceText } = splitSlides(assignment.content);
  return (
    <TrainingPlayer
      assignmentId={assignment.assignment_id}
      title={assignment.title}
      spaceName={assignment.space_name}
      slides={slides}
      complianceText={complianceText ?? defaultComplianceText()}
      initialSlide={Math.min(assignment.last_slide, slides.length)}
      completedAt={assignment.completed_at}
      dueAt={assignment.due_at}
    />
  );
}
