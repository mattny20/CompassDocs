"use client";

// Settings → Assignment → Rules (agent N): ordered rules that run on every
// new ticket before the team's own setting (first to last; a rule that
// matches stops the run unless it says to carry on). The list moves by
// drag and drop on the grip or by the Move up / Move down buttons (the
// keyboard way); each row has on/off, Edit and Delete. The editor (a
// Modal) builds conditions in the workflow builder's "Only if" style (what
// to check, how to compare, the value; All / Any) and picks the action. The
// "Test a ticket" card runs the rules against a ticket number or a made-up
// sample and says which rule matched, why each one did or didn't, and where
// the ticket would go.

import { useEffect, useId, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Check, FlaskConical, GripVertical, ListOrdered, Pencil, Plus, Trash2, X } from "lucide-react";
import { Button, iconButtonClass } from "@/components/Button";
import { Card } from "@/components/Card";
import { Chip } from "@/components/Chip";
import { confirmDialog } from "@/components/Dialog";
import { EmptyState, Field, FormError, SectionEmpty, Select, TextInput, Toggle } from "@/components/form";
import { Modal } from "@/components/Modal";
import { Segmented } from "@/components/Segmented";
import { LoadingRow } from "@/components/Spinner";
import { toast } from "@/components/Toasts";
import { SUB_HEADING_TEXT } from "@/components/Heading";
import {
  ANSWER_PREFIX,
  HD_ASSIGN_ACTIONS,
  HD_ASSIGN_ACTION_LABEL,
  HD_ASSIGN_FIELDS,
  HD_ASSIGN_OP_LABEL,
  HD_ASSIGN_SOURCES,
  HD_MIN_ROLES,
  ANSWER_OPS,
  HD_ASSIGN_ACTION_HINT,
  opTakesValue,
  type HdAssignAction,
  type HdAssignCondition,
  type HdAssignConditions,
  type HdAssignFieldDef,
  type HdAssignmentRule,
  type HdAssignOp,
} from "@/lib/helpdesk/assignment/shared";
import { HD_PRIORITIES, HD_PRIORITY_LABEL, type HdPriority } from "@/lib/helpdesk/types";
import { HD_ROLE_LABEL, type HdRole } from "@/lib/helpdesk/roles-shared";
import { RadioCards } from "@/components/PolicyFields";
import { HD_DETECTABLE_LANGUAGES, criteriaText, languageOptions } from "@/lib/helpdesk/skills/shared";
import { getJson, sendJson } from "../api";
import { EMPTY_SKILL_CRITERIA, SkillsActionPanel } from "../skills/SkillsActionPanel";
import type { AssignmentChoices } from "./data";

const EMPTY_CHOICES: AssignmentChoices = { teams: [], request_types: [], integrations: [], agents: [], form_fields: [], skills: [], languages: [] };
const MAX_CONDITIONS = 12;

interface FieldChoice {
  key: string;
  label: string;
  group: string;
  def: HdAssignFieldDef;
  options?: { value: string; label: string }[];
}

/** Everything a condition can check, with the server's choices filled in. */
function fieldChoices(c: AssignmentChoices): FieldChoice[] {
  const opts: Record<string, { value: string; label: string }[] | undefined> = {
    team: c.teams.map((t) => ({ value: String(t.id), label: t.name })),
    request_type: c.request_types.map((t) => ({ value: String(t.id), label: t.name })),
    integration: c.integrations.map((t) => ({ value: String(t.id), label: t.name })),
    // The ticket's language (1.19.2): the workspace's languages and the ones the detector knows.
    language: languageOptions([...new Set([...(c.languages ?? []).map((l) => l.code), ...HD_DETECTABLE_LANGUAGES])]),
  };
  const fixed = (Object.entries(HD_ASSIGN_FIELDS) as [string, HdAssignFieldDef][])
    .filter(([k]) => k !== "integration" || c.integrations.length > 0)
    .filter(([k]) => k !== "request_type" || c.request_types.length > 0)
    .map(([key, def]) => ({ key, label: def.label, group: def.group, def, options: def.options ?? opts[key] }));
  const answers = c.form_fields.map((f) => ({
    key: `${ANSWER_PREFIX}${f.key}`,
    label: f.label,
    group: "Form answers",
    def: { label: f.label, group: "Form answers", kind: "text" as const, ops: ANSWER_OPS },
  }));
  return [...fixed, ...answers];
}

