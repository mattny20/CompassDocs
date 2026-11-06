// The workflow builder's model: pure helpers over HdWorkflowDefinition
// (add, move, remove, group, ungroup, edit by key) and the one-line
// summaries the step cards show. No React here, so the rules can be read
// (and tested) on their own.

import type {
  HdFormField,
  HdTaskStepDef,
  HdWorkflowDefinition,
  HdWorkflowStep,
} from "@/lib/helpdesk/types";

export type AddKind = "approval" | "task" | "parallel" | "wait" | "notify" | "finish";

export const KIND_LABEL: Record<HdWorkflowStep["kind"], string> = {
  approval: "Approval",
  task: "Task",
  parallel: "At the same time",
  wait: "Wait",
  notify: "Notify",
  finish: "Finish",
};

export const ADD_OPTIONS: { kind: AddKind; label: string; hint: string }[] = [
  { kind: "approval", label: "Approval", hint: "A team, the requester's manager or a named person decides" },
  { kind: "task", label: "Task", hint: "A team does something; it gets its own ticket" },
  { kind: "parallel", label: "Tasks at the same time", hint: "Several teams work at once; moves on when all are done" },
  { kind: "wait", label: "Wait", hint: "Until a date in the form, or for a while" },
  { kind: "notify", label: "Notify", hint: "Email and bell to the requester, a person or a team" },
  { kind: "finish", label: "Finish", hint: "Solve the request, and ask how it went" },
];

/** A key no step in the definition uses yet ("s7", "t3"). */
export function freshKey(def: HdWorkflowDefinition, prefix: string): string {
  const used = new Set<string>();
  for (const s of def.steps) {
    used.add(s.key);
    if (s.kind === "parallel") s.steps.forEach((c) => used.add(c.key));
  }
  let n = 1;
  while (used.has(`${prefix}${n}`)) n++;
  return `${prefix}${n}`;
}

export function newStep(def: HdWorkflowDefinition, kind: AddKind, teamId: number | null): HdWorkflowStep {
  const task = (key: string): HdTaskStepDef => ({ key, kind: "task", title: "New task", team_id: teamId ?? 0 });
  switch (kind) {
    case "approval":
      return { key: freshKey(def, "a"), kind: "approval", title: "Manager approves", approver: { kind: "manager" }, on_decline: "close", remind_after_hours: 8 };
    case "task":
      return task(freshKey(def, "t"));
    case "parallel": {
      const k1 = freshKey(def, "t");
      const tmp: HdWorkflowDefinition = { ...def, steps: [...def.steps, task(k1)] };
      return { key: freshKey(def, "g"), kind: "parallel", steps: [task(k1), task(freshKey(tmp, "t"))] };
    }
    case "wait":
      return { key: freshKey(def, "w"), kind: "wait", title: "Wait a day", until: { after_hours: 24 } };
    case "notify":
      return { key: freshKey(def, "n"), kind: "notify", title: "Tell the requester", to: "requester", message: "Hi {{requester.first_name}}, your request #{{ticket.number}} has moved on." };
    case "finish":
      return { key: freshKey(def, "f"), kind: "finish", title: "Solve the request", csat: true };
  }
}

export function insertAt(def: HdWorkflowDefinition, index: number, step: HdWorkflowStep): HdWorkflowDefinition {
  const steps = def.steps.slice();
  steps.splice(index, 0, step);
  return { ...def, steps };
}

/** Find a step (top level or inside a group). */
export function findStep(def: HdWorkflowDefinition, key: string): { step: HdWorkflowStep; index: number; parent: string | null } | null {
  for (let i = 0; i < def.steps.length; i++) {
    const s = def.steps[i];
    if (s.key === key) return { step: s, index: i, parent: null };
    if (s.kind === "parallel") {
      const j = s.steps.findIndex((c) => c.key === key);
      if (j >= 0) return { step: s.steps[j], index: j, parent: s.key };
    }
  }
  return null;
}

export function updateStep(def: HdWorkflowDefinition, key: string, next: HdWorkflowStep): HdWorkflowDefinition {
  return {
    ...def,
    steps: def.steps.map((s) => {
      if (s.key === key) return next;
      if (s.kind === "parallel" && s.steps.some((c) => c.key === key)) {
        return { ...s, steps: s.steps.map((c) => (c.key === key ? (next as HdTaskStepDef) : c)) };
      }
      return s;
    }),
  };
}

export function removeStep(def: HdWorkflowDefinition, key: string): HdWorkflowDefinition {
  const steps: HdWorkflowStep[] = [];
  for (const s of def.steps) {
    if (s.key === key) continue;
    if (s.kind === "parallel" && s.steps.some((c) => c.key === key)) {
      const rest = s.steps.filter((c) => c.key !== key);
      // A group of one is just a task.
      if (rest.length === 1) steps.push(rest[0]);
      else if (rest.length > 1) steps.push({ ...s, steps: rest });
      continue;
    }
    steps.push(s);
  }
  return { ...def, steps };
}

