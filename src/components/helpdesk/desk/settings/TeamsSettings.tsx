"use client";

// Settings → Teams (1.20.2: a list, then one page per team). The list names
// each team with its people, leads and open tickets, and anything worth
// seeing before opening it (no members yet, the help address mapped to it);
// a row is a link to the team's own page (TeamDetail), where everything the
// expanded card held now lives. "Add team" creates the team and opens its
// page. An old "#team-<id>" address opens that team's page.

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronRight, Plus, Users } from "lucide-react";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { Chip } from "@/components/Chip";
import { EmptyState, SectionEmpty } from "@/components/form";
import { ListFilter } from "@/components/ListFilter";
import { PageHeader } from "@/components/PageHeader";
import { PageContainer } from "@/components/PageWidth";
import { DeskNewStrip } from "./DeskNew";
import { LoadingRow } from "@/components/Spinner";
import { formDialog } from "@/components/Dialog";
import { toast } from "@/components/Toasts";
import type { HdTeamWithMembers } from "@/lib/helpdesk/types";
import { itemOf, sendJson } from "../api";
import { useTeams } from "../admin-data";
import { useDeskCounts } from "../counts";
import { TEAM_ICON_NAMES, TeamIcon } from "../TeamIcon";

export const TEAM_ICON_HELP = `A lucide icon name: ${TEAM_ICON_NAMES.slice(0, 8).join(", ")}…`;
/** The filter box appears once the list is longer than this. */
const FILTER_FROM = 8;

export const teamHref = (id: number) => `/desk/settings/teams/${id}`;

function people(n: number): string {
  return n === 1 ? "1 person" : `${n} people`;
}

/** "Lead: Ana Kowalski" / "Leads: Ana Kowalski, Sam Lee and 2 more" / "" when nobody leads. */
function leadsLine(team: HdTeamWithMembers): string {
  const leads = team.members.filter((m) => m.role === "lead").map((m) => m.name || m.username);
  if (!leads.length) return "";
  const shown = leads.slice(0, 2).join(", ");
  return `${leads.length === 1 ? "Lead" : "Leads"}: ${shown}${leads.length > 2 ? ` and ${leads.length - 2} more` : ""}`;
}

export function TeamsSettings() {
  const router = useRouter();
  const { teams, error, reload } = useTeams();
  const { refresh: refreshCounts } = useDeskCounts();
  const [q, setQ] = useState("");

  // "#team-12" (a link from before the team pages) opens that team's page.
  useEffect(() => {
    const m = /^#team-(\d+)$/.exec(window.location.hash);
    if (m) router.replace(teamHref(Number(m[1])));
  }, [router]);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!teams || !needle) return teams ?? [];
    return teams.filter((t) =>
      [t.name, t.description, t.email_alias, t.mailbox_address ?? "", ...t.members.map((m) => m.name || m.username)].some((v) => v.toLowerCase().includes(needle))
    );
  }, [teams, q]);

  async function create() {
    const v = await formDialog({
      title: "Add team",
      body: "A queue of its own: requests for this team land here, and its members work them. You add its people on the next page.",
      fields: [
        { key: "name", label: "Name", placeholder: "Finance", validate: (s) => (s.trim().length > 60 ? "Up to 60 characters." : undefined) },
        { key: "icon", label: "Icon (optional)", required: false, placeholder: "wallet", help: TEAM_ICON_HELP },
      ],
      confirmLabel: "Add team",
    });
    if (!v) return;
    try {
      const r = await sendJson("/api/helpdesk/admin/teams", "POST", { name: v.name.trim(), icon: v.icon.trim() }, "Couldn't create the team.");
      const team = itemOf<{ id: number }>(r, "team");
      toast("ok", `${v.name.trim()} created. Add its people next.`);
      refreshCounts();
      if (team?.id) router.push(teamHref(team.id));
      else reload();
    } catch (e) {
      toast("error", (e as Error).message);
    }
  }

  return (
    <PageContainer>
      <PageHeader
        icon={<Users />}
        title="Teams"
        subtitle="Who answers for what. Membership decides which queues an agent works."
        actions={
          <Button icon={<Plus />} onClick={create}>
            Add team
          </Button>
        }
      />
      {/* 1.19.2 (agent W5): the "New in <release>" strip until dismissed (DeskNew). */}
      <DeskNewStrip />
      {error && <p className="notice-error mb-4 rounded-lg border px-3 py-2 text-sm">{error}</p>}
      {teams === null && <LoadingRow className="py-10" />}
      {teams && teams.length === 0 && (
        <EmptyState
          icon={<Users />}
          title="No teams yet"
          body="Add a team for each group that answers requests, or use the starter set in Setup for IT, HR and Facilities."
          action={{ onClick: create, label: "Add team", icon: <Plus /> }}
        >
          <p className="mt-2 text-sm">
            <Link href="/desk/setup" className="link">
              Open Setup
            </Link>
          </p>
        </EmptyState>
      )}
      {teams && teams.length > 0 && (
        <Card padding="none">
          {teams.length > FILTER_FROM && (
            <div className="border-b border-slate-100 px-4 py-3">
              <ListFilter value={q} onChange={setQ} label="Filter teams" noun="teams" shown={shown.length} total={teams.length} />
            </div>
          )}
          {shown.length === 0 ? (
            <SectionEmpty className="px-4 py-6" action={{ label: "Clear the filter", onClick: () => setQ("") }}>
              No team matches &ldquo;{q.trim()}&rdquo;.
            </SectionEmpty>
          ) : (
            <ul role="list" className="divide-y divide-slate-100" data-testid="hd-teams">
              {shown.map((t) => (
                <TeamRow key={t.id} team={t} />
              ))}
            </ul>
          )}
        </Card>
      )}
      <p className="mt-4 text-sm text-slate-500">
        Members also need the Helpdesk agent role (Settings → Roles in CompassDocs) to open the desk.
      </p>
    </PageContainer>
  );
}

function TeamRow({ team }: { team: HdTeamWithMembers }) {
  const leads = leadsLine(team);
  const open = team.open_tickets ?? 0;
  return (
    <li data-testid="hd-team-row">
      <Link href={teamHref(team.id)} className="flex items-center gap-3 px-4 py-3 outline-offset-[-2px] transition hover:bg-slate-50">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-compass-50 text-compass-700" aria-hidden>
          <TeamIcon name={team.icon} className="h-4.5 w-4.5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="min-w-0 truncate text-sm font-semibold text-slate-900">{team.name}</span>
            {team.members.length === 0 && (
              <Chip tone="warn" size="sm">
                No members
              </Chip>
            )}
            {team.mailbox_address && (
              <Chip tone="neutral" size="sm">
                <span className="sr-only">Help address </span>
                {team.mailbox_address}
              </Chip>
            )}
          </span>
          <span className="mt-0.5 block truncate text-xs text-slate-500">
            {team.members.length > 0 && people(team.members.length)}
            {team.members.length > 0 && leads && " · "}
            {leads}
            {team.members.length > 0 && !leads && " · No lead"}
            {team.members.length === 0 && (team.description || "Add the people who answer for it.")}
          </span>
        </span>
        <span className="shrink-0 text-right text-xs text-slate-500">
          <span className="font-medium text-slate-700">{open}</span> open<span className="sr-only"> tickets</span>
        </span>
        <ChevronRight className="h-4 w-4 shrink-0 text-slate-400" aria-hidden />
      </Link>
    </li>
  );
}
