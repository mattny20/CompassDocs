// The composer's server half (1.19.0): loads one event's compositions,
// parts and helpdesk teams and hands them to the client Composer. Shared by
// Settings → Notifications → Email templates and the desk's entry point.

import { notFound } from "next/navigation";
import { BackLink } from "@/components/BackLink";
import { Composer } from "./Composer";
import { loadComposer } from "./load";
import { SCOPE_ALL, type Surface } from "./types";

export async function ComposerPage({
  surface,
  eventKey,
  scope,
  canCompose,
  canEditParts,
}: {
  surface: Surface;
  eventKey: string;
  scope: string;
  canCompose: boolean;
  canEditParts: boolean;
}) {
  const data = await loadComposer(eventKey);
  if (!data || (surface.mode === "desk" && !data.event.teamScopes)) notFound();
  return (
    <>
      <BackLink href={surface.base} label="Email templates" />
      <Composer
        surface={surface}
        event={data.event}
        compositions={data.compositions}
        parts={data.parts}
        teams={data.teams}
        initialScope={scope || SCOPE_ALL}
        canCompose={canCompose}
        canEditParts={canEditParts}
      />
    </>
  );
}
