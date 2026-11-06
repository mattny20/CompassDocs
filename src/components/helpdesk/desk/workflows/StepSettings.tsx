"use client";

// The builder's right-hand panel: the selected step's settings, one form
// per kind (Approval, Task, Wait, Notify, Finish, a parallel group, and the
// "Starts when" trigger). Every change goes straight into the working
// draft; the builder's Save draft / Publish changes send it.
//
// Multi-team additions (agent M, components in ../workflow-multi): every
// step has an "Only if…" section, and a task adds "Route to team by
// answer", "If the team can't do it" and "Hand-off fields". `def` (the
// working definition) lets a rule test an earlier task's hand-off fields;
// `coordinatorTeamId` (the request type's team) names who takes a stopped
// request back. Both are optional: without them the panel offers the form
// and the directory only, and says "the request's team".

import { useId } from "react";
import Link from "next/link";
import { Plus, Ungroup } from "lucide-react";
import { Button } from "@/components/Button";
import { EYEBROW_TEXT } from "@/components/Heading";
import { EntityPicker } from "@/components/EntityPicker";
import { Field, Select, TextInput, Textarea, Toggle } from "@/components/form";
import { RadioCards } from "@/components/PolicyFields";
import type {
  HdApprovalStepDef,
  HdFormField,
  HdNotifyStepDef,
  HdParallelStepDef,
  HdRequestType,
  HdTaskStepDef,
  HdWaitStepDef,
  HdWorkflowDefinition,
  HdWorkflowStep,
  HdFinishStepDef,
} from "@/lib/helpdesk/types";
import { MACRO_PLACEHOLDERS } from "../ticket/MacroPicker";
import { personOption, type PersonLite } from "../people";
import { KIND_LABEL, dateFields } from "./model";
import { countedHoursLabel, countMode } from "@/lib/helpdesk/business-waits-shared";
import type { HdCountDef } from "@/lib/helpdesk/types";
import { CountSetting } from "./CountSetting";
import type { HdStepCondition, HdTaskStepDefB, HdWorkflowStepB } from "../workflow-multi/contract";
import { conditionFields, routeFields } from "../workflow-multi/conditions";
import { OnlyIfEditor } from "../workflow-multi/OnlyIfEditor";
import { CantDoSetting, OutputsEditor, RouteEditor } from "../workflow-multi/TaskExtras";
import { TaskChecklistsSetting } from "../checklists/TaskChecklistsSetting";

const REMIND = [0, 4, 8, 16, 40];
const AFTER = [4, 8, 24, 48, 72, 120, 168];

interface Common {
  teams: { id: number; name: string }[];
  people: PersonLite[];
  form: HdFormField[];
  onChange: (next: HdWorkflowStep) => void;
  /** The request type's team: whose calendar a wait or a reminder counts by default (1.19.1). */
  rtTeamId?: number | null;
}

/** A step with its count fields replaced (1.19.1): calendar drops them, so the stored step stays as before. */
function withCount<T extends HdWorkflowStep>(step: T, count: HdCountDef): T {
  const { count: _c, count_team_id: _t, ...rest } = step as T & HdCountDef;
  return { ...rest, ...count } as T;
}