/** Move a step up (-1) or down (+1) among its siblings. */
export function moveStep(def: HdWorkflowDefinition, key: string, dir: -1 | 1): HdWorkflowDefinition {
  const at = findStep(def, key);
  if (!at) return def;
  const swap = <T,>(arr: T[], i: number) => {
    const j = i + dir;
    if (j < 0 || j >= arr.length) return arr;
    const out = arr.slice();
    [out[i], out[j]] = [out[j], out[i]];
    return out;
  };
  if (at.parent === null) return { ...def, steps: swap(def.steps, at.index) };
  return {
    ...def,
    steps: def.steps.map((s) => (s.key === at.parent && s.kind === "parallel" ? { ...s, steps: swap(s.steps, at.index) } : s)),
  };
}

export function canMove(def: HdWorkflowDefinition, key: string, dir: -1 | 1): boolean {
  const at = findStep(def, key);
  if (!at) return false;
  const len = at.parent === null ? def.steps.length : (findStep(def, at.parent)?.step as { steps: unknown[] }).steps.length;
  return at.index + dir >= 0 && at.index + dir < len;
}

/** Add a new task to a parallel group. */
export function addToGroup(def: HdWorkflowDefinition, groupKey: string, teamId: number | null): { def: HdWorkflowDefinition; key: string } {
  const key = freshKey(def, "t");
  return {
    key,
    def: {
      ...def,
      steps: def.steps.map((s) =>
        s.key === groupKey && s.kind === "parallel" ? { ...s, steps: [...s.steps, { key, kind: "task" as const, title: "New task", team_id: teamId ?? 0 }] } : s
      ),
    },
  };
}

/** Take a task out of its group, placing it after the group. */
export function ungroupTask(def: HdWorkflowDefinition, key: string): HdWorkflowDefinition {
  const at = findStep(def, key);
  if (!at || at.parent === null) return def;
  const gi = def.steps.findIndex((s) => s.key === at.parent);
  // removeStep keeps the group (or, left with one task, that task) at gi.
  const removed = removeStep(def, key);
  const steps = removed.steps.slice();
  steps.splice(gi + 1, 0, at.step);
  return { ...removed, steps };
}

export function countSteps(def: HdWorkflowDefinition): number {
  return def.steps.reduce((n, s) => n + (s.kind === "parallel" ? s.steps.length : 1), 0);
}

export function dateFields(form: HdFormField[]): HdFormField[] {
  return form.filter((f) => f.type === "date");
}

export function hoursLabel(h: number): string {
  if (h % 40 === 0 && h >= 40) return h === 40 ? "1 working week" : `${h / 40} working weeks`;
  if (h % 8 === 0 && h >= 8) return h === 8 ? "1 business day" : `${h / 8} business days`;
  if (h % 24 === 0 && h >= 24) return h === 24 ? "1 day" : `${h / 24} days`;
  return h === 1 ? "1 hour" : `${h} hours`;
}

function fieldLabel(form: HdFormField[], key: string): string {
  return form.find((f) => f.key === key)?.label?.toLowerCase() || key.replace(/_/g, " ");
}

/** The card's sub-line ("Any member of HR · reminder after 1 business day"). */
export function stepSummary(s: HdWorkflowStep, names: { team: (id: number) => string; user: (id: number) => string }, form: HdFormField[]): string {
  switch (s.kind) {
    case "approval": {
      const a = s.approver as { kind: string; team_id?: number; user_id?: number };
      const who =
        a.kind === "team" ? `Any member of ${names.team(a.team_id ?? 0)}` : a.kind === "manager" ? "The requester's manager" : a.kind === "user" ? names.user(a.user_id ?? 0) : "The space's owner";
      const remind = s.remind_after_hours ? ` · reminder after ${hoursLabel(s.remind_after_hours)}` : "";
      return `${who}${remind}`;
    }
    case "task": {
      if (!s.due) return names.team(s.team_id);
      if ("after_hours" in s.due) return `Due ${hoursLabel(s.due.after_hours)} after it starts`;
      const off = s.due.offset_days ?? 0;
      const f = fieldLabel(form, s.due.field);
      return off === 0 ? `Due on the ${f}` : `Due ${Math.abs(off)} ${Math.abs(off) === 1 ? "day" : "days"} ${off < 0 ? "before" : "after"} the ${f}`;
    }
    case "parallel":
      return `${s.steps.length} tasks; moves on when all are done`;
    case "wait":
      return "field" in s.until ? `Until the ${fieldLabel(form, s.until.field)}, then move on` : `For ${hoursLabel(s.until.after_hours)}, then move on`;
    case "notify": {
      const to = s.to === "requester" ? "The requester" : "user_id" in s.to ? names.user(s.to.user_id) : names.team(s.to.team_id);
      return `${to} · email and bell`;
    }
    case "finish":
      return s.csat ? "Ask the requester how it went" : "Solve without a survey";
  }
}
