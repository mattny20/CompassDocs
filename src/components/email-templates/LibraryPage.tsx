// A library tab's server half (1.19.0): loads one kind's parts with their
// usage, the tags the kind may use and the helpdesk teams (to name a team
// variant in "Used by"), then renders the client PartLibrary. Shared by
// Settings → Notifications → Email templates and the desk's entry point.

import { PartLibrary } from "./PartLibrary";
import { helpdeskTeams, loadLibrary } from "./load";
import { KIND_PLURAL, kindFromSegment, type EmailPartKind, type Surface } from "./types";

export function libraryTitle(segment: string): string {
  const kind = kindFromSegment(segment);
  return kind ? `Email ${KIND_PLURAL[kind].toLowerCase()}` : "Email templates";
}

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

export async function LibraryPage({
  surface,
  kind,
  canEdit,
  searchParams,
}: {
  surface: Surface;
  kind: EmailPartKind;
  canEdit: boolean;
  searchParams: Record<string, string | string[] | undefined>;
}) {
  const [data, teams] = await Promise.all([loadLibrary(surface, kind), helpdeskTeams()]);
  const partId = Number(one(searchParams.part)) || null;
  const from = one(searchParams.from);
  return (
    <PartLibrary
      surface={surface}
      kind={kind}
      parts={data.parts}
      events={data.events}
      teams={teams}
      tags={data.tags}
      tagsByEvent={data.tagsByEvent}
      canEdit={canEdit}
      initialPart={partId}
      initialNew={canEdit && one(searchParams.new) === "1"}
      initialEvent={one(searchParams.event) || null}
      from={from.startsWith(surface.base) ? from : null}
    />
  );
}