function valueText(c: HdAssignCondition, f: FieldChoice | undefined): string {
  const vals = Array.isArray(c.value) ? c.value : c.value ? [c.value] : [];
  const named = vals.map((v) => f?.options?.find((o) => o.value === v)?.label ?? v);
  return named.length > 1 ? named.slice(0, -1).join(", ") + " or " + named.at(-1) : named[0] ?? "";
}

function conditionSentence(c: HdAssignCondition, fields: FieldChoice[]): string {
  const f = fields.find((x) => x.key === c.field);
  const raw = f?.label ?? c.field;
  const label = raw.charAt(0).toLowerCase() + raw.slice(1);
  if (c.field === "hours") return valueText(c, f).toLowerCase() === "closed" ? "the team is closed" : "the team is open";
  if (c.op === "is_true") return label;
  if (c.op === "is_false") return `not: ${label}`;
  return `${label} ${HD_ASSIGN_OP_LABEL[c.op]}${opTakesValue(c.op) ? ` ${valueText(c, f)}` : ""}`;
}

function ruleSummary(r: Pick<HdAssignmentRule, "conditions" | "action" | "scope_team_id">, fields: FieldChoice[], c: AssignmentChoices): string {
  const team = (id: number | null | undefined) => c.teams.find((t) => t.id === id)?.name ?? "a team";
  const conds = r.conditions?.rules ?? [];
  const joiner = r.conditions?.match === "any" ? " or " : " and ";
  const when = conds.length ? conds.map((x) => conditionSentence(x, fields)).join(joiner) : "any ticket";
  const a = r.action ?? { assign: "team_mode" };
  const then: string[] = [];
  if (a.team_id) then.push(`move to ${team(a.team_id)}`);
  if (a.set_priority) then.push(a.set_priority === "from_severity" ? "priority from the alert's severity" : `set ${HD_PRIORITY_LABEL[a.set_priority]}`);
  if (a.add_tags?.length) then.push(`tag ${a.add_tags.join(", ")}`);
  if (a.assign === "user") then.push(`assign to ${c.agents.find((x) => x.id === a.user_id)?.name ?? "someone"}`);
  else if (a.assign === "skills" && a.skills) {
    const who = criteriaText(a.skills, (id) => c.skills?.find((s) => s.id === id)?.name ?? "a deleted skill") || "has the right skills";
    then.push(`assign to an agent who ${who} (else ${a.skills.fallback === "queue" ? "wait in the queue" : "the team's turn"})`);
  }
  else if (a.assign !== "team_mode") then.push(HD_ASSIGN_ACTION_LABEL[a.assign].toLowerCase());
  else then.push("use the team's setting");
  if (a.min_role) then.push(`${HD_ROLE_LABEL[a.min_role].toLowerCase()} or above`);
  const scope = r.scope_team_id ? `In ${team(r.scope_team_id)}: if ` : "If ";
  return `${scope}${when}, then ${then.join(", ")}.`;
}

/** A new "agent with the right skills" action starts from the rule's own language condition ("Ticket language is French" → speaks French). */
function skillsFromConditions(c: HdAssignConditions): NonNullable<HdAssignAction["skills"]> {
  const lang = c.rules.find((r) => r.field === "language" && r.op === "equals");
  const vals = Array.isArray(lang?.value) ? lang.value : lang?.value ? [lang.value] : [];
  return { ...EMPTY_SKILL_CRITERIA, language: vals.length === 1 ? vals[0] : null };
}

