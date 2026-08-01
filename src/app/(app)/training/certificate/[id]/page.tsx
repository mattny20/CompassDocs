import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, GraduationCap } from "lucide-react";
import { requireUser } from "@/lib/auth";
import { canAccessSection } from "@/lib/section-access";
import { featureEnabled } from "@/lib/ee";
import { getTrainingAssignment } from "@/lib/db";
import { getAppSettings } from "@/lib/settings-store";
import { formatDate } from "@/lib/format";
import { PrintButton } from "@/components/PrintButton";

export const dynamic = "force-dynamic";

// Printable certificate for a real completion (waived records don't earn
// one). Visible to the person who completed it and to training managers.

export default async function TrainingCertificatePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requireUser();
  if (!(await featureEnabled("training"))) notFound();
  const { id } = await params;
  const a = await getTrainingAssignment(Number(id));
  if (!a || !a.completed_at || a.source === "waived") notFound();
  if (a.user_id !== user.id && !(await canAccessSection(user, "training"))) notFound();
  const settings = await getAppSettings();

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <div className="mb-6 flex items-center justify-between print:hidden">
        <Link
          href="/training"
          className="inline-flex items-center gap-1 text-sm font-medium text-compass-600 hover:underline"
        >
          <ArrowLeft className="h-4 w-4" /> Training
        </Link>
        <PrintButton compact />
      </div>

      <div className="rounded-2xl border-2 border-compass-200 bg-surface p-10 text-center shadow-xs print:border print:shadow-none">
        <div className="flex items-center justify-center gap-2 text-sm font-semibold uppercase tracking-widest text-compass-600">
          <GraduationCap className="h-5 w-5" /> Certificate of completion
        </div>
        <div className="mt-2 text-xs text-slate-400">{settings.company_name}</div>

        <p className="mt-8 text-sm text-slate-500">This certifies that</p>
        <div className="mt-1 text-3xl font-bold tracking-tight text-slate-900">{a.user_name}</div>
        <p className="mt-6 text-sm text-slate-500">completed the training</p>
        <div className="mt-1 text-xl font-semibold text-slate-800">{a.title}</div>

        <div className="mx-auto mt-8 grid max-w-md grid-cols-2 gap-x-8 gap-y-2 border-t border-slate-100 pt-6 text-sm">
          <div className="text-right text-slate-400">Completed</div>
          <div className="text-left font-medium text-slate-700">
            {formatDate(a.completed_at, settings)}
          </div>
          {a.quiz_total ? (
            <>
              <div className="text-right text-slate-400">Quiz score</div>
              <div className="text-left font-medium text-slate-700">
                {a.quiz_score}/{a.quiz_total} (
                {Math.round(((a.quiz_score ?? 0) / a.quiz_total) * 100)}%)
              </div>
            </>
          ) : null}
          <div className="text-right text-slate-400">Record</div>
          <div className="text-left font-medium text-slate-700">
            Assignment #{a.assignment_id}
            {typeof a.confirmed_version === "number" ? ` · doc version ${a.confirmed_version}` : ""}
          </div>
        </div>

        <p className="mt-8 text-xs text-slate-400">
          Issued by CompassDocs training records · {settings.company_name}
        </p>
      </div>
    </div>
  );
}
