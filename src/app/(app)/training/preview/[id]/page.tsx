import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { canAccessSection } from "@/lib/section-access";
import { featureEnabled } from "@/lib/ee";
import { getTrainingDeck, getDocument } from "@/lib/db";
import { parseDeck, publicQuiz, defaultComplianceText } from "@/lib/training";
import { TrainingPlayer } from "@/components/TrainingPlayer";

export const dynamic = "force-dynamic";

// Manager preview: walk a deck exactly as trainees will, without assigning
// it to yourself. Nothing is recorded — quiz grading and the confirmation
// are disabled.

export default async function TrainingPreviewPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!(await featureEnabled("training"))) notFound();
  if (!(await canAccessSection(user, "training"))) notFound();
  const { id } = await params;
  const deck = await getTrainingDeck(Number(id));
  if (!deck) notFound();
  const doc = await getDocument(deck.document_id);
  if (!doc) notFound();

  const { slides, quizzes, complianceText } = parseDeck(doc.content);
  return (
    <TrainingPlayer
      assignmentId={0}
      preview
      title={`${deck.title} (preview)`}
      spaceName={deck.space_name}
      slides={slides}
      quizzes={publicQuiz(quizzes)}
      passPct={deck.pass_pct}
      quizScore={null}
      quizTotal={null}
      complianceText={complianceText ?? defaultComplianceText()}
      initialSlide={0}
      completedAt={null}
      dueAt={null}
    />
  );
}
