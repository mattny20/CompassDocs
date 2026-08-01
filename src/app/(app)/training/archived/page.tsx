import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, GraduationCap } from "lucide-react";
import { requireUser } from "@/lib/auth";
import { canAccessSection } from "@/lib/section-access";
import { featureEnabled } from "@/lib/ee";
import { listTrainingDecks } from "@/lib/db";
import { ArchivedDecks } from "@/components/ArchivedDecks";
import { PageContainer } from "@/components/PageWidth";

export const dynamic = "force-dynamic";

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
      <div className="mb-5">
        <Link
          href="/training"
          className="inline-flex items-center gap-1 text-sm font-medium text-compass-600 hover:underline"
        >
          <ArrowLeft className="h-4 w-4" /> Training
        </Link>
        <h1 className="mt-1 flex items-center gap-2 text-xl font-bold tracking-tight text-slate-900">
          <GraduationCap className="h-5 w-5 text-compass-600" /> Archived decks
        </h1>
        <p className="mt-0.5 text-sm text-slate-400">
          Hidden from everyone&apos;s Training tab. Restore brings a deck back exactly as it was;
          delete removes it and its completion history for good.
        </p>
      </div>
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
