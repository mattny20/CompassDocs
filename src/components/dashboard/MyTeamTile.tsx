// The dashboard's My team tile (1.17.0, key "my_team"): from the directory,
// who the viewer reports to, the colleagues who share that manager, and the
// viewer's own direct reports — each a link to the person's profile. Teams
// presence (Enterprise) adds a dot or a "● Busy" label when the workspace
// has it on; otherwise there is none. Hidden when the account has no
// directory entry or the entry has nobody above, beside or below it.

import Link from "next/link";
import type { SessionUser } from "@/lib/types";
import { getMyTeam, type DashPerson } from "@/lib/dashboard-people";
import { nameParts } from "@/lib/directory-display";
import { DashboardTile, TileLabel } from "./DashboardTile";
import { PersonAvatar } from "./PersonAvatar";
import { TeamPresence, TeamPresenceDot, TeamPresenceLabel } from "./TeamPresence";

/** Avatars in the team strip before "+N". */
const TEAM_AVATARS = 6;
/** Direct-report rows before "and N more". */
const REPORT_ROWS = 5;

function PersonRow({ person, presence }: { person: DashPerson; presence: boolean }) {
  return (
    <Link
      href={`/directory/${person.id}`}
      className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 hover:bg-slate-50"
    >
      <PersonAvatar person={person} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold text-slate-800">{person.name}</span>
        {person.title && <span className="block truncate text-xs text-slate-500">{person.title}</span>}
      </span>
      {presence && person.graph && <TeamPresenceLabel personId={person.id} />}
    </Link>
  );
}

export async function MyTeamTile({ user }: { user: SessionUser }) {
  const data = await getMyTeam(user);
  if (!data) return null;
  const { manager, team, reports, presence } = data;
  const shownTeam = team.slice(0, TEAM_AVATARS);
  const moreTeam = team.length - shownTeam.length;
  const shownReports = reports.slice(0, REPORT_ROWS);
  const moreReports = reports.length - shownReports.length;
  // The org chart, opened on the viewer's manager (the whole team) or on
  // the viewer (every report).
  const orgHref = (id: number) => `/directory?view=org&focus=${id}`;

  const body = (
    <div className="pb-1">
      {manager && (
        <>
          <TileLabel>You report to</TileLabel>
          <PersonRow person={manager} presence={presence} />
        </>
      )}
      {team.length > 0 && (
        <>
          <TileLabel>Your team · {team.length}</TileLabel>
          <div className="flex flex-wrap items-center gap-1.5 px-2 pb-0.5 pt-1">
            {shownTeam.map((p) => (
              <Link
                key={p.id}
                href={`/directory/${p.id}`}
                aria-label={p.name}
                data-tt={p.name}
                className="relative block rounded-full"
              >
                <PersonAvatar person={p} size="lg" />
                {presence && p.graph && <TeamPresenceDot personId={p.id} />}
              </Link>
            ))}
            {moreTeam > 0 && manager && (
              <Link
                href={orgHref(manager.id)}
                aria-label={`${moreTeam} more on your team`}
                data-tt="See everyone in the org chart"
                className="grid h-8.5 min-w-8.5 place-items-center rounded-full bg-slate-100 px-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-200"
              >
                +{moreTeam}
              </Link>
            )}
            {team.length <= 4 && (
              <span className="ml-1.5 min-w-0 flex-1 text-xs text-slate-500">
                {team.map((p) => nameParts(p.name).first || p.name).join(", ")}
              </span>
            )}
          </div>
        </>
      )}
      {reports.length > 0 && (
        <>
          <TileLabel>Your direct reports · {reports.length}</TileLabel>
          {shownReports.map((p) => (
            <PersonRow key={p.id} person={p} presence={presence} />
          ))}
          {moreReports > 0 && (
            <Link href={orgHref(data.me)} className="mx-2 mt-1 block text-xs text-slate-500 hover:text-slate-700">
              and {moreReports} more
            </Link>
          )}
        </>
      )}
    </div>
  );

  const graphIds = [manager, ...team, ...reports].filter((p): p is DashPerson => !!p && p.graph).map((p) => p.id);
  return (
    <DashboardTile
      id="my_team"
      title="My team"
      actions={
        <Link href="/directory" className="text-slate-500 hover:text-slate-700">
          Directory →
        </Link>
      }
    >
      {presence && graphIds.length ? <TeamPresence ids={graphIds}>{body}</TeamPresence> : body}
    </DashboardTile>
  );
}
