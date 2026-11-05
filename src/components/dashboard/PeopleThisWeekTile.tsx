// The dashboard's People this week tile (1.17.0, key "people"): new
// starters (a start date within a week either side of today), work
// anniversaries and birthdays this week (Monday to Sunday), from the
// directory's date fields flagged as a start date or a birthday — only the
// ones this viewer may see (lib/dashboard-people). Up to five rows, the day
// on the right. Hidden when nobody has anything this week.

import Link from "next/link";
import { Cake, PartyPopper, UserPlus } from "lucide-react";
import type { SessionUser } from "@/lib/types";
import { dayIn, getPeopleThisWeek, weekOf, ymdText, type PeopleEvent } from "@/lib/dashboard-people";
import { getAppSettings } from "@/lib/settings-store";
import { formatDayShort, settingsForUser } from "@/lib/format";
import { DashboardTile } from "./DashboardTile";
import { PersonAvatar } from "./PersonAvatar";

function what(e: PeopleEvent, company: string): string {
  switch (e.kind) {
    case "started":
      return `Joined ${e.person.department || company}`;
    case "starting":
      return `Joins ${e.person.department || company}`;
    case "anniversary":
      return `${e.years} ${e.years === 1 ? "year" : "years"} at ${company}`;
    case "birthday":
      return "Birthday";
  }
}

const ICON = { started: UserPlus, starting: UserPlus, anniversary: PartyPopper, birthday: Cake } as const;

export async function PeopleThisWeekTile({ user }: { user: SessionUser }) {
  const settings = settingsForUser(await getAppSettings(), user);
  const now = new Date();
  const events = await getPeopleThisWeek(user, settings.timezone, now);
  if (!events.length) return null;
  const today = ymdText(dayIn(now, settings.timezone));
  const week = new Set(weekOf(dayIn(now, settings.timezone)).map(ymdText));
  const dayLabel = (ymd: string) =>
    ymd === today
      ? "Today"
      : week.has(ymd)
        ? new Date(`${ymd}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" })
        : formatDayShort(ymd, settings);

  return (
    <DashboardTile
      id="people"
      title="People this week"
      footer={
        <Link href="/directory" className="font-medium text-compass-700 hover:underline">
          Open the directory
        </Link>
      }
    >
      <ul className="pb-1">
        {events.map((e) => {
          const Icon = ICON[e.kind];
          return (
            <li key={`${e.person.id}-${e.kind}-${e.date}`}>
              <Link
                href={`/directory/${e.person.id}`}
                className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 hover:bg-slate-50"
              >
                <PersonAvatar person={e.person} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold text-slate-800">{e.person.name}</span>
                  <span className="block truncate text-xs text-slate-500">{what(e, settings.company_name)}</span>
                </span>
                <span
                  className={`flex shrink-0 items-center gap-1 text-xs ${e.date === today ? "font-semibold text-compass-700" : "text-slate-500"}`}
                >
                  <Icon className="h-3.5 w-3.5 text-slate-400" aria-hidden />
                  {dayLabel(e.date)}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </DashboardTile>
  );
}