export function StepSettings({
  step,
  inGroup,
  onUngroup,
  onAddToGroup,
  def,
  coordinatorTeamId,
  ...c
}: Common & {
  step: HdWorkflowStep;
  inGroup: boolean;
  onUngroup: () => void;
  onAddToGroup: () => void;
  /** The working definition (for earlier tasks' hand-off fields in Only if). */
  def?: HdWorkflowDefinition | null;
  /** The request type's team: who takes the request back when a task can't be done. */
  coordinatorTeamId?: number | null;
}) {
  const titleId = useId();
  const title = "title" in step ? step.title ?? "" : "";
  const sb = step as HdWorkflowStepB;
  const task = step.kind === "task" ? (step as HdTaskStepDefB) : null;
  const patch = (extra: Partial<HdTaskStepDefB> & { when?: HdStepCondition }) => {
    const next = { ...sb, ...extra } as Record<string, unknown>;
    for (const k of Object.keys(extra)) if (next[k] === undefined) delete next[k];
    c.onChange(next as unknown as HdWorkflowStep);
  };
  const coordinator = c.teams.find((t) => t.id === coordinatorTeamId)?.name ?? null;
  return (
    <div>
      <p className={EYEBROW_TEXT}>{inGroup ? "Task · at the same time" : KIND_LABEL[step.kind]}</p>
      <h2 id={titleId} className="mt-1 text-base font-semibold text-slate-900">
        {title || KIND_LABEL[step.kind]}
      </h2>
      <div className="mt-4 space-y-4">
        {step.kind !== "parallel" && (
          <Field label="Step name" help="What people see on the request's progress.">
            <TextInput value={title} maxLength={200} onChange={(e) => c.onChange({ ...step, title: e.target.value } as HdWorkflowStep)} />
          </Field>
        )}
        {step.kind === "approval" && <ApprovalSettings step={step} rtTeamId={coordinatorTeamId ?? null} {...c} />}
        {step.kind === "task" && <TaskSettings step={step} {...c} />}
        {step.kind === "parallel" && <GroupSettings step={step} onAdd={onAddToGroup} {...c} />}
        {step.kind === "wait" && <WaitSettings step={step} rtTeamId={coordinatorTeamId ?? null} {...c} />}
        {step.kind === "notify" && <NotifySettings step={step} {...c} />}
        {step.kind === "finish" && <FinishSettings step={step} {...c} />}
        {task && (
          <>
            <RouteEditor step={task} fields={routeFields(c.form)} teams={c.teams} onChange={(route) => patch({ route })} />
            <CantDoSetting step={task} coordinator={coordinator} onChange={(on_cant_do) => patch({ on_cant_do })} />
            <OutputsEditor step={task} onChange={(outputs) => patch({ outputs })} />
            {/* 1.19.2: checklists on the task's ticket (agent W3). */}
            <TaskChecklistsSetting step={task} onChange={(checklist_ids) => patch({ checklist_ids })} />
          </>
        )}
        <OnlyIfEditor
          value={sb.when}
          fields={conditionFields(c.form, def, step.key)}
          stepLabel={step.kind === "parallel" ? "these tasks" : step.kind === "task" ? "this task" : "this step"}
          onChange={(when) => patch({ when })}
        />
        {inGroup && (
          <Button variant="secondary" size="sm" icon={<Ungroup />} onClick={onUngroup}>
            Take out of the group
          </Button>
        )}
      </div>
    </div>
  );
}