export function AssignmentRules() {
  const [rules, setRules] = useState<HdAssignmentRule[] | null>(null);
  const [choices, setChoices] = useState<AssignmentChoices>(EMPTY_CHOICES);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<HdAssignmentRule | "new" | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState<number | null>(null);
  const dragFrom = useRef<number | null>(null);

  const load = () =>
    getJson<{ rules: HdAssignmentRule[]; choices: AssignmentChoices }>("/api/helpdesk/admin/assignment/rules", "Couldn't load the rules.")
      .then((d) => {
        setRules(d.rules);
        setChoices(d.choices ?? EMPTY_CHOICES);
      })
      .catch((e: Error) => setError(e.message));
  useEffect(() => void load(), []);
  const fields = fieldChoices(choices);

  async function reorder(ids: number[], announce: string) {
    setBusy(true);
    try {
      const d = await sendJson<{ rules: HdAssignmentRule[] }>("/api/helpdesk/admin/assignment/rules/reorder", "POST", { ids }, "Couldn't change the order.");
      setRules(d.rules);
      toast("ok", announce);
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function move(from: number, to: number) {
    if (!rules || from === to || to < 0 || to >= rules.length) return;
    const list = [...rules];
    const [r] = list.splice(from, 1);
    list.splice(to, 0, r);
    setRules(list);
    void reorder(list.map((x) => x.id), `${r.name} is now rule ${to + 1}.`);
  }

  async function toggle(r: HdAssignmentRule) {
    try {
      await sendJson(`/api/helpdesk/admin/assignment/rules/${r.id}`, "PATCH", { enabled: r.enabled ? 0 : 1 }, "Couldn't change the rule.");
      toast("ok", r.enabled ? `${r.name} is off.` : `${r.name} is on.`);
      void load();
    } catch (e) {
      toast("error", (e as Error).message);
    }
  }

  async function remove(r: HdAssignmentRule) {
    const ok = await confirmDialog({ title: `Delete ${r.name}?`, body: "Tickets it already assigned keep their owner. This cannot be undone.", confirmLabel: "Delete rule", danger: true });
    if (ok !== true) return;
    try {
      await sendJson(`/api/helpdesk/admin/assignment/rules/${r.id}`, "DELETE", undefined, "Couldn't delete the rule.");
      toast("ok", "Rule deleted.");
      void load();
    } catch (e) {
      toast("error", (e as Error).message);
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-prose text-sm text-slate-600">
          Rules run on every new ticket, first to last, before the team&apos;s own setting. Automations run after them and can still change the owner.
        </p>
        <Button icon={<Plus />} onClick={() => setEditing("new")}>
          New rule
        </Button>
      </div>
      {error && <p className="notice-error rounded-lg border px-3 py-2 text-sm">{error}</p>}
      {rules === null && !error && <LoadingRow className="py-10" />}
      {rules && rules.length === 0 && (
        <EmptyState
          icon={<ListOrdered />}
          title="No assignment rules yet"
          body="For example: alerts from monitoring go to Infra, round robin among the people on shift; VIP requests go to a team lead."
          action={{ onClick: () => setEditing("new"), label: "New rule", icon: <Plus /> }}
        />
      )}
      {rules && rules.length > 0 && (
        <Card padding="none">
          <ol className="divide-y divide-slate-100" aria-label="Assignment rules, in run order">
            {rules.map((r, i) => (
              <li
                key={r.id}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  if (dragFrom.current !== null) move(dragFrom.current, i);
                  dragFrom.current = null;
                  setDragging(null);
                }}
                className={`flex flex-wrap items-start gap-3 px-4 py-3 sm:flex-nowrap ${dragging === i ? "opacity-50" : ""}`}
              >
                <span
                  draggable
                  onDragStart={(e) => {
                    dragFrom.current = i;
                    setDragging(i);
                    e.dataTransfer.effectAllowed = "move";
                  }}
                  onDragEnd={() => setDragging(null)}
                  className="mt-0.5 hidden cursor-grab text-slate-400 hover:text-slate-600 sm:block"
                  data-tt="Drag to reorder"
                  aria-hidden
                >
                  <GripVertical className="h-4 w-4" />
                </span>
                <span className="mt-0.5 w-5 shrink-0 text-right text-xs tabular-nums text-slate-500">{i + 1}</span>
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-slate-900">
                    {r.name}
                    {!r.enabled && <Chip tone="neutral" size="sm">Off</Chip>}
                    {!r.stop && <Chip tone="info" size="sm">Carries on</Chip>}
                  </p>
                  <p className="mt-0.5 text-xs text-slate-500">{ruleSummary(r, fields, choices)}</p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button variant="secondary" size="sm" onClick={() => toggle(r)}>
                    {r.enabled ? "Turn off" : "Turn on"}
                    <span className="sr-only"> {r.name}</span>
                  </Button>
                  <button type="button" disabled={busy || i === 0} onClick={() => move(i, i - 1)} aria-label={`Move ${r.name} up`} data-tt="Move up" className={iconButtonClass("quiet", "sm")}>
                    <ArrowUp aria-hidden />
                  </button>
                  <button type="button" disabled={busy || i === rules.length - 1} onClick={() => move(i, i + 1)} aria-label={`Move ${r.name} down`} data-tt="Move down" className={iconButtonClass("quiet", "sm")}>
                    <ArrowDown aria-hidden />
                  </button>
                  <button type="button" onClick={() => setEditing(r)} aria-label={`Edit ${r.name}`} data-tt="Edit" className={iconButtonClass("quiet", "sm")}>
                    <Pencil aria-hidden />
                  </button>
                  <button type="button" onClick={() => remove(r)} aria-label={`Delete ${r.name}`} data-tt="Delete" className={iconButtonClass("quiet", "sm", "hover-danger")}>
                    <Trash2 aria-hidden />
                  </button>
                </div>
              </li>
            ))}
          </ol>
        </Card>
      )}
      <TestBox choices={choices} />
      <RuleEditor
        rule={editing}
        fields={fields}
        choices={choices}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          void load();
        }}
      />
    </div>
  );
}

