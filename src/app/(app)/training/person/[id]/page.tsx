import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, Download, GraduationCap } from "lucide-react";
import { requireUser } from "@/lib/auth";
import { canAccessSection } from "@/lib/section-access";
import { featureEnabled } from "@/lib/ee";
import { getUserById, userTrainingTranscript } from "@/lib/db";
import { getAppSettings } from "@/lib/settings-store";
import { formatDate } from "@/lib/format";
import { PrintButton } from "@/components/PrintButton";
import { PageContainer } from "@/components/PageWidth";

export const dynamic = "force-dynamic";

// A person's full training transcript — live assignments plus every closed
// recert cycle. Printable; CSV export next to it. Manager-only.

export default async function TrainingPersonPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!(await featureEnabled("training"))) notFound();
  if (!(await canAccessSection(user, "training"))) notFound();
  const { id } = await params;
  const person = await getUserById(Number(id));
  if (!person) notFound();
  const { current, history } = await userTrainingTranscript(person.id);
  const settings = await getAppSettings();
  const day = (iso: string | null) => (iso ? formatDate(iso, settings) : "—");
  const status = (completed_at: string | null, source: string) =>
    completed_at ? (source === "waived" ? "Waived" : "Completed") : "Open";

  return (
    <PageContainer>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <Link
            href="/training"
            className="inline-flex items-center gap-1 text-sm font-medium text-compass-600 hover:underline print:hidden"
          >
            <ArrowLeft className="h-4 w-4" /> Training
          </Link>
          <h1 className="mt-1 flex items-center gap-2 text-xl font-bold tracking-tight text-slate-900">
            <GraduationCap className="h-5 w-5 text-compass-600" /> Training transcript — {person.name}
          </h1>
          <p className="mt-0.5 text-sm text-slate-400">
            @{person.username} · every assignment and prior certification cycle on record.
          </p>
        </div>
        <div className="flex items-center gap-2 print:hidden">
          <a
            href={`/api/training/people/${person.id}?format=csv`}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-50"
          >
            <Download className="h-4 w-4" /> CSV
          </a>
          <PrintButton compact />
        </div>
      </div>

      <section className="overflow-x-auto rounded-xl border border-slate-200 bg-surface shadow-xs">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-100 text-left text-xs uppercase tracking-wide text-slate-400">
              <th className="px-4 py-2">Training</th>
              <th className="px-2 py-2">Status</th>
              <th className="px-2 py-2">Assigned</th>
              <th className="px-2 py-2">Due</th>
              <th className="px-2 py-2">Completed</th>
              <th className="px-2 py-2">Quiz</th>
              <th className="px-2 py-2">Version</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {current.map((r) => (
              <tr key={r.assignment_id}>
                <td className="px-4 py-2 font-medium text-slate-700">
                  {r.deck}
                  {r.deck_archived && (
                    <span className="ml-2 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] uppercase text-slate-500">
                      archived deck
                    </span>
                  )}
                </td>
                <td className="px-2 py-2">
                  <span
                    className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
                      status(r.completed_at, r.source) === "Completed"
                        ? "bg-emerald-100 text-emerald-700"
                        : status(r.completed_at, r.source) === "Waived"
                          ? "bg-slate-100 text-slate-500"
                          : "bg-compass-50 text-compass-700"
                    }`}
                  >
                    {status(r.completed_at, r.source)}
                  </span>
                </td>
                <td className="px-2 py-2 text-slate-500">{day(r.assigned_at)}</td>
                <td className="px-2 py-2 text-slate-500">{day(r.due_at)}</td>
                <td className="px-2 py-2 text-slate-500">{day(r.completed_at)}</td>
                <td className="px-2 py-2 text-slate-500">
                  {r.quiz_total ? `${r.quiz_score}/${r.quiz_total}` : "—"}
                </td>
                <td className="px-2 py-2 text-slate-500">{r.confirmed_version ?? "—"}</td>
              </tr>
            ))}
            {current.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-6 text-center text-slate-400">
                  No current assignments.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

      <h2 className="mt-6 text-sm font-semibold text-slate-800">
        Prior cycles ({history.length})
      </h2>
      <p className="mt-0.5 text-xs text-slate-400">
        Completions preserved when an assignment reopened for recertification or a document update.
      </p>
      <section className="mt-2 overflow-x-auto rounded-xl border border-slate-200 bg-surface shadow-xs">
        <table className="w-full text-sm">
          <tbody className="divide-y divide-slate-100">
            {history.map((h, i) => (
              <tr key={i}>
                <td className="px-4 py-2 font-medium text-slate-700">{h.deck_title || "(deleted deck)"}</td>
                <td className="px-2 py-2 text-slate-500">{status(h.completed_at, h.source)}</td>
                <td className="px-2 py-2 text-slate-500">completed {day(h.completed_at)}</td>
                <td className="px-2 py-2 text-slate-500">
                  {h.quiz_total ? `quiz ${h.quiz_score}/${h.quiz_total}` : ""}
                </td>
                <td className="px-2 py-2 text-slate-500">
                  {typeof h.confirmed_version === "number" ? `v${h.confirmed_version}` : ""}
                </td>
                <td className="px-2 py-2 text-xs text-slate-400">cycle closed {day(h.closed_at)}</td>
              </tr>
            ))}
            {history.length === 0 && (
              <tr>
                <td className="px-4 py-6 text-center text-slate-400">No prior cycles.</td>
              </tr>
            )}
          </tbody>
        </table>
      </section>
    </PageContainer>
  );
}
