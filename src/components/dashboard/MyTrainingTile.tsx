// The dashboard's My training tile (1.17.0, key "training"): the viewer's
// open training assignments — what /training lists and they have not
// finished — overdue first, then the soonest deadline, each with its
// progress through the deck. "N of M due" counts the open ones against
// every current assignment. Only with the Training entitlement; hidden when
// nothing is open.

import Link from "next/link";
import type { SessionUser } from "@/lib/types";
import { dayIn, getMyOpenTraining, ymdText } from "@/lib/dashboard-people";
import { getAppSettings } from "@/lib/settings-store";
import { formatDayShort, settingsForUser } from "@/lib/format";
import { DashboardTile } from "./DashboardTile";

export async function MyTrainingTile({ user }: { user: SessionUser }) {
  const data = await getMyOpenTraining(user);
  if (!data) return null;
  const settings = settingsForUser(await getAppSettings(), user);
  // A deadline is an instant; the day it names is the viewer's.
  const dueDay = (iso: string) => formatDayShort(ymdText(dayIn(new Date(iso), settings.timezone)), settings);

  return (
    <DashboardTile
      id="training"
      title="My training"
      actions={
        <span className="text-xs text-slate-500">
          {data.openCount} of {data.total} due
        </span>
      }
      footer={
        <Link href="/training" className="font-medium text-compass-700 hover:underline">
          Go to Training
        </Link>
      }
    >
      <ul className="pb-1">
        {data.open.map((t) => (
          <li key={t.assignment_id} className="px-2 py-1.5">
            <div className="flex items-baseline justify-between gap-2">
              <Link
                href={`/training/take/${t.assignment_id}`}
                className="min-w-0 truncate text-sm font-semibold text-slate-800 hover:text-compass-700"
              >
                {t.title}
              </Link>
              {t.overdue ? (
                <span className="shrink-0 text-xs font-semibold text-red-600">Overdue</span>
              ) : t.due_at ? (
                <span className="shrink-0 text-xs text-slate-500">Due {dueDay(t.due_at)}</span>
              ) : null}
            </div>
            {t.pct !== null && (
              <>
                <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-slate-100" aria-hidden>
                  <div
                    className={`h-full rounded-full ${t.overdue ? "bg-red-500" : "bg-compass-600"}`}
                    style={{ width: `${t.pct}%` }}
                  />
                </div>
                <div className="mt-1 text-2xs text-slate-500">{t.pct}% complete</div>
              </>
            )}
          </li>
        ))}
      </ul>
    </DashboardTile>
  );
}
