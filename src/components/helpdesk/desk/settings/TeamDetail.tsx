"use client";

// Settings → Teams → one team (1.20.2): everything the Teams page's
// expanded card held, on a page of its own. The team's own fields (name,
// what it handles, icon, email alias) save through the page's Save row,
// with the leave guard; its people change at once, as before (the member
// list is PUT whole); office hours, reply targets, time tracking and status
// services keep their own controls; Delete sits in the danger zone with the
// same confirmation. Membership decides which queues an agent works; leads
// decide approvals that stand in for a missing manager and get the SLA
// warnings.

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Trash2, Users, X } from "lucide-react";
import { Button, iconButtonClass } from "@/components/Button";
import { Card } from "@/components/Card";
import { Chip } from "@/components/Chip";
import { EntityPicker } from "@/components/EntityPicker";
import { DangerAction, DangerZone, EmptyState, Field, SectionEmpty, Select, TextInput } from "@/components/form";
import { PageHeader } from "@/components/PageHeader";
import { PageContainer } from "@/components/PageWidth";
import { SaveRow } from "@/components/SaveRow";
import { LoadingRow } from "@/components/Spinner";
import { confirmDialog } from "@/components/Dialog";
import { toast } from "@/components/Toasts";
import { initialsOf } from "@/components/UserAvatar";
import { useLeaveGuard, useUnsavedChanges } from "@/lib/use-unsaved";
import type { HdTeamRole, HdTeamWithMembers } from "@/lib/helpdesk/types";
import { sendJson } from "../api";
import { useTeams } from "../admin-data";
import { useDeskCounts } from "../counts";
import { personOption, usePeople } from "../people";
import { TeamIcon } from "../TeamIcon";
import { TeamCalendarSelect } from "../calendars/TeamCalendarSelect";
import { TeamSlaTargets } from "../calendars/TeamSlaTargets";
import { TeamTimeToggle } from "../time/TeamTimeToggle";
import { TeamStatusSection } from "../team-status/TeamStatusServices";
import { cannedTeamDeleteNote } from "./canned-client";
import { TEAM_ICON_HELP } from "./TeamsSettings";

const TEAMS = "/desk/settings/teams";
const BACK = { href: TEAMS, label: "Teams" };

interface Draft {
  name: string;
  description: string;
  icon: string;
  email_alias: string;
}

const draftOf = (t: HdTeamWithMembers): Draft => ({ name: t.name, description: t.description, icon: t.icon, email_alias: t.email_alias });

export function TeamDetail({ id }: { id: number }) {
  const { teams, error, reload } = useTeams();
  const { refresh: refreshCounts } = useDeskCounts();
  const team = teams?.find((t) => t.id === id);

  if (error && !team) {
    return (
      <PageContainer>
        <PageHeader back={BACK} icon={<Users />} title="Team" />
        <p className="notice-error rounded-lg border px-3 py-2 text-sm">{error}</p>
      </PageContainer>
    );
  }
  if (teams === null) {
    return (
      <PageContainer>
        <PageHeader back={BACK} icon={<Users />} title="Team" />
        <LoadingRow className="py-10" />
      </PageContainer>
    );
  }
  if (!team) {
    return (
      <PageContainer>
        <PageHeader back={BACK} icon={<Users />} title="Team" />
        <EmptyState icon={<Users />} title="This team no longer exists" body="It may have been deleted. Its tickets keep their history." action={{ href: TEAMS, label: "All teams" }} />
      </PageContainer>
    );
  }
  return (
    <TeamPage
      key={team.id}
      team={team}
      onChanged={() => {
        reload();
        refreshCounts();
      }}
    />
  );
}

