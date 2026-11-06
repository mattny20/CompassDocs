"use client";

// Desk settings → Skills and languages (1.19.2, agent W2, mock-up b1): the
// workspace's skills and languages, each with how many agents have it, and
// everyone on the desk with their tags. Assignment rules can then send a
// ticket to "an agent with the right skills or language" (Settings →
// Assignment → Rules). teams.manage adds, renames and removes skills and
// languages; a team lead (agents.manage_team) tags the people in their
// teams. Each change saves at once and toasts (STYLEGUIDE §Settings pages).

import { useCallback, useEffect, useId, useMemo, useState } from "react";
import Link from "next/link";
import { Languages, Pencil, Plus, Trash2, UsersRound, X } from "lucide-react";
import { Button, iconButtonClass } from "@/components/Button";
import { Card } from "@/components/Card";
import { Chip } from "@/components/Chip";
import { confirmDialog, promptDialog } from "@/components/Dialog";
import { EmptyState, Field, FormError, SectionEmpty, Select } from "@/components/form";
import { Modal } from "@/components/Modal";
import { PageHeader } from "@/components/PageHeader";
import { PageContainer } from "@/components/PageWidth";
import { LoadingRow } from "@/components/Spinner";
import { Table, Td, Th, TR, TABLE_HEAD_ROW } from "@/components/Table";
import { toast } from "@/components/Toasts";
import { UserAvatar } from "@/components/UserAvatar";
import { languageName, SKILL_LIMITS, type HdSkill, type HdWorkspaceLanguage } from "@/lib/helpdesk/skills/shared";
import { getJson, sendJson } from "../api";

interface AgentRow {
  user_id: number;
  name: string;
  email: string;
  team_ids: number[];
  teams: string[];
  skill_ids: number[];
  languages: string[];
  manageable: boolean;
}

interface Overview {
  skills: HdSkill[];
  languages: HdWorkspaceLanguage[];
  agents: AgentRow[];
  can_manage_lists: boolean;
  catalogue: { value: string; label: string }[];
}

const ROW = "flex min-h-11 items-center gap-3 border-b border-slate-100 py-2 last:border-b-0";

function agentsText(n: number): string {
  return `${n} ${n === 1 ? "agent" : "agents"}`;
}

/** A skill chip (neutral) or a language chip (accent): the mock-up's two tag kinds. */
export function SkillChip({ children, language = false }: { children: React.ReactNode; language?: boolean }) {
  return (
    <Chip tone={language ? "accent" : "neutral"} className="max-w-full">
      <span className="truncate">{children}</span>
    </Chip>
  );
}

