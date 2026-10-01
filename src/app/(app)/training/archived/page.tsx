import { notFound } from "next/navigation";
import { GraduationCap } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { requireUser } from "@/lib/auth";
import { canAccessSection } from "@/lib/section-access";
import { featureEnabled } from "@/lib/ee";
import { listTrainingDecks } from "@/lib/db";
import { ArchivedDecks } from "@/components/ArchivedDecks";
import { PageContainer } from "@/components/PageWidth";

export const dynamic = "force-dynamic";
export const metadata = { title: "Archived training" };

// Archived training decks, tucked out of the main Training tab. Managers can
// restore a deck (everything comes back exactly as it was) or delete it for
// good, which also drops its assignment history.

export default async function ArchivedTrainingPage() {
  const user = await requireUser();
  if (!(await featureEnabled("training"))) notFound();
  if (!(await canAccessSection(user, "training"))) notFound();
  const decks = await listTrainingDecks(true);

  return (
    <PageContainer>
      <PageHeader
        icon={<GraduationCap />}
        title="Archived decks"
        subtitle="Hidden from everyone's Training tab. Restore brings a deck back exactly as it was; delete removes it and its completion history for good."
        back={{ href: "/training", label: "Training" }}
        className="mb-5"
      />
      <ArchivedDecks
        decks={decks.map((d) => ({
          id: d.id,
          title: d.title,
          space_name: d.space_name,
          space_icon: d.space_icon,
          archived_at: d.archived_at,
          assigned: d.assigned,
          completed: d.completed,
        }))}
      />
    </PageContainer>
  );
}
