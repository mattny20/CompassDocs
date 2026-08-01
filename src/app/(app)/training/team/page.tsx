import { notFound } from "next/navigation";

import Link from "next/link";
import { PageContainer } from "@/components/PageWidth";
import { ArrowLeft, CircleAlert, CircleCheck, Users } from "lucide-react";
import { requireUser } from "@/lib/auth";
import { featureEnabled } from "@/lib/ee";
import { userLeadGroups, teamTrainingRows, type TeamTrainingRow } from "@/lib/db";
import { getAppSettings } from "@/lib/settings-store";
import { formatDate } from "@/lib/format";

export const dynamic = "force-dynamic";

// The team-lead scoped view: where the members of the groups this user
// leads stand on their assigned training. Leading a group IS the access
// grant — no training-section grant needed, and nothing outside those
// groups is visible.

export default async function TrainingTeamPage() {
  const user = await requireUser();
  if (!(await featureEnabled("training"))) notFound();
  const groups = await userLeadGroups(user.id);
  if (!groups.length) notFound();
  const [rows, settings] = await Promise.all([
    teamTrainingRows(groups.map((g) => g.id)),
    getAppSettings(),
  ]);

  const byGroup = new Map<number, { name: string; rows: TeamTrainingRow[] }>();
  for (const g of groups) byGroup.set(g.id, { name: g.name, rows: [] });
  for (const r of rows) byGroup.get(r.group_id)?.rows.push(r);
  const now = Date.now();
  const isOverdue = (r: TeamTrainingRow) =>
    !r.completed_at && r.due_at !== null && new Date(r.due_at).getTime() < now;

  return (
    <PageContainer>
      <div className="mb-5">
        <Link
          href="/training"
          className="inline-flex items-center gap-1 text-sm font-medium text-compass-600 hover:underline"
        >
          <ArrowLeft className="h-4 w-4" /> Training
        </Link>
        <h1 className="mt-2 flex items-center gap-2 text-xl font-bold tracking-tight text-slate-900">
          <Users className="h-5 w-5 text-compass-600" /> Your team&apos;s training
        </h1>
        <p className="mt-0.5 text-sm text-slate-400">
          Where the {groups.length === 1 ? "group you lead stands" : "groups you lead stand"} —
          you&apos;ll also get a weekly summary by email.
        </p>
      </div>

      <div className="space-y-5">
        {[...byGroup.values()].map((g) => {
          const assigned = g.rows.filter((r) => r.deck);
          const open = assigned.filter((r) => !r.completed_at);
          const overdue = assigned.filter(isOverdue);
          const members = new Set(g.rows.map((r) => r.user_id)).size;
          return (
            <section key={g.name} className="rounded-xl border border-slate-200 bg-surface shadow-xs">
              <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 px-4 py-3">
                <h2 className="text-sm font-semibold text-slate-800">{g.name}</h2>
                <span className="text-xs text-slate-400">
                  {members} {members === 1 ? "member" : "members"} · {assigned.length - open.length}{" "}
                  done · {open.length} open
                </span>
                {overdue.length > 0 && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-red-100 px-2 py-0.5 text-[11px] font-medium text-red-700">
                    <CircleAlert className="h-3 w-3" /> {overdue.length} overdue
                  </span>
                )}
              </div>
              {assigned.length === 0 ? (
                <p className="px-4 py-4 text-sm text-slate-400">No training assigned yet.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-slate-100 text-left text-[11px] uppercase tracking-wide text-slate-400">
                        <th className="px-4 py-1.5">Person</th>
                        <th className="px-2 py-1.5">Training</th>
                        <th className="px-2 py-1.5">Status</th>
                        <th className="px-2 py-1.5">Due</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {assigned.map((r, i) => (
                        <tr key={`${r.user_id}-${r.deck}-${i}`}>
                          <td className="px-4 py-1.5 font-medium text-slate-700">{r.name}</td>
                          <td className="px-2 py-1.5 text-slate-600">{r.deck}</td>
                          <td className="px-2 py-1.5">
                            {r.completed_at ? (
                              <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-600">
                                <CircleCheck className="h-3.5 w-3.5" />
                                {r.source === "waived" ? "Waived" : "Completed"}
                              </span>
                            ) : isOverdue(r) ? (
                              <span className="inline-flex items-center gap-1 text-xs font-medium text-red-600">
                                <CircleAlert className="h-3.5 w-3.5" /> Overdue
                              </span>
                            ) : (
                              <span className="text-xs font-medium text-slate-500">
                                {r.last_slide > 0 ? "In progress" : "Not started"}
                              </span>
                            )}
                          </td>
                          <td className="px-2 py-1.5 text-xs text-slate-500">
                            {r.due_at ? formatDate(r.due_at, settings) : "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          );
        })}
      </div>
    </PageContainer>
  );
}