export function SkillsSettings() {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState("");
  const [addingLanguage, setAddingLanguage] = useState(false);
  const [editing, setEditing] = useState<AgentRow | null>(null);

  const reload = useCallback(
    () =>
      getJson<Overview>("/api/helpdesk/admin/skills", "Couldn't load skills and languages.")
        .then((d) => {
          setData(d);
          setError("");
        })
        .catch((e: Error) => setError(e.message)),
    []
  );
  useEffect(() => void reload(), [reload]);

  const skillName = useMemo(() => new Map((data?.skills ?? []).map((s) => [s.id, s.name])), [data]);
  const lists = data?.can_manage_lists ?? false;

  async function addSkill() {
    const name = await promptDialog({
      title: "Add a skill",
      label: "Skill",
      help: "Something agents know: Mac, Networking, Payroll, Building access.",
      confirmLabel: "Add skill",
      validate: (s) => (!s.trim() ? "Name the skill." : s.trim().length > SKILL_LIMITS.name ? `Up to ${SKILL_LIMITS.name} characters.` : undefined),
    });
    if (!name) return;
    try {
      await sendJson("/api/helpdesk/admin/skills", "POST", { name: name.trim() }, "Couldn't add the skill.");
      toast("ok", `${name.trim()} added.`);
      void reload();
    } catch (e) {
      toast("error", (e as Error).message);
    }
  }

  async function renameSkill(s: HdSkill) {
    const name = await promptDialog({
      title: `Rename ${s.name}`,
      label: "Skill",
      initial: s.name,
      confirmLabel: "Rename",
      validate: (v) => (!v.trim() ? "Name the skill." : v.trim().length > SKILL_LIMITS.name ? `Up to ${SKILL_LIMITS.name} characters.` : undefined),
    });
    if (!name || name.trim() === s.name) return;
    try {
      await sendJson(`/api/helpdesk/admin/skills/${s.id}`, "PATCH", { name: name.trim() }, "Couldn't rename the skill.");
      toast("ok", "Skill renamed.");
      void reload();
    } catch (e) {
      toast("error", (e as Error).message);
    }
  }

  async function deleteSkill(s: HdSkill) {
    const ok = await confirmDialog({
      title: `Delete ${s.name}?`,
      body: s.agent_count ? `${agentsText(s.agent_count)} lose this skill. Tickets already assigned keep their owner.` : "No agent has this skill yet.",
      confirmLabel: "Delete skill",
      danger: true,
    });
    if (ok !== true) return;
    try {
      await sendJson(`/api/helpdesk/admin/skills/${s.id}`, "DELETE", undefined, "Couldn't delete the skill.");
      toast("ok", `${s.name} deleted.`);
      void reload();
    } catch (e) {
      toast("error", (e as Error).message);
    }
  }

  async function removeLanguage(l: HdWorkspaceLanguage) {
    const ok = await confirmDialog({
      title: `Remove ${l.name}?`,
      body: l.agent_count
        ? `${agentsText(l.agent_count)} stop being tagged with it. Tickets keep their language.`
        : "No agent speaks it yet. Tickets keep their language.",
      confirmLabel: "Remove language",
      danger: true,
    });
    if (ok !== true) return;
    try {
      await sendJson(`/api/helpdesk/admin/skills/languages/${l.code}`, "DELETE", undefined, "Couldn't remove the language.");
      toast("ok", `${l.name} removed.`);
      void reload();
    } catch (e) {
      toast("error", (e as Error).message);
    }
  }

  return (
    <PageContainer>
      <PageHeader
        icon={<Languages />}
        title="Skills and languages"
        subtitle="Tag agents with what they know and the languages they speak. Assignment rules can then send tickets to the right person."
      />
      {error && <p className="notice-error mb-4 rounded-lg border px-3 py-2 text-sm">{error}</p>}
      {data === null && !error && <LoadingRow className="py-10" />}
      {data && (
        <div className="space-y-4">
          <div className="grid gap-4 lg:grid-cols-2">
            <Card
              title="Skills"
              actions={
                lists ? (
                  <Button variant="secondary" size="sm" icon={<Plus />} onClick={addSkill}>
                    Add skill
                  </Button>
                ) : undefined
              }
            >
              {data.skills.length === 0 ? (
                <SectionEmpty action={lists ? { onClick: addSkill, label: "Add a skill" } : undefined}>
                  No skills yet. {lists ? "Add the things your agents know." : "Someone who manages teams adds them."}
                </SectionEmpty>
              ) : (
                <ul aria-label="Skills">
                  {data.skills.map((s) => (
                    <li key={s.id} className={ROW}>
                      <SkillChip>{s.name}</SkillChip>
                      <span className="ml-auto shrink-0 text-sm tabular-nums text-slate-500">{agentsText(s.agent_count)}</span>
                      {lists && (
                        <span className="flex shrink-0 items-center gap-0.5 print:hidden">
                          <button type="button" onClick={() => renameSkill(s)} aria-label={`Rename ${s.name}`} data-tt="Rename" className={iconButtonClass("quiet", "sm")}>
                            <Pencil aria-hidden />
                          </button>
                          <button type="button" onClick={() => deleteSkill(s)} aria-label={`Delete ${s.name}`} data-tt="Delete" className={iconButtonClass("quiet", "sm", "hover-danger")}>
                            <Trash2 aria-hidden />
                          </button>
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </Card>
            <Card
              title="Languages"
              actions={
                lists ? (
                  <Button variant="secondary" size="sm" icon={<Plus />} onClick={() => setAddingLanguage(true)}>
                    Add language
                  </Button>
                ) : undefined
              }
            >
              {data.languages.length === 0 ? (
                <SectionEmpty action={lists ? { onClick: () => setAddingLanguage(true), label: "Add a language" } : undefined}>
                  No languages yet. {lists ? "Add the ones your agents answer in." : "Someone who manages teams adds them."}
                </SectionEmpty>
              ) : (
                <ul aria-label="Languages">
                  {data.languages.map((l) => (
                    <li key={l.code} className={ROW}>
                      <SkillChip language>{l.name}</SkillChip>
                      <span className="ml-auto shrink-0 text-sm tabular-nums text-slate-500">{agentsText(l.agent_count)}</span>
                      {lists && (
                        <span className="flex shrink-0 items-center print:hidden">
                          <button type="button" onClick={() => removeLanguage(l)} aria-label={`Remove ${l.name}`} data-tt="Remove" className={iconButtonClass("quiet", "sm", "hover-danger")}>
                            <Trash2 aria-hidden />
                          </button>
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              <p className="mt-3 text-sm text-slate-500">
                A ticket&apos;s language comes from the requester&apos;s directory entry, or is detected from the first message.
              </p>
            </Card>
          </div>

          {data.agents.length === 0 ? (
            <EmptyState
              icon={<UsersRound />}
              title="Nobody works the desk yet"
              body="Put people on the desk under Agents first, then tag them with what they know and the languages they speak."
              action={{ href: "/desk/settings/agents", label: "Open Agents" }}
            />
          ) : (
            <Card padding="none">
              <Table scroll minWidth="44rem" aria-label="Agents' skills and languages">
                <thead className={TABLE_HEAD_ROW}>
                  <tr>
                    <Th>Agent</Th>
                    <Th>Teams</Th>
                    <Th>Skills</Th>
                    <Th>Languages</Th>
                    <Th fit className="relative">
                      <span className="sr-only">Actions</span>
                    </Th>
                  </tr>
                </thead>
                <tbody>
                  {data.agents.map((a) => (
                    <tr key={a.user_id} className={TR}>
                      <Td>
                        <span className="flex min-w-0 items-center gap-3">
                          <UserAvatar name={a.name} size="sm" />
                          <span className="truncate font-medium text-slate-800">{a.name}</span>
                        </span>
                      </Td>
                      <Td className="text-sm text-slate-600">{a.teams.length ? a.teams.join(", ") : <SectionEmpty>No team</SectionEmpty>}</Td>
                      <Td>
                        {a.skill_ids.length ? (
                          <span className="flex flex-wrap gap-1">
                            {a.skill_ids.map((id) => (
                              <SkillChip key={id}>{skillName.get(id) ?? "Skill"}</SkillChip>
                            ))}
                          </span>
                        ) : (
                          <span className="text-xs text-slate-500">None</span>
                        )}
                      </Td>
                      <Td>
                        {a.languages.length ? (
                          <span className="flex flex-wrap gap-1">
                            {a.languages.map((code) => (
                              <SkillChip key={code} language>
                                {languageName(code)}
                              </SkillChip>
                            ))}
                          </span>
                        ) : (
                          <span className="text-xs text-slate-500">None</span>
                        )}
                      </Td>
                      <Td fit>
                        {a.manageable && (
                          <button
                            type="button"
                            onClick={() => setEditing(a)}
                            aria-label={`Change ${a.name}'s skills and languages`}
                            data-tt="Skills and languages"
                            className={iconButtonClass("quiet", "sm", "print:hidden")}
                          >
                            <Pencil aria-hidden />
                          </button>
                        )}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </Card>
          )}
          {!lists && (
            <p className="text-sm text-slate-500">
              You can tag the people in your teams below your own role. Someone who manages teams adds skills and languages. Rules that use them are under{" "}
              <Link href="/desk/settings/assignment/rules" className="link">
                Assignment
              </Link>
              .
            </p>
          )}
        </div>
      )}
      {data && (
        <AddLanguageModal
          open={addingLanguage}
          catalogue={data.catalogue.filter((c) => !data.languages.some((l) => l.code === c.value))}
          onClose={() => setAddingLanguage(false)}
          onAdded={(name) => {
            setAddingLanguage(false);
            toast("ok", `${name} added.`);
            void reload();
          }}
        />
      )}
      {data && (
        <AgentTagsModal
          agent={editing}
          skills={data.skills}
          languages={data.languages}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void reload();
          }}
        />
      )}
    </PageContainer>
  );
}

function AddLanguageModal({
  open,
  catalogue,
  onClose,
  onAdded,
}: {
  open: boolean;
  catalogue: { value: string; label: string }[];
  onClose: () => void;
  onAdded: (name: string) => void;
}) {
  const titleId = useId();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (open) {
      setCode("");
      setError("");
    }
  }, [open]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!code) return setError("Choose a language.");
    setBusy(true);
    try {
      await sendJson("/api/helpdesk/admin/skills/languages", "POST", { code }, "Couldn't add the language.");
      onAdded(languageName(code));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} labelledBy={titleId} className="w-full max-w-md rounded-xl border border-slate-200 bg-surface p-5 shadow-modal">
      <form onSubmit={save} noValidate>
        <div className="flex items-start justify-between gap-3">
          <h2 id={titleId} className="text-base font-semibold text-slate-900">
            Add a language
          </h2>
          <button type="button" onClick={onClose} aria-label="Close" data-tt="Close" className={iconButtonClass("quiet", "sm", "-mr-1 -mt-1")}>
            <X aria-hidden />
          </button>
        </div>
        <Field label="Language" className="mt-4" help="A language your agents answer tickets in.">
          <Select value={code} onChange={(e) => setCode(e.target.value)}>
            <option value="">Choose a language</option>
            {catalogue.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </Select>
        </Field>
        <FormError>{error}</FormError>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" busy={busy}>
            Add language
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function AgentTagsModal({
  agent,
  skills,
  languages,
  onClose,
  onSaved,
}: {
  agent: AgentRow | null;
  skills: HdSkill[];
  languages: HdWorkspaceLanguage[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const titleId = useId();
  const [skillIds, setSkillIds] = useState<number[]>([]);
  const [langs, setLangs] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!agent) return;
    setSkillIds(agent.skill_ids);
    setLangs(agent.languages);
    setError("");
  }, [agent]);

  const flip = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!agent) return;
    setBusy(true);
    setError("");
    try {
      await sendJson(`/api/helpdesk/admin/skills/agents/${agent.user_id}`, "PUT", { skill_ids: skillIds, languages: langs }, "Couldn't save the tags.");
      toast("ok", `${agent.name}'s skills and languages saved.`);
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const box = "inline-flex items-center gap-1.5 rounded-md py-0.5 text-sm text-slate-700";
  return (
    <Modal open={!!agent} onClose={onClose} labelledBy={titleId} className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-xl border border-slate-200 bg-surface p-5 shadow-modal">
      <form onSubmit={save} noValidate>
        <div className="flex items-start justify-between gap-3">
          <h2 id={titleId} className="text-base font-semibold text-slate-900">
            {agent ? `${agent.name}'s skills and languages` : ""}
          </h2>
          <button type="button" onClick={onClose} aria-label="Close" data-tt="Close" className={iconButtonClass("quiet", "sm", "-mr-1 -mt-1")}>
            <X aria-hidden />
          </button>
        </div>
        <fieldset className="mt-4">
          <legend className="text-sm font-semibold text-slate-800">Skills</legend>
          {skills.length === 0 ? (
            <SectionEmpty className="mt-1">No skills yet.</SectionEmpty>
          ) : (
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1.5">
              {skills.map((s) => (
                <label key={s.id} className={box}>
                  <input type="checkbox" checked={skillIds.includes(s.id)} onChange={() => setSkillIds(flip(skillIds, s.id))} />
                  {s.name}
                </label>
              ))}
            </div>
          )}
        </fieldset>
        <fieldset className="mt-4">
          <legend className="text-sm font-semibold text-slate-800">Languages they speak</legend>
          {languages.length === 0 ? (
            <SectionEmpty className="mt-1">No languages yet.</SectionEmpty>
          ) : (
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1.5">
              {languages.map((l) => (
                <label key={l.code} className={box}>
                  <input type="checkbox" checked={langs.includes(l.code)} onChange={() => setLangs(flip(langs, l.code))} />
                  {l.name}
                </label>
              ))}
            </div>
          )}
        </fieldset>
        <FormError>{error}</FormError>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" busy={busy}>
            Save
          </Button>
        </div>
      </form>
    </Modal>
  );
}