function TeamPage({ team, onChanged }: { team: HdTeamWithMembers; onChanged: () => void }) {
  const router = useRouter();
  const people = usePeople() ?? [];
  const [draft, setDraft] = useState<Draft>(() => draftOf(team));
  const [tried, setTried] = useState(false);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const snap = JSON.stringify(draft);
  const { dirty, markDirty, markClean, hasUnsavedChanges } = useUnsavedChanges(snap);
  useLeaveGuard(dirty, hasUnsavedChanges);

  // The saved team changed under a clean form (a reload after another control saved): follow it.
  const saved = JSON.stringify(draftOf(team));
  useEffect(() => {
    if (!hasUnsavedChanges()) setDraft(JSON.parse(saved) as Draft);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saved]);

  const set = (p: Partial<Draft>) => {
    markDirty();
    setDraft((d) => ({ ...d, ...p }));
  };
  const nameError = tried && !draft.name.trim() ? "A team needs a name." : undefined;
  const alias = draft.email_alias.trim();
  const aliasError = tried && alias && !/^[^\s@]+@[^\s@]+$/.test(alias) ? "That is not an email address." : undefined;

  async function save() {
    setTried(true);
    if (!draft.name.trim() || (alias && !/^[^\s@]+@[^\s@]+$/.test(alias))) return;
    setSaving(true);
    try {
      await sendJson(
        `/api/helpdesk/admin/teams/${team.id}`,
        "PATCH",
        { name: draft.name.trim(), description: draft.description.trim(), icon: draft.icon.trim(), email_alias: alias },
        "Couldn't save the team."
      );
      markClean(snap);
      toast("ok", "Team saved.");
      onChanged();
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const memberIds = new Set(team.members.map((m) => m.user_id));
  const current = team.members.map((m) => ({ user_id: m.user_id, role: m.role }));

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
      // The form's edits go with the team: nothing left to guard.
      markClean(snap);
      onChanged();
      router.push(TEAMS);
    } catch (e) {
      toast("error", (e as Error).message);
    }
  }

  return (
    <PageContainer>
      <PageHeader back={BACK} icon={<TeamIcon name={team.icon} />} title={team.name} subtitle={team.description || "Who answers for this team, and how it works."} />
      <div className="flex flex-col gap-4">
        <Card id="details" className="scroll-mt-6" title="Team">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name" error={nameError}>
              <TextInput value={draft.name} onChange={(e) => set({ name: e.target.value })} maxLength={60} />
            </Field>
            <Field label="Icon (optional)" help={TEAM_ICON_HELP}>
              <TextInput value={draft.icon} onChange={(e) => set({ icon: e.target.value })} maxLength={40} placeholder="wallet" autoCapitalize="none" spellCheck={false} />
            </Field>
            <Field label="What it handles (optional)" className="sm:col-span-2">
              <TextInput value={draft.description} onChange={(e) => set({ description: e.target.value })} maxLength={300} placeholder="Expenses, invoices and payroll questions" />
            </Field>
            <Field label="Email alias (optional)" help="Mail to this address lands in this team's queue." error={aliasError} className="sm:col-span-2" size="md">
              <TextInput type="email" value={draft.email_alias} onChange={(e) => set({ email_alias: e.target.value })} maxLength={200} autoComplete="off" />
            </Field>
          </div>
          {team.mailbox_address && (
            <p className="mt-3 text-xs text-slate-500">
              New mail to {team.mailbox_address} starts in this team, and its replies go out from that address (Settings → Email).
            </p>
          )}
        </Card>

        <Card id="people" className="scroll-mt-6" title="People" description="Members work this team's queue. Leads also assign work and review replies.">
          {team.members.length === 0 ? (
            <SectionEmpty className="mb-3">Nobody yet. Add the people who answer for {team.name}.</SectionEmpty>
          ) : (
            <ul className="mb-3 divide-y divide-slate-100 rounded-lg border border-slate-200">
              {team.members.map((m) => (
                <li key={m.user_id} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2">
                  <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-compass-100 text-2xs font-bold text-compass-700" aria-hidden>
                    {initialsOf(m.name || m.username)}
                  </span>
                  <span className="min-w-0 flex-1 basis-40">
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
            onPick={(pid) => {
              const p = people.find((x) => x.id === pid);
              void putMembers([...current, { user_id: pid, role: "agent" }], `${p?.name || p?.username || "They"} joined ${team.name}.`);
            }}
            label={`Add people to ${team.name}`}
            placeholder="Add people…"
            disabled={busy}
          />
        </Card>

        {/* Agent L: the team's office hours and its own reply targets; V8's time tracking; W6's status services. Each saves itself. */}
        <Card id="hours" className="scroll-mt-6" title="Hours and targets" description="These save as you change them.">
          <div className="grid gap-4 @container">
            <div className="max-w-md">
              <TeamCalendarSelect teamId={team.id} />
            </div>
            <details className="rounded-lg border border-slate-200 bg-surface text-left">
              <summary className="cursor-pointer px-3 py-2 text-sm font-semibold text-slate-800">Reply targets for {team.name}</summary>
              <div className="border-t border-slate-100 p-3">
                <TeamSlaTargets teamId={team.id} framed={false} />
              </div>
            </details>
            <TeamTimeToggle teamId={team.id} teamName={team.name} />
            <TeamStatusSection teamId={team.id} teamName={team.name} />
          </div>
        </Card>

        <DangerZone>
          <DangerAction label="Delete this team" description="Its people leave the team. Its tickets and request types keep their history but no longer belong to a team.">
            <Button variant="danger" icon={<Trash2 />} onClick={remove}>
              Delete team…
            </Button>
          </DangerAction>
        </DangerZone>
      </div>
      <SaveRow dirty={dirty} busy={saving} onSave={save} label="Save team" />
    </PageContainer>
  );
}
