"use client";

// Settings → Agents (agent J): the one place a person's desk level is
// set. A table of everyone on the desk (person, role, teams with "Lead of",
// availability), filtered by name, role and team, with counts per role.
// Managers and Admins change roles (up to the roles below their own) and
// teams; Team leads add, move between Newbie and Agent, and remove people
// in their own teams. Rows the viewer can't change show the role as a chip.
// Changes save at once and toast (STYLEGUIDE §Settings pages).

import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { Pencil, Plus, UserMinus, UsersRound, X } from "lucide-react";
import { Button, iconButtonClass } from "@/components/Button";
import { Card } from "@/components/Card";
import { Chip } from "@/components/Chip";
import { EntityPicker } from "@/components/EntityPicker";
import { EmptyState, Field, FormError, Select, SectionEmpty } from "@/components/form";
import { ListFilter } from "@/components/ListFilter";
import { Modal } from "@/components/Modal";
import { PageHeader } from "@/components/PageHeader";
import { PageContainer } from "@/components/PageWidth";
import { LoadingRow } from "@/components/Spinner";
import { Table, Td, Th, TR, TABLE_HEAD_ROW } from "@/components/Table";
import { confirmDialog } from "@/components/Dialog";
import { toast } from "@/components/Toasts";
import { UserAvatar } from "@/components/UserAvatar";
import { HD_ROLES, HD_ROLE_DESCRIPTION, HD_ROLE_LABEL, type HdCapsView, type HdDeskAgent, type HdRole } from "@/lib/helpdesk/roles-shared";
import { getJson, sendJson } from "../api";
import { personOption, usePeople } from "../people";
import { RoleChip } from "./role-ui";

interface AgentRow extends HdDeskAgent {
  manageable: boolean;
}
interface TeamLite {
  id: number;
  name: string;
}
interface AgentsData {
  agents: AgentRow[];
  teams: TeamLite[];
  me: HdCapsView;
  counts: Record<HdRole, number>;
}

const AVAILABILITY: Record<HdDeskAgent["availability"], { label: string; tone: "ok" | "warn" | "neutral" }> = {
  available: { label: "Available", tone: "ok" },
  away: { label: "Away", tone: "warn" },
  offline: { label: "Offline", tone: "neutral" },
};

function plural(n: number, role: HdRole): string {
  const label = HD_ROLE_LABEL[role];
  return `${n} ${n === 1 ? label : `${label}s`}`;
}