// --- The editor --------------------------------------------------------------------

function RuleEditor({
  rule,
  fields,
  choices,
  onClose,
  onSaved,
}: {
  rule: HdAssignmentRule | "new" | null;
  fields: FieldChoice[];
  choices: AssignmentChoices;
  onClose: () => void;
  onSaved: () => void;
}) {
  const titleId = useId();
  const existing = rule && rule !== "new" ? rule : null;
  const [name, setName] = useState("");
  const [scope, setScope] = useState<number | null>(null);
  const [conds, setConds] = useState<HdAssignConditions>({ match: "all", rules: [] });
  const [action, setAction] = useState<HdAssignAction>({ assign: "team_mode" });
  const [tags, setTags] = useState("");
  const [stop, setStop] = useState(true);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!rule) return;
    const r = rule === "new" ? null : rule;
    setName(r?.name ?? "");
    setScope(r?.scope_team_id ?? null);
    setConds(r?.conditions?.rules ? r.conditions : { match: "all", rules: [] });
    setAction(r?.action ?? { assign: "team_mode" });
    setTags((r?.action?.add_tags ?? []).join(", "));
    setStop(r ? r.stop === 1 : true);
    setTried(false);
    setError("");
  }, [rule]);

  const skillsProblem = action.assign === "skills" && !action.skills?.language && !action.skills?.skill_ids.length;
  const condProblem = conds.rules.findIndex((c) => opTakesValue(c.op) && (Array.isArray(c.value) ? c.value.length === 0 : !String(c.value ?? "").trim()));
  const errs = {
    name: !name.trim() ? "Name the rule." : undefined,
    user: action.assign === "user" && !action.user_id ? "Choose who gets the tickets." : undefined,
    conds: condProblem >= 0 ? `Give condition ${condProblem + 1} a value.` : undefined,
    skills: skillsProblem ? "Choose a language or at least one skill the agent needs." : undefined,
  };

  function addCondition() {
    const f = fields[0];
    const op = f.def.ops[0];
    setConds({ ...conds, rules: [...conds.rules, { field: f.key, op, value: opTakesValue(op) ? (f.options ? [] : "") : undefined }] });
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setTried(true);
    if (errs.name || errs.user || errs.conds || errs.skills) return;
    const add_tags = tags.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean);
    const payload = {
      name: name.trim(),
      scope_team_id: scope,
      stop: stop ? 1 : 0,
      conditions: conds,
      action: {
        assign: action.assign,
        ...(action.team_id ? { team_id: action.team_id } : {}),
        ...(action.assign === "user" ? { user_id: action.user_id } : {}),
        ...(action.assign === "skills" ? { skills: action.skills ?? EMPTY_SKILL_CRITERIA } : {}),
        ...(action.min_role ? { min_role: action.min_role } : {}),
        ...(action.set_priority ? { set_priority: action.set_priority } : {}),
        ...(add_tags.length ? { add_tags } : {}),
      },
    };
    setBusy(true);
    setError("");
    try {
      if (existing) await sendJson(`/api/helpdesk/admin/assignment/rules/${existing.id}`, "PATCH", payload, "Couldn't save the rule.");
      else await sendJson("/api/helpdesk/admin/assignment/rules", "POST", { ...payload, enabled: 1 }, "Couldn't create the rule.");
      toast("ok", existing ? "Rule saved." : "Rule created.");
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const summary = ruleSummary({ conditions: conds, action: { ...action, add_tags: tags.split(",").map((t) => t.trim()).filter(Boolean) }, scope_team_id: scope }, fields, choices);
  const needsTeam = action.assign !== "user";
  const groups = [...new Set(fields.map((f) => f.group))];

  return (
    <Modal open={!!rule} onClose={onClose} labelledBy={titleId} className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-xl border border-slate-200 bg-surface p-5 shadow-modal">
      <form onSubmit={save} noValidate>
        <div className="flex items-start justify-between gap-3">
          <h2 id={titleId} className="text-base font-semibold text-slate-900">
            {existing ? `Edit ${existing.name}` : "New assignment rule"}
          </h2>
          <button type="button" onClick={onClose} aria-label="Close" data-tt="Close" className={iconButtonClass("quiet", "sm", "-mr-1 -mt-1")}>
            <X aria-hidden />
          </button>
        </div>
        <div className="mt-4 space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Name" error={tried ? errs.name : undefined}>
              <TextInput value={name} onChange={(e) => setName(e.target.value)} maxLength={120} placeholder="VIP to seniors" />
            </Field>
            <Field label="Applies to">
              <Select value={scope ?? ""} onChange={(e) => setScope(e.target.value ? Number(e.target.value) : null)}>
                <option value="">Tickets of every team</option>
                {choices.teams.map((t) => (
                  <option key={t.id} value={t.id}>
                    Only {t.name}&apos;s tickets
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          <fieldset className="rounded-lg border border-slate-200 p-3">
            <legend className="px-1 text-sm font-semibold text-slate-800">Only if…</legend>
            <p className="text-xs text-slate-500">{conds.rules.length ? "The rule applies when these are true." : "With no conditions the rule applies to every ticket."}</p>
            {conds.rules.length > 1 && (
              <Segmented
                size="sm"
                className="mt-3"
                label="Which conditions must be true"
                value={conds.match}
                onChange={(m) => setConds({ ...conds, match: m })}
                options={[
                  { value: "all", label: "All of these" },
                  { value: "any", label: "Any of these" },
                ]}
              />
            )}
            {conds.rules.length > 0 && (
              <ol className="mt-3 space-y-2" aria-label="Conditions">
                {conds.rules.map((c, i) => (
                  <ConditionRow
                    key={i}
                    n={i + 1}
                    cond={c}
                    fields={fields}
                    groups={groups}
                    joiner={i === 0 ? null : conds.match === "any" ? "or" : "and"}
                    onChange={(next) => setConds({ ...conds, rules: conds.rules.map((x, j) => (j === i ? next : x)) })}
                    onRemove={() => setConds({ ...conds, rules: conds.rules.filter((_, j) => j !== i) })}
                  />
                ))}
              </ol>
            )}
            {tried && errs.conds && (
              <p role="alert" className="mt-2 text-xs text-red-600">
                {errs.conds}
              </p>
            )}
            <Button variant="secondary" size="sm" icon={<Plus />} className="mt-3" onClick={addCondition} disabled={conds.rules.length >= MAX_CONDITIONS}>
              {conds.rules.length ? "Add another condition" : "Add a condition"}
            </Button>
          </fieldset>

          <fieldset className="rounded-lg border border-slate-200 p-3">
            <legend className="px-1 text-sm font-semibold text-slate-800">Then</legend>
            <p className="mb-2 text-sm font-medium text-slate-800">Assign to</p>
            <RadioCards
              label="Assign to"
              name={`assign-${titleId}`}
              value={action.assign}
              onChange={(a) => setAction({ ...action, assign: a, ...(a === "skills" && !action.skills ? { skills: skillsFromConditions(conds) } : {}) })}
              options={HD_ASSIGN_ACTIONS.map((a) => ({
                value: a,
                label: HD_ASSIGN_ACTION_LABEL[a],
                description: HD_ASSIGN_ACTION_HINT[a],
                extra:
                  a === "user" ? (
                    <Field label="Person" error={tried ? errs.user : undefined}>
                      <Select value={action.user_id ?? ""} onChange={(e) => setAction({ ...action, user_id: e.target.value ? Number(e.target.value) : null })}>
                        <option value="">Choose someone</option>
                        {choices.agents.map((x) => (
                          <option key={x.id} value={x.id}>
                            {x.name}
                          </option>
                        ))}
                      </Select>
                    </Field>
                  ) : a === "skills" ? (
                    <>
                      <SkillsActionPanel
                        value={action.skills ?? EMPTY_SKILL_CRITERIA}
                        onChange={(next) => setAction({ ...action, skills: next })}
                        skills={choices.skills ?? []}
                        languages={choices.languages ?? []}
                        teamId={action.team_id ?? scope ?? null}
                        minRole={action.min_role ?? null}
                      />
                      {tried && errs.skills && (
                        <p role="alert" className="mt-2 text-xs text-red-600">
                          {errs.skills}
                        </p>
                      )}
                    </>
                  ) : undefined,
              }))}
            />
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              {action.assign !== "user" && (
                <Field label="Only people who are at least" help={needsTeam ? "VIP and urgent work can need a team lead." : undefined}>
                  <Select value={action.min_role ?? ""} onChange={(e) => setAction({ ...action, min_role: (e.target.value || null) as HdRole | null })} disabled={action.assign === "leave_unassigned"}>
                    <option value="">Anyone the team includes</option>
                    {HD_MIN_ROLES.map((r) => (
                      <option key={r} value={r}>
                        {HD_ROLE_LABEL[r]}
                      </option>
                    ))}
                  </Select>
                </Field>
              )}
              <Field label="Move to team first">
                <Select value={action.team_id ?? ""} onChange={(e) => setAction({ ...action, team_id: e.target.value ? Number(e.target.value) : null })}>
                  <option value="">Keep its team</option>
                  {choices.teams.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Set the priority">
                <Select value={action.set_priority ?? ""} onChange={(e) => setAction({ ...action, set_priority: (e.target.value || null) as HdAssignAction["set_priority"] })}>
                  <option value="">Leave as it is</option>
                  {HD_PRIORITIES.map((p) => (
                    <option key={p} value={p}>
                      {HD_PRIORITY_LABEL[p as HdPriority]}
                    </option>
                  ))}
                  <option value="from_severity">From the alert&apos;s severity</option>
                </Select>
              </Field>
              <Field label="Add tags" help="Comma-separated." className="sm:col-span-2">
                <TextInput value={tags} onChange={(e) => setTags(e.target.value)} placeholder="alert, infra" />
              </Field>
            </div>
            <Toggle className="mt-4" label="Stop here when this rule matches" help="Off: the rules below still run, and a later match can change the owner." checked={stop} onChange={setStop} />
          </fieldset>

          <p className="rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-700" aria-live="polite">
            {summary}
          </p>
          <FormError>{error}</FormError>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" busy={busy}>
            {existing ? "Save rule" : "Create rule"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function ConditionRow({
  n,
  cond,
  fields,
  groups,
  joiner,
  onChange,
  onRemove,
}: {
  n: number;
  cond: HdAssignCondition;
  fields: FieldChoice[];
  groups: string[];
  joiner: "and" | "or" | null;
  onChange: (c: HdAssignCondition) => void;
  onRemove: () => void;
}) {
  const f = fields.find((x) => x.key === cond.field);
  const ops = f?.def.ops ?? (["equals"] as readonly HdAssignOp[]);

  function pickField(key: string) {
    const nf = fields.find((x) => x.key === key);
    if (!nf) return;
    const op = nf.def.ops.includes(cond.op) ? cond.op : nf.def.ops[0];
    onChange({ field: key, op, value: opTakesValue(op) ? (nf.options ? [] : "") : undefined });
  }
  function pickOp(op: HdAssignOp) {
    if (!opTakesValue(op)) return onChange({ field: cond.field, op });
    onChange({ ...cond, op, value: cond.value ?? (f?.options ? [] : "") });
  }

  return (
    <li className="rounded-lg border border-slate-200 p-2.5">
      <div className="flex items-center gap-2">
        <span className="text-2xs font-semibold uppercase tracking-wider text-slate-500">{joiner ?? "Condition"}</span>
        <span className="flex-1" />
        <button type="button" onClick={onRemove} aria-label={`Remove condition ${n}`} data-tt="Remove" className={iconButtonClass("quiet", "sm", "hover-danger")}>
          <X aria-hidden />
        </button>
      </div>
      <div className="mt-1.5 grid gap-2 sm:grid-cols-2">
        <Select dense aria-label={`Condition ${n}: what to check`} value={cond.field} onChange={(e) => pickField(e.target.value)}>
          {groups.map((g) => (
            <optgroup key={g} label={g}>
              {fields
                .filter((x) => x.group === g)
                .map((x) => (
                  <option key={x.key} value={x.key}>
                    {x.label}
                  </option>
                ))}
            </optgroup>
          ))}
        </Select>
        <Select dense aria-label={`Condition ${n}: how to compare`} value={cond.op} onChange={(e) => pickOp(e.target.value as HdAssignOp)}>
          {ops.map((o) => (
            <option key={o} value={o}>
              {HD_ASSIGN_OP_LABEL[o]}
            </option>
          ))}
        </Select>
      </div>
      {opTakesValue(cond.op) &&
        (f?.options && f.def.kind === "choice" ? (
          <fieldset className="mt-2">
            <legend className="sr-only">Condition {n}: values</legend>
            <div className="flex flex-wrap gap-x-4 gap-y-1.5">
              {f.options.length === 0 && <SectionEmpty className="text-xs">Nothing to choose from yet.</SectionEmpty>}
              {f.options.map((o) => {
                const list = Array.isArray(cond.value) ? cond.value : cond.value ? [cond.value] : [];
                const on = list.includes(o.value);
                return (
                  <label key={o.value} className="inline-flex items-center gap-1.5 text-sm text-slate-700">
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={() => onChange({ ...cond, value: on ? list.filter((v) => v !== o.value) : [...list, o.value] })}
                    />
                    {o.label}
                  </label>
                );
              })}
            </div>
          </fieldset>
        ) : f?.options ? (
          <Select dense className="mt-2" aria-label={`Condition ${n}: value`} value={String(Array.isArray(cond.value) ? cond.value[0] ?? "" : cond.value ?? "")} onChange={(e) => onChange({ ...cond, value: e.target.value })}>
            {f.options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        ) : (
          <TextInput
            dense
            className="mt-2"
            aria-label={`Condition ${n}: value`}
            placeholder={["contains", "not_contains", "in"].includes(cond.op) ? "Words, comma-separated" : "Value"}
            value={Array.isArray(cond.value) ? cond.value.join(", ") : cond.value ?? ""}
            onChange={(e) => {
              const v = e.target.value;
              onChange({ ...cond, value: ["contains", "not_contains", "in", "not_in"].includes(cond.op) ? v.split(",").map((x) => x.trimStart()) : v });
            }}
          />
        ))}
    </li>
  );
}

// --- The test box ------------------------------------------------------------------

interface TestResult {
  matched: { id: number; name: string } | null;
  trace: { rule_id: number; name: string; matched: boolean; reason: string }[];
  outcome: string;
  /** 1.19.2: the ticket's language and where it came from. */
  language?: { code: string | null; note: string };
}

function TestBox({ choices }: { choices: AssignmentChoices }) {
  const [mode, setMode] = useState<"sample" | "ticket">("sample");
  const [number, setNumber] = useState("");
  const [s, setS] = useState({ subject: "", source: "portal", team_id: "", priority: "normal", automated: false, vip: false, hours: "open" as "open" | "closed", department: "", language: "" });
  const [result, setResult] = useState<TestResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function run(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const body =
        mode === "ticket"
          ? { ticket_number: Number(number.replace(/^#/, "")) }
          : { sample: { ...s, team_id: s.team_id ? Number(s.team_id) : null, automated: s.automated || s.source === "alert" || s.source === "api", language: s.language || null } };
      setResult(await sendJson<TestResult>("/api/helpdesk/admin/assignment/rules/test", "POST", body, "Couldn't test the rules."));
    } catch (err) {
      setResult(null);
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Test a ticket" icon={<FlaskConical />} description="See which rule would match and where the ticket would go. Nothing is changed.">
      <form onSubmit={run} noValidate className="space-y-3">
        <Segmented
          size="sm"
          label="What to test"
          value={mode}
          onChange={setMode}
          options={[
            { value: "sample", label: "A made-up ticket" },
            { value: "ticket", label: "A ticket number" },
          ]}
        />
        {mode === "ticket" ? (
          <Field label="Ticket number" size="sm">
            <TextInput inputMode="numeric" value={number} onChange={(e) => setNumber(e.target.value)} placeholder="1047" />
          </Field>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <Field label="Subject" className="sm:col-span-2 lg:col-span-3">
              <TextInput value={s.subject} onChange={(e) => setS({ ...s, subject: e.target.value })} placeholder="CPU high on web-01" />
            </Field>
            <Field label="Came in through">
              <Select value={s.source} onChange={(e) => setS({ ...s, source: e.target.value })}>
                {HD_ASSIGN_SOURCES.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Team">
              <Select value={s.team_id} onChange={(e) => setS({ ...s, team_id: e.target.value })}>
                <option value="">No team yet</option>
                {choices.teams.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Priority">
              <Select value={s.priority} onChange={(e) => setS({ ...s, priority: e.target.value })}>
                {HD_PRIORITIES.map((p) => (
                  <option key={p} value={p}>
                    {HD_PRIORITY_LABEL[p]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Ticket language">
              <Select value={s.language} onChange={(e) => setS({ ...s, language: e.target.value })}>
                <option value="">Unknown</option>
                {languageOptions([...new Set([...(choices.languages ?? []).map((l) => l.code), ...HD_DETECTABLE_LANGUAGES])]).map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Requester's department">
              <TextInput value={s.department} onChange={(e) => setS({ ...s, department: e.target.value })} placeholder="Finance" />
            </Field>
            <div className="flex flex-col gap-1.5 pt-1 text-sm text-slate-700">
              <label className="inline-flex items-center gap-1.5">
                <input type="checkbox" checked={s.automated} onChange={(e) => setS({ ...s, automated: e.target.checked })} />
                Sent by a machine
              </label>
              <label className="inline-flex items-center gap-1.5">
                <input type="checkbox" checked={s.vip} onChange={(e) => setS({ ...s, vip: e.target.checked })} />
                Requester is a VIP
              </label>
            </div>
            <div>
              <p className="mb-1 text-sm font-medium text-slate-800">Office hours</p>
              <Segmented
                size="sm"
                label="The team's office hours"
                value={s.hours}
                onChange={(h) => setS({ ...s, hours: h })}
                options={[
                  { value: "open", label: "Open" },
                  { value: "closed", label: "Closed" },
                ]}
              />
            </div>
          </div>
        )}
        <Button type="submit" variant="secondary" icon={<FlaskConical />} busy={busy}>
          Test
        </Button>
        <FormError>{error}</FormError>
      </form>
      {result && (
        <div className="mt-4 border-t border-slate-100 pt-4" aria-live="polite">
          <p className="text-sm font-medium text-slate-900">{result.outcome}</p>
          {result.language && <p className="mt-1 text-xs text-slate-500">{result.language.note}</p>}
          {result.trace.length > 0 && (
            <>
              <h3 className={`${SUB_HEADING_TEXT} mt-3`}>Rule by rule</h3>
              <ol className="mt-1.5 space-y-1">
                {result.trace.map((t, i) => (
                  <li key={t.rule_id} className="flex items-start gap-2 text-sm">
                    <span className="w-5 shrink-0 text-right text-xs tabular-nums text-slate-500">{i + 1}</span>
                    {t.matched ? <Check className="mt-0.5 h-4 w-4 shrink-0 ink-ok" aria-hidden /> : <X className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" aria-hidden />}
                    <span className="min-w-0">
                      <span className={t.matched ? "font-semibold text-slate-900" : "text-slate-700"}>{t.name}</span>
                      <span className="sr-only">{t.matched ? ": matched" : ": no match"}</span>
                      <span className="text-slate-500"> · {t.reason}</span>
                    </span>
                  </li>
                ))}
              </ol>
            </>
          )}
        </div>
      )}
    </Card>
  );
}
