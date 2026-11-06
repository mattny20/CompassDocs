"use client";

// Settings → Teams: the helpdesk's teams (IT, HR, Facilities…) and who
// answers for each. Membership decides which queues an agent works; leads
// decide approvals that stand in for a missing manager and get the SLA
// warnings. One card per team: its members with their role (Agent / Lead),
// Add people, and the team's own Edit… and Delete… actions. Changes save
// at once (the member list is PUT whole) and toast.

import { useState } from "react";
import { Pencil, Plus, Trash2, Users, X } from "lucide-react";
import { Button, iconButtonClass } from "@/components/Button";
import { Card } from "@/components/Card";
import { Chip } from "@/components/Chip";
import { EntityPicker } from "@/components/EntityPicker";
import { EmptyState, Select, SectionEmpty } from "@/components/form";
import { PageHeader } from "@/components/PageHeader";
import { PageContainer } from "@/components/PageWidth";
import { DeskNewStrip } from "./DeskNew";
import { LoadingRow } from "@/components/Spinner";
import { confirmDialog, formDialog } from "@/components/Dialog";
import { toast } from "@/components/Toasts";
import { initialsOf } from "@/components/UserAvatar";
import type { HdTeamRole, HdTeamWithMembers } from "@/lib/helpdesk/types";
import { sendJson } from "../api";
import { useTeams } from "../admin-data";
import { useDeskCounts } from "../counts";
import { personOption, usePeople } from "../people";
import { TEAM_ICON_NAMES, TeamIcon } from "../TeamIcon";
import { TeamCalendarSelect } from "../calendars/TeamCalendarSelect";
import { TeamSlaTargets } from "../calendars/TeamSlaTargets";
import { TeamTimeToggle } from "../time/TeamTimeToggle";
import { TeamStatusSection } from "../team-status/TeamStatusServices";
import { cannedTeamDeleteNote } from "./canned-client";

const ICON_HELP = `A lucide icon name: ${TEAM_ICON_NAMES.slice(0, 8).join(", ")}…`;

export function TeamsSettings() {
  const { teams, error, reload } = useTeams();
  const people = usePeople();
  const { refresh: refreshCounts } = useDeskCounts();

  const after = () => {
    reload();
    refreshCounts();
  };

  async function create() {
    const v = await formDialog({
      title: "New team",
      body: "A queue of its own: requests for this team land here, and its members work them.",
      fields: [
        { key: "name", label: "Name", placeholder: "Finance", validate: (s) => (s.trim().length > 60 ? "Up to 60 characters." : undefined) },
        { key: "description", label: "What it handles (optional)", required: false, placeholder: "Expenses, invoices and payroll questions" },
        { key: "icon", label: "Icon (optional)", required: false, placeholder: "wallet", help: ICON_HELP },
      ],
      confirmLabel: "Create team",
    });
    if (!v) return;
    try {
      await sendJson("/api/helpdesk/admin/teams", "POST", { name: v.name.trim(), description: v.description.trim(), icon: v.icon.trim() }, "Couldn't create the team.");
      toast("ok", `${v.name.trim()} created. Add its people next.`);
      after();
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
            New team
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
          body="Create a team for each group that answers requests, or use the starter set in Setup for IT, HR and Facilities."
          action={{ href: "/desk/setup", label: "Open Setup" }}
        />
      )}
      <div className="flex flex-col gap-4">
        {teams?.map((t) => (
          <TeamCard key={t.id} team={t} people={people ?? []} onChanged={after} />
        ))}
      </div>
      <p className="mt-4 text-sm text-slate-500">
        Members also need the Helpdesk agent role (Settings → Roles in CompassDocs) to open the desk.
      </p>
    </PageContainer>
  );
}