export function AgentsSettings() {
  const [data, setData] = useState<AgentsData | null>(null);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [roleFilter, setRoleFilter] = useState<"" | HdRole>("");
  const [teamFilter, setTeamFilter] = useState("");
  const [busyId, setBusyId] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);
  const [editingTeams, setEditingTeams] = useState<AgentRow | null>(null);

  const reload = useCallback(() => {
    getJson<AgentsData>("/api/helpdesk/admin/agents", "Couldn't load the agents.")
      .then((d) => {
        setData(d);
        setError("");
      })
      .catch((e: Error) => setError(e.message));
  }, []);
  useEffect(() => reload(), [reload]);

  const teamName = useMemo(() => new Map((data?.teams ?? []).map((t) => [t.id, t.name])), [data]);
  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (data?.agents ?? []).filter(
      (a) =>
        (!roleFilter || a.role === roleFilter) &&
        (!teamFilter || a.team_ids.includes(Number(teamFilter))) &&
        (!q || `${a.name} ${a.email} ${a.username}`.toLowerCase().includes(q))
    );
  }, [data, query, roleFilter, teamFilter]);

  const me = data?.me;
  const canAdd = Boolean(me && me.assignable_roles.length);

  async function changeRole(a: AgentRow, role: HdRole) {
    setBusyId(a.user_id);
    try {
      await sendJson(`/api/helpdesk/admin/agents/${a.user_id}`, "PATCH", { role }, "Couldn't change the role.");
      toast("ok", `${a.name} is now ${HD_ROLE_LABEL[role]}.`);
      reload();
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  async function remove(a: AgentRow) {
    const lead = me && !me.caps.includes("agents.assign_roles");
    const ok = await confirmDialog({
      title: `Remove ${a.name} from the desk?`,
      body: lead
        ? "They leave your teams' queues. Their tickets stay assigned to them until someone reassigns them."
        : "They lose their desk role and leave every team. Their tickets stay assigned to them until someone reassigns them.",
      confirmLabel: "Remove from desk",
      danger: true,
    });
    if (ok !== true) return;
    setBusyId(a.user_id);
    try {
      const r = await sendJson<{ still_on_desk?: HdDeskAgent }>(`/api/helpdesk/admin/agents/${a.user_id}`, "DELETE", undefined, "Couldn't remove them.");
      toast(
        "ok",
        r.still_on_desk
          ? `${a.name} left. They keep desk access through their workspace role (Work helpdesk tickets).`
          : `${a.name} is no longer on the desk.`
      );
      reload();
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  const summary = data
    ? HD_ROLES.filter((r) => data.counts[r] > 0)
        .map((r) => plural(data.counts[r], r))
        .join(" · ")
    : "";

  return (
    <PageContainer>
      <PageHeader
        icon={<UsersRound />}
        title="Agents"
        subtitle="Who works the desk, at which level, in which teams."
        actions={
          canAdd ? (
            <Button icon={<Plus />} onClick={() => setAdding(true)}>
              Add agent
            </Button>
          ) : undefined
        }
      />
      {error && <p className="notice-error mb-4 rounded-lg border px-3 py-2 text-sm">{error}</p>}
      {data === null && !error && <LoadingRow className="py-10" />}
      {data && data.agents.length === 0 && (
        <EmptyState
          icon={<UsersRound />}
          title="Nobody works the desk yet"
          body="Add the people who answer requests and give each a level: a Newbie's replies wait for a team lead's review, an Agent replies directly."
          action={canAdd ? { onClick: () => setAdding(true), label: "Add agent" } : undefined}
        />
      )}
      {data && data.agents.length > 0 && (
        <Card padding="none">
          <div className="flex flex-wrap items-center gap-3 border-b border-slate-100 px-4 py-3">
            <ListFilter value={query} onChange={setQuery} label="Filter agents" placeholder="Filter by name…" shown={rows.length} total={data.agents.length} noun="agents" />
            <Select dense className="w-auto" aria-label="Filter by role" value={roleFilter} onChange={(e) => setRoleFilter(e.target.value as "" | HdRole)}>
              <option value="">All roles</option>
              {HD_ROLES.map((r) => (
                <option key={r} value={r}>
                  {HD_ROLE_LABEL[r]} ({data.counts[r] ?? 0})
                </option>
              ))}
            </Select>
            <Select dense className="w-auto" aria-label="Filter by team" value={teamFilter} onChange={(e) => setTeamFilter(e.target.value)}>
              <option value="">All teams</option>
              {data.teams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </Select>
            <p className="text-xs text-slate-500 sm:ml-auto">{summary}</p>
          </div>
          {rows.length === 0 ? (
            <SectionEmpty className="px-4 py-6">Nobody matches. Clear the filters to see everyone.</SectionEmpty>
          ) : (
            <Table scroll minWidth="46rem">
              <thead className={TABLE_HEAD_ROW}>
                <tr>
                  <Th>Person</Th>
                  <Th fit>Role</Th>
                  <Th>Teams</Th>
                  <Th fit>Availability</Th>
                  <Th fit className="relative">
                    {/* relative: the sr-only label stays inside the table's scroll box on a phone */}
                    <span className="sr-only">Actions</span>
                  </Th>
                </tr>
              </thead>
              <tbody>
                {rows.map((a) => {
                  const options = me ? HD_ROLES.filter((r) => me.assignable_roles.includes(r) || r === a.role) : [a.role];
                  const leads = a.lead_team_ids.map((t) => teamName.get(t)).filter(Boolean) as string[];
                  const avail = AVAILABILITY[a.availability] ?? AVAILABILITY.available;
                  return (
                    <tr key={a.user_id} className={TR}>
                      <Td>
                        <span className="flex min-w-0 items-center gap-3">
                          <UserAvatar name={a.name} size="sm" />
                          <span className="min-w-0">
                            <span className="block truncate font-medium text-slate-800">{a.name}</span>
                            {a.email && <span className="block truncate text-xs text-slate-500">{a.email}</span>}
                          </span>
                        </span>
                      </Td>
                      <Td fit>
                        {a.manageable && !a.locked ? (
                          <Select
                            dense
                            className="w-auto"
                            aria-label={`Desk role of ${a.name}`}
                            value={a.role}
                            disabled={busyId === a.user_id}
                            onChange={(e) => changeRole(a, e.target.value as HdRole)}
                          >
                            {options.map((r) => (
                              <option key={r} value={r}>
                                {HD_ROLE_LABEL[r]}
                              </option>
                            ))}
                          </Select>
                        ) : (
                          <RoleChip role={a.role} fromWorkspace={a.locked} />
                        )}
                      </Td>
                      <Td>
                        {a.team_ids.length === 0 ? (
                          <span className="text-xs text-slate-500">{a.role === "manager" || a.role === "admin" ? "Every team" : "No team yet"}</span>
                        ) : (
                          <span className="flex flex-wrap gap-1">
                            {a.team_ids.map((t) => (
                              <Chip key={t} tone="neutral" size="sm">
                                {teamName.get(t) ?? `Team ${t}`}
                              </Chip>
                            ))}
                          </span>
                        )}
                        {leads.length > 0 && <span className="mt-1 block text-xs text-slate-500">Lead of {leads.join(", ")}</span>}
                      </Td>
                      <Td fit>
                        <Chip tone={avail.tone} size="sm">
                          {avail.label}
                        </Chip>
                      </Td>
                      <Td fit>
                        {a.manageable && (
                          <span className="flex items-center gap-1">
                            <button
                              type="button"
                              onClick={() => setEditingTeams(a)}
                              disabled={busyId === a.user_id}
                              aria-label={`Change ${a.name}'s teams`}
                              data-tt="Teams"
                              className={iconButtonClass("quiet", "sm")}
                            >
                              <Pencil aria-hidden />
                            </button>
                            <button
                              type="button"
                              onClick={() => remove(a)}
                              disabled={busyId === a.user_id}
                              aria-label={`Remove ${a.name} from the desk`}
                              data-tt="Remove"
                              className={iconButtonClass("quiet", "sm", "hover-danger")}
                            >
                              <UserMinus aria-hidden />
                            </button>
                          </span>
                        )}
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          )}
        </Card>
      )}
      {me && (
        <p className="mt-4 text-sm text-slate-500">
          {me.caps.includes("agents.assign_roles")
            ? me.role === "admin"
              ? "You can give any role."
              : `You can give roles up to ${HD_ROLE_LABEL[me.assignable_roles.at(-1) ?? "agent"]}.`
            : "You can add Newbies and Agents to your teams, move them between the two, and remove them from your teams."}{" "}
          What each role can do is on the Roles page.
        </p>
      )}
      {data && me && (
        <AddAgentModal
          open={adding}
          onClose={() => setAdding(false)}
          me={me}
          teams={data.teams}
          onDesk={new Set(data.agents.filter((a) => a.source !== "derived").map((a) => a.user_id))}
          onAdded={() => {
            setAdding(false);
            reload();
          }}
        />
      )}
      {data && me && editingTeams && (
        <TeamsModal
          agent={editingTeams}
          me={me}
          teams={data.teams}
          onClose={() => setEditingTeams(null)}
          onSaved={() => {
            setEditingTeams(null);
            reload();
          }}
        />
      )}
    </PageContainer>
  );
}

/** The teams a viewer may tick: every team for Managers/Admins, their own for a Team lead. */
function allowedTeams(me: HdCapsView, teams: TeamLite[]): TeamLite[] {
  if (me.caps.includes("agents.assign_roles") || me.caps.includes("teams.manage")) return teams;
  return teams.filter((t) => me.team_ids.includes(t.id));
}

function TeamChecks({ teams, value, onChange, legend }: { teams: TeamLite[]; value: number[]; onChange: (ids: number[]) => void; legend: string }) {
  return (
    <fieldset>
      <legend className="mb-1 text-xs font-medium text-slate-500">{legend}</legend>
      {teams.length === 0 ? (
        <SectionEmpty>No teams yet. Create them on the Teams page first.</SectionEmpty>
      ) : (
        <div className="grid gap-1 sm:grid-cols-2">
          {teams.map((t) => (
            <label key={t.id} className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-slate-800 hover:bg-slate-50">
              <input
                type="checkbox"
                checked={value.includes(t.id)}
                onChange={(e) => onChange(e.target.checked ? [...value, t.id] : value.filter((x) => x !== t.id))}
              />
              {t.name}
            </label>
          ))}
        </div>
      )}
    </fieldset>
  );
}

function AddAgentModal({
  open,
  onClose,
  me,
  teams,
  onDesk,
  onAdded,
}: {
  open: boolean;
  onClose: () => void;
  me: HdCapsView;
  teams: TeamLite[];
  onDesk: Set<number>;
  onAdded: () => void;
}) {
  const titleId = useId();
  const people = usePeople();
  const [who, setWho] = useState<number | null>(null);
  const [role, setRole] = useState<HdRole>("newbie");
  const [teamIds, setTeamIds] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const allowed = allowedTeams(me, teams);
  const lead = !me.caps.includes("agents.assign_roles");

  useEffect(() => {
    if (!open) return;
    setWho(null);
    setRole(me.assignable_roles.includes("newbie") ? "newbie" : me.assignable_roles[0] ?? "newbie");
    setTeamIds(lead && allowed.length === 1 ? [allowed[0].id] : []);
    setError("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const person = people?.find((p) => p.id === who);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!who) return setError("Choose who to add.");
    if (lead && !teamIds.length) return setError("Choose at least one of your teams.");
    setBusy(true);
    setError("");
    try {
      await sendJson("/api/helpdesk/admin/agents", "POST", { user_id: who, role, team_ids: teamIds }, "Couldn't add them.");
      toast("ok", `${person?.name || person?.username || "They"} joined the desk as ${HD_ROLE_LABEL[role]}.`);
      onAdded();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} labelledBy={titleId} className="max-h-[calc(100dvh-2rem)] w-full max-w-lg overflow-y-auto rounded-xl border border-slate-200 bg-surface p-5 shadow-modal">
      <form onSubmit={submit} noValidate>
        <div className="flex items-start justify-between gap-3">
          <h2 id={titleId} className="text-base font-semibold text-slate-900">
            Add agent
          </h2>
          <button type="button" onClick={onClose} aria-label="Close" data-tt="Close" className={iconButtonClass("quiet", "sm", "-mr-1 -mt-1")}>
            <X aria-hidden />
          </button>
        </div>
        <p className="mt-1 text-sm text-slate-600">Put someone on the desk at a level, in the teams whose queues they work.</p>
        <div className="mt-4 space-y-4">
          <div>
            <p className="mb-1 text-xs font-medium text-slate-500">Person</p>
            {person ? (
              <div className="flex items-center justify-between gap-2 rounded-lg border border-slate-200 px-3 py-2 text-sm">
                <span className="truncate font-medium text-slate-800">{person.name || person.username}</span>
                <button type="button" className="link text-xs" onClick={() => setWho(null)}>
                  Change
                </button>
              </div>
            ) : (
              <EntityPicker
                options={(people ?? []).filter((p) => !onDesk.has(p.id)).map(personOption)}
                onPick={(id) => setWho(id)}
                label="Person"
                placeholder="Search people…"
              />
            )}
          </div>
          <Field label="Role" help={HD_ROLE_DESCRIPTION[role]}>
            <Select value={role} onChange={(e) => setRole(e.target.value as HdRole)}>
              {me.assignable_roles.map((r) => (
                <option key={r} value={r}>
                  {HD_ROLE_LABEL[r]}
                </option>
              ))}
            </Select>
          </Field>
          <TeamChecks teams={allowed} value={teamIds} onChange={setTeamIds} legend={lead ? "Your teams" : "Teams (optional for Managers and Admins)"} />
          {error && <FormError>{error}</FormError>}
        </div>
        <div className="mt-5 flex flex-wrap items-center gap-2">
          <Button type="submit" busy={busy} icon={<Plus />}>
            Add to desk
          </Button>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function TeamsModal({ agent, me, teams, onClose, onSaved }: { agent: AgentRow; me: HdCapsView; teams: TeamLite[]; onClose: () => void; onSaved: () => void }) {
  const titleId = useId();
  const allowed = allowedTeams(me, teams);
  const [teamIds, setTeamIds] = useState<number[]>(agent.team_ids.filter((t) => allowed.some((a) => a.id === t)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const outside = agent.team_ids.filter((t) => !allowed.some((a) => a.id === t));

  async function save() {
    setBusy(true);
    setError("");
    try {
      await sendJson(`/api/helpdesk/admin/agents/${agent.user_id}`, "PATCH", { team_ids: teamIds }, "Couldn't change their teams.");
      toast("ok", `${agent.name}'s teams saved.`);
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} labelledBy={titleId} className="max-h-[calc(100dvh-2rem)] w-full max-w-md overflow-y-auto rounded-xl border border-slate-200 bg-surface p-5 shadow-modal">
      <div className="flex items-start justify-between gap-3">
        <h2 id={titleId} className="text-base font-semibold text-slate-900">
          {agent.name}&rsquo;s teams
        </h2>
        <button type="button" onClick={onClose} aria-label="Close" data-tt="Close" className={iconButtonClass("quiet", "sm", "-mr-1 -mt-1")}>
          <X aria-hidden />
        </button>
      </div>
      <p className="mt-1 text-sm text-slate-600">
        They work these teams&rsquo; queues.{agent.role === "team_lead" ? " As a Team lead, they lead every team they belong to." : ""}
      </p>
      <div className="mt-4">
        <TeamChecks teams={allowed} value={teamIds} onChange={setTeamIds} legend="Teams" />
        {outside.length > 0 && <p className="mt-2 text-xs text-slate-500">They are also in {outside.length === 1 ? "a team" : `${outside.length} teams`} you don&rsquo;t manage; those stay as they are.</p>}
        {error && <FormError className="mt-3">{error}</FormError>}
      </div>
      <div className="mt-5 flex flex-wrap items-center gap-2">
        <Button busy={busy} onClick={save}>
          Save teams
        </Button>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </Modal>
  );
}