function ApprovalSettings({ step, teams, people, onChange, rtTeamId }: Common & { step: HdApprovalStepDef }) {
  const a = step.approver as { kind: string; team_id?: number; user_id?: number };
  const kind = a.kind as "team" | "manager" | "user" | "space_owner";
  const teamName = teams.find((t) => t.id === a.team_id)?.name;
  const person = people.find((p) => p.id === a.user_id);
  const set = (approver: unknown) => onChange({ ...step, approver } as HdApprovalStepDef);
  const options: { value: typeof kind; label: string; description: string; extra?: React.ReactNode }[] = [
    {
      value: "team",
      label: "A team",
      description: teamName ? `${teamName} · any one member` : "Any one member of the team decides",
      extra: (
        <Field label="Team">
          <Select dense value={a.team_id ?? ""} onChange={(e) => set({ kind: "team", team_id: Number(e.target.value) })}>
            <option value="" disabled>
              Choose a team
            </option>
            {teams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </Select>
        </Field>
      ),
    },
    { value: "manager", label: "The requester's manager", description: "From the directory; the team's leads stand in when there is none" },
    {
      value: "user",
      label: "A named person",
      description: person ? person.name || person.username : "Always the same person",
      extra: (
        <EntityPicker options={people.map(personOption)} onPick={(id) => set({ kind: "user", user_id: id })} label="Approver" placeholder="Search people…" />
      ),
    },
  ];
  if (kind === "space_owner") {
    options.push({ value: "space_owner", label: "The space's owner", description: "For access requests: whoever manages the space" });
  }
  return (
    <>
      <fieldset>
        <legend className="mb-2 text-sm font-semibold text-slate-800">Who approves</legend>
        <RadioCards
          label="Who approves"
          name={`approver-${step.key}`}
          value={kind}
          onChange={(k) => {
            if (k === "team") set({ kind: "team", team_id: a.team_id ?? teams[0]?.id ?? 0 });
            else if (k === "user") set({ kind: "user", user_id: a.user_id ?? 0 });
            else set({ kind: k });
          }}
          options={options}
        />
      </fieldset>
      <Field label="If they decline">
        <Select value={step.on_decline} onChange={(e) => onChange({ ...step, on_decline: e.target.value as "close" | "continue" })}>
          <option value="close">Close the request and tell the requester why</option>
          <option value="continue">Carry on with the next step anyway</option>
        </Select>
      </Field>
      <Field label="Remind them after">
        <Select
          value={step.remind_after_hours ?? 0}
          onChange={(e) => {
            const h = Number(e.target.value) || undefined;
            // No reminder, nothing to count.
            onChange(h ? { ...step, remind_after_hours: h } : withCount({ ...step, remind_after_hours: undefined }, {}));
          }}
        >
          {REMIND.map((h) => (
            <option key={h} value={h}>
              {h ? countedHoursLabel(h, countMode(step)) : "Don't remind"}
            </option>
          ))}
        </Select>
      </Field>
      {!!step.remind_after_hours && (
        <CountSetting
          stepKey={step.key}
          value={step}
          unit="hours"
          teams={teams}
          defaultTeamId={rtTeamId ?? null}
          defaultLabel="The request type's team"
          onChange={(count) => onChange(withCount(step, count))}
        />
      )}
      <p className="text-xs text-slate-500">
        Approvers see it in Needs your attention on their CompassDocs dashboard, by email and in the bell, and approve in one click.
      </p>
    </>
  );
}

type DueMode = "none" | "field" | "after";

function TaskSettings({ step, teams, form, onChange }: Common & { step: HdTaskStepDef }) {
  const dates = dateFields(form);
  const mode: DueMode = !step.due ? "none" : "after_hours" in step.due ? "after" : "field";
  const off = step.due && "field" in step.due ? step.due.offset_days ?? 0 : 0;
  return (
    <>
      <Field
        label="Team"
        help={(step as HdTaskStepDefB).route ? "Used when no answer in Route to team matches." : "The task becomes a ticket in this team's queue."}
      >
        <Select value={step.team_id || ""} onChange={(e) => onChange({ ...step, team_id: Number(e.target.value) })}>
          <option value="" disabled>
            Choose a team
          </option>
          {teams.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Due">
        <Select
          value={mode}
          onChange={(e) => {
            const m = e.target.value as DueMode;
            if (m === "none") onChange(withCount({ ...step, due: undefined }, {}));
            else if (m === "after") onChange({ ...step, due: { after_hours: 24 } });
            else onChange({ ...step, due: { field: dates[0]?.key ?? "", offset_days: -1 } });
          }}
        >
          <option value="none">No due date</option>
          {dates.length > 0 && <option value="field">Relative to a date in the form</option>}
          <option value="after">A while after it starts</option>
        </Select>
      </Field>
      {mode === "field" && step.due && "field" in step.due && (
        <div className="grid grid-cols-2 gap-3">
          <Field label="Days">
            <Select
              value={off}
              onChange={(e) => onChange({ ...step, due: { field: (step.due as { field: string }).field, offset_days: Number(e.target.value) } })}
            >
              {[-10, -7, -5, -3, -2, -1, 0, 1, 2, 3, 5, 7].map((d) => (
                <option key={d} value={d}>
                  {d === 0 ? "On the day" : `${Math.abs(d)} ${Math.abs(d) === 1 ? "day" : "days"} ${d < 0 ? "before" : "after"}`}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="The date">
            <Select value={step.due.field} onChange={(e) => onChange({ ...step, due: { field: e.target.value, offset_days: off } })}>
              {dates.map((f) => (
                <option key={f.key} value={f.key}>
                  {f.label}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      )}
      {mode === "after" && step.due && "after_hours" in step.due && (
        <Field label="Due after">
          <Select value={step.due.after_hours} onChange={(e) => onChange({ ...step, due: { after_hours: Number(e.target.value) } })}>
            {AFTER.map((h) => (
              <option key={h} value={h}>
                {countedHoursLabel(h, countMode(step))}
              </option>
            ))}
          </Select>
        </Field>
      )}
      {step.due && (
        <CountSetting
          stepKey={step.key}
          value={step}
          unit={"field" in step.due ? "days" : "hours"}
          teams={teams}
          defaultTeamId={step.team_id || null}
          defaultLabel="The task's team"
          example={
            "field" in step.due
              ? { offset: off, field: form.find((f) => f.key === (step.due as { field: string }).field)?.label || "The date", kind: "due" }
              : null
          }
          onChange={(count) => onChange(withCount(step, count))}
        />
      )}
      <Field label="What to do (optional)" help="Goes on the task's ticket for the team.">
        <Textarea value={step.description ?? ""} maxLength={4000} className="h-24" onChange={(e) => onChange({ ...step, description: e.target.value })} />
      </Field>
    </>
  );
}

function GroupSettings({ step, onAdd, teams }: Common & { step: HdParallelStepDef; onAdd: () => void }) {
  return (
    <>
      <p className="text-sm text-slate-600">
        These tasks start together and the workflow moves on when every one is done. Select a task to change it.
      </p>
      <ul className="space-y-1 text-sm text-slate-700">
        {step.steps.map((t) => (
          <li key={t.key}>
            {t.title} <span className="text-slate-500">· {teams.find((x) => x.id === t.team_id)?.name ?? "no team"}</span>
          </li>
        ))}
      </ul>
      <Button variant="secondary" size="sm" icon={<Plus />} onClick={onAdd} disabled={step.steps.length >= 10}>
        Add a task
      </Button>
    </>
  );
}

const WAIT_DAYS = [0, 1, 2, 3, 5, 7, 10];

function WaitSettings({ step, form, teams, onChange, rtTeamId }: Common & { step: HdWaitStepDef }) {
  const dates = dateFields(form);
  const byField = "field" in step.until;
  const mode = countMode(step);
  const off = "field" in step.until ? step.until.offset_days ?? 0 : 0;
  const days = Math.abs(off);
  const field = "field" in step.until ? step.until.field : "";
  const setUntil = (f: string, offset: number) => onChange({ ...step, until: offset ? { field: f, offset_days: offset } : { field: f } });
  return (
    <>
      <Field label="Wait">
        <Select
          value={byField ? "field" : "after"}
          onChange={(e) => onChange({ ...step, until: e.target.value === "field" ? { field: dates[0]?.key ?? "" } : { after_hours: 24 } })}
        >
          {dates.length > 0 && <option value="field">Until a date in the form</option>}
          <option value="after">For a while</option>
        </Select>
      </Field>
      {"field" in step.until ? (
        <fieldset>
          <legend className="mb-1 text-sm font-medium text-slate-700">Wait until</legend>
          <div className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-2">
            <Select
              aria-label="How many days"
              value={days}
              onChange={(e) => {
                const n = Number(e.target.value);
                setUntil(field, n === 0 ? 0 : off > 0 ? n : -n);
              }}
            >
              {WAIT_DAYS.map((d) => (
                <option key={d} value={d}>
                  {d === 0 ? "On the day" : `${d} ${d === 1 ? "day" : "days"}`}
                </option>
              ))}
            </Select>
            <Select
              aria-label="Before or after which date"
              value={days === 0 ? `on:${field}` : `${off < 0 ? "before" : "after"}:${field}`}
              onChange={(e) => {
                const [dir, f] = e.target.value.split(":");
                setUntil(f, days === 0 ? 0 : dir === "after" ? days : -days);
              }}
            >
              {dates.flatMap((f) =>
                days === 0
                  ? [
                      <option key={`on:${f.key}`} value={`on:${f.key}`}>
                        {f.label}
                      </option>,
                    ]
                  : [
                      <option key={`before:${f.key}`} value={`before:${f.key}`}>
                        before {f.label}
                      </option>,
                      <option key={`after:${f.key}`} value={`after:${f.key}`}>
                        after {f.label}
                      </option>,
                    ]
              )}
            </Select>
          </div>
          <p className="mt-1 text-xs text-slate-500">
            {mode === "business" ? "Moves on when that business day opens." : "Then move on, even on a weekend."}
          </p>
        </fieldset>
      ) : (
        <Field label="For">
          <Select value={step.until.after_hours} onChange={(e) => onChange({ ...step, until: { after_hours: Number(e.target.value) } })}>
            {AFTER.map((h) => (
              <option key={h} value={h}>
                {countedHoursLabel(h, mode)}
              </option>
            ))}
          </Select>
        </Field>
      )}
      <CountSetting
        stepKey={step.key}
        value={step}
        unit={byField ? "days" : "hours"}
        teams={teams}
        defaultTeamId={rtTeamId ?? null}
        defaultLabel="The request type's team"
        example={byField ? { offset: off, field: dates.find((f) => f.key === field)?.label || "The date", kind: "wait" } : null}
        onChange={(count) => onChange(withCount(step, count))}
      />
    </>
  );
}

function NotifySettings({ step, teams, people, onChange }: Common & { step: HdNotifyStepDef }) {
  const to = step.to === "requester" ? "requester" : "user_id" in step.to ? "user" : "team";
  const person = typeof step.to === "object" && "user_id" in step.to ? people.find((p) => p.id === (step.to as { user_id: number }).user_id) : undefined;
  return (
    <>
      <Field label="Tell">
        <Select
          value={to}
          onChange={(e) => {
            const v = e.target.value;
            onChange({ ...step, to: v === "requester" ? "requester" : v === "team" ? { team_id: teams[0]?.id ?? 0 } : { user_id: 0 } });
          }}
        >
          <option value="requester">The requester</option>
          <option value="team">A team</option>
          <option value="user">A named person</option>
        </Select>
      </Field>
      {typeof step.to === "object" && "team_id" in step.to && (
        <Field label="Team">
          <Select value={step.to.team_id} onChange={(e) => onChange({ ...step, to: { team_id: Number(e.target.value) } })}>
            {teams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </Select>
        </Field>
      )}
      {to === "user" && (
        <div>
          <p className="mb-1 text-xs font-medium text-slate-500">Person{person ? `: ${person.name || person.username}` : ""}</p>
          <EntityPicker options={people.map(personOption)} onPick={(id) => onChange({ ...step, to: { user_id: id } })} label="Person to tell" placeholder="Search people…" />
        </div>
      )}
      <Field label="Message" help={`Markdown. Placeholders: ${MACRO_PLACEHOLDERS.join(", ")}, and {{answers.<field>}} for a form answer.`}>
        <Textarea value={step.message} maxLength={4000} className="h-32" onChange={(e) => onChange({ ...step, message: e.target.value })} />
      </Field>
      <p className="text-xs text-slate-500">Sent by email and in the bell.</p>
    </>
  );
}

function FinishSettings({ step, onChange }: Common & { step: HdFinishStepDef }) {
  return (
    <Toggle
      label="Ask how it went"
      help="The requester gets the one-question satisfaction survey when the request is solved (if surveys are on)."
      checked={!!step.csat}
      onChange={(v) => onChange({ ...step, csat: v })}
      size="full"
    />
  );
}

/** The "Starts when" panel. */
export function TriggerSettings({
  def,
  types,
  linked,
  onChange,
}: {
  def: HdWorkflowDefinition;
  types: HdRequestType[];
  linked: { id: number; title: string }[];
  onChange: (def: HdWorkflowDefinition) => void;
}) {
  return (
    <div>
      <p className={EYEBROW_TEXT}>Starts when</p>
      <h2 className="mt-1 text-base font-semibold text-slate-900">Someone sends a request form</h2>
      <div className="mt-4 space-y-4">
        <Field label="Request form" help="Its questions are what the steps can use: a start date to wait for, a manager to ask.">
          <Select
            value={def.trigger.request_type_id ?? ""}
            onChange={(e) => onChange({ ...def, trigger: { request_type_id: e.target.value ? Number(e.target.value) : null } })}
          >
            <option value="">None chosen</option>
            {types.map((t) => (
              <option key={t.id} value={t.id}>
                {t.title}
              </option>
            ))}
          </Select>
        </Field>
        <div className="text-sm text-slate-600">
          {linked.length ? (
            <>
              Started by: {linked.map((l) => l.title).join(", ")}.
            </>
          ) : (
            "No request type starts this workflow yet."
          )}{" "}
          <Link href="/desk/settings/request-types" className="link">
            Request types
          </Link>
        </div>
      </div>
    </div>
  );
}