function TeamCard({ team, people, onChanged }: { team: HdTeamWithMembers; people: { id: number; name: string; username: string }[]; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const memberIds = new Set(team.members.map((m) => m.user_id));

  async function putMembers(members: { user_id: number; role: HdTeamRole }[], ok: string) {
    setBusy(true);
    try {
      await sendJson(`/api/helpdesk/admin/teams/${team.id}/members`, "PUT", { members }, "Couldn't change the team's people.");
      toast("ok", ok);
      onChanged();
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const current = team.members.map((m) => ({ user_id: m.user_id, role: m.role }));

  async function edit() {
    const v = await formDialog({
      title: `Edit ${team.name}`,
      fields: [
        { key: "name", label: "Name", initial: team.name },
        { key: "description", label: "What it handles (optional)", initial: team.description, required: false },
        { key: "icon", label: "Icon (optional)", initial: team.icon, required: false, help: ICON_HELP },
        { key: "email_alias", label: "Email alias (optional)", initial: team.email_alias, required: false, type: "email", help: "Mail to this address lands in this team's queue." },
      ],
      confirmLabel: "Save team",
    });
    if (!v) return;
    try {
      await sendJson(
        `/api/helpdesk/admin/teams/${team.id}`,
        "PATCH",
        { name: v.name.trim(), description: v.description.trim(), icon: v.icon.trim(), email_alias: v.email_alias.trim() },
        "Couldn't save the team."
      );
      toast("ok", "Team saved.");
      onChanged();
    } catch (e) {
      toast("error", (e as Error).message);
    }
  }

  async function remove() {
    // Its canned responses go with it (1.19.2, agent W4): the dialog says how many.
    const cannedNote = await cannedTeamDeleteNote(team.id);
    const ok = await confirmDialog({
      title: `Delete ${team.name}?`,
      body: `Its people leave the team. Its tickets and request types keep their history but no longer belong to a team.${cannedNote} This cannot be undone.`,
      confirmLabel: "Delete team",
      danger: true,
    });
    if (ok !== true) return;
    try {
      await sendJson(`/api/helpdesk/admin/teams/${team.id}`, "DELETE", undefined, "Couldn't delete the team.");
      toast("ok", `${team.name} deleted.`);
      onChanged();
    } catch (e) {
      toast("error", (e as Error).message);
    }
  }

  return (
    <Card
      padding="p-5"
      icon={<TeamIcon name={team.icon} />}
      title={team.name}
      description={team.description || undefined}
      actions={
        <>
          <button type="button" onClick={edit} aria-label={`Edit ${team.name}`} data-tt="Edit" className={iconButtonClass("bordered", "sm")}>
            <Pencil aria-hidden />
          </button>
          <button type="button" onClick={remove} aria-label={`Delete ${team.name}`} data-tt="Delete" className={iconButtonClass("bordered", "sm", "hover-danger")}>
            <Trash2 aria-hidden />
          </button>
        </>
      }
    >
      {team.email_alias && <p className="-mt-1 mb-3 text-xs text-slate-500">Email alias: {team.email_alias}</p>}
      {/* Agent L: the team's office hours and its own reply targets. */}
      <div className="mb-4 grid gap-4 @container">
        <div className="max-w-md">
          <TeamCalendarSelect teamId={team.id} />
        </div>
        <details className="rounded-lg border border-slate-200 bg-surface text-left">
          <summary className="cursor-pointer px-3 py-2 text-sm font-semibold text-slate-800">Reply targets for {team.name}</summary>
          <div className="border-t border-slate-100 p-3">
            <TeamSlaTargets teamId={team.id} framed={false} />
          </div>
        </details>
        {/* Time tracking: ask for time on solve (1.19.1, agent V8). */}
        <TeamTimeToggle teamId={team.id} teamName={team.name} />
        {/* Status page services the team follows (1.19.2, agent W6). */}
        <TeamStatusSection teamId={team.id} teamName={team.name} />
      </div>
      {team.members.length === 0 ? (
        <SectionEmpty className="mb-3">Nobody yet. Add the people who answer for {team.name}.</SectionEmpty>
      ) : (
        <ul className="mb-3 divide-y divide-slate-100 rounded-lg border border-slate-200">
          {team.members.map((m) => (
            <li key={m.user_id} className="flex items-center gap-3 px-3 py-2">
              <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-compass-100 text-2xs font-bold text-compass-700" aria-hidden>
                {initialsOf(m.name || m.username)}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-slate-800">{m.name || m.username}</span>
                {m.email && <span className="block truncate text-xs text-slate-500">{m.email}</span>}
              </span>
              {m.availability && m.availability !== "available" && <Chip tone="neutral" size="sm">{m.availability === "away" ? "Away" : "Offline"}</Chip>}
              <Select
                dense
                className="w-auto"
                aria-label={`Role of ${m.name || m.username} in ${team.name}`}
                value={m.role}
                disabled={busy}
                onChange={(e) =>
                  putMembers(
                    current.map((x) => (x.user_id === m.user_id ? { ...x, role: e.target.value as HdTeamRole } : x)),
                    `${m.name || m.username} is now ${e.target.value === "lead" ? "a lead" : "an agent"}.`
                  )
                }
              >
                <option value="agent">Agent</option>
                <option value="lead">Lead</option>
              </Select>
              <button
                type="button"
                disabled={busy}
                onClick={() => putMembers(current.filter((x) => x.user_id !== m.user_id), `${m.name || m.username} left ${team.name}.`)}
                aria-label={`Remove ${m.name || m.username} from ${team.name}`}
                data-tt="Remove"
                className={iconButtonClass("quiet", "sm")}
              >
                <X aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}
      <EntityPicker
        options={people.filter((p) => !memberIds.has(p.id)).map(personOption)}
        onPick={(id) => {
          const p = people.find((x) => x.id === id);
          void putMembers([...current, { user_id: id, role: "agent" }], `${p?.name || p?.username || "They"} joined ${team.name}.`);
        }}
        label={`Add people to ${team.name}`}
        placeholder="Add people…"
        disabled={busy}
      />
    </Card>
  );
}
