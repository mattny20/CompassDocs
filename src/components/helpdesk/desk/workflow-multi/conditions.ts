// Multi-team workflows: the builder's pure helpers for a step's "Only if",
// a task's "Route to team by answer" and its hand-off fields. What a rule
// can test (the request form's questions, the requester's directory entry,
// an earlier task's hand-off fields), which operators fit each kind of
// field, and the plain-language sentences the settings panel and the step
// cards show ("Only if Office is London and Needs a laptop is Yes").
// No React here.

import type { HdFormField, HdWorkflowDefinition } from "@/lib/helpdesk/types";
import {
  REQUESTER_FIELDS,
  type HdConditionOp,
  type HdConditionRule,
  type HdConditionSource,
  type HdStepCondition,
  type HdTaskOutputDef,
  type HdTaskRoute,
  type HdTaskStepDefB,
  type HdWorkflowStepB,
} from "./contract";

/** What a value is, for choosing operators and the value control. */
export type FieldKind = "text" | "choice" | "bool" | "number" | "date" | "person";

export interface FieldChoice {
  source: HdConditionSource;
  field: string;
  label: string;
  kind: FieldKind;
  options?: { value: string; label: string }[];
  /** The picker's group heading. */
  group: string;
}

export const SOURCE_GROUP: Record<HdConditionSource, string> = {
  answer: "The request form",
  requester: "The requester's directory entry",
  output: "Earlier steps' hand-off fields",
};

export const OP_LABEL: Record<HdConditionOp, string> = {
  equals: "is",
  not_equals: "is not",
  in: "is one of",
  contains: "contains",
  is_empty: "is empty",
  not_empty: "is filled in",
  is_true: "is Yes",
  is_false: "is No",
};

const OPS: Record<FieldKind, HdConditionOp[]> = {
  text: ["equals", "not_equals", "contains", "is_empty", "not_empty"],
  choice: ["equals", "not_equals", "in", "is_empty", "not_empty"],
  bool: ["is_true", "is_false"],
  number: ["equals", "not_equals", "is_empty", "not_empty"],
  date: ["is_empty", "not_empty", "equals"],
  person: ["is_empty", "not_empty"],
};

export const opsFor = (kind: FieldKind): HdConditionOp[] => OPS[kind];

/** Operators that take no value. */
export const opTakesValue = (op: HdConditionOp) => !["is_empty", "not_empty", "is_true", "is_false"].includes(op);

export function formFieldKind(f: Pick<HdFormField, "type" | "options">): FieldKind {
  switch (f.type) {
    case "checkbox":
      return "bool";
    case "select":
    case "choice":
      return f.options?.length ? "choice" : "text";
    case "number":
      return "number";
    case "date":
      return "date";
    case "user":
      return "person";
    default:
      return "text";
  }
}

export function outputKind(o: Pick<HdTaskOutputDef, "type" | "options">): FieldKind {
  switch (o.type) {
    case "yes_no":
      return "bool";
    case "select":
      return o.options?.length ? "choice" : "text";
    case "number":
      return "number";
    case "date":
      return "date";
    default:
      return "text";
  }
}

const stepTitle = (s: { title?: string; key: string }) => s.title?.trim() || s.key;

/**
 * The tasks whose hand-off fields a step may test: every task that
 * finishes before it. Tasks in the same parallel group run at the same
 * time, so they are not "earlier" for one another.
 */
export function earlierTasks(def: HdWorkflowDefinition | null | undefined, stepKey: string): HdTaskStepDefB[] {
  if (!def) return [];
  const steps = def.steps as HdWorkflowStepB[];
  const out: HdTaskStepDefB[] = [];
  for (const s of steps) {
    if (s.key === stepKey) break;
    if (s.kind === "parallel") {
      if (s.steps.some((c) => c.key === stepKey)) break;
      out.push(...s.steps);
    } else if (s.kind === "task") out.push(s);
  }
  return out;
}

/** Every field a rule on this step can test, in picker order. */
export function conditionFields(form: HdFormField[], def: HdWorkflowDefinition | null | undefined, stepKey: string): FieldChoice[] {
  const out: FieldChoice[] = [];
  for (const f of form) {
    out.push({ source: "answer", field: f.key, label: f.label || f.key, kind: formFieldKind(f), options: f.options?.map((o) => ({ value: o.value, label: o.label })), group: SOURCE_GROUP.answer });
  }
  for (const r of REQUESTER_FIELDS) out.push({ source: "requester", field: r.key, label: r.label, kind: "text", group: SOURCE_GROUP.requester });
  for (const t of earlierTasks(def, stepKey)) {
    for (const o of t.outputs ?? []) {
      out.push({ source: "output", field: `${t.key}.${o.key}`, label: `${stepTitle(t)}: ${o.label || o.key}`, kind: outputKind(o), options: o.options, group: SOURCE_GROUP.output });
    }
  }
  return out;
}

/** Fields a route can sort on: form choices and text, and the directory. */
export function routeFields(form: HdFormField[]): FieldChoice[] {
  return conditionFields(form, null, "").filter((f) => f.source !== "output" && (f.kind === "choice" || f.kind === "text"));
}

export const fieldId = (f: { source: string; field: string }) => `${f.source}:${f.field}`;

export function findField(fields: FieldChoice[], r: { source: string; field: string }): FieldChoice | undefined {
  return fields.find((f) => f.source === r.source && f.field === r.field);
}

function valueText(f: FieldChoice | undefined, v: string): string {
  return f?.options?.find((o) => o.value === v)?.label ?? v;
}

function quote(s: string): string {
  return s ? s : "(blank)";
}

/** "Office is London", "Laptop is one of Standard or Developer". */
export function ruleSentence(r: HdConditionRule, fields: FieldChoice[]): string {
  const f = findField(fields, r);
  const name = f?.label ?? (r.source === "output" ? r.field.replace(".", ": ") : r.field.replace(/_/g, " "));
  if (!opTakesValue(r.op)) return `${name} ${OP_LABEL[r.op]}`;
  const vals = (Array.isArray(r.value) ? r.value : [r.value ?? ""]).map((v) => valueText(f, String(v)));
  if (r.op === "in") return `${name} is ${vals.length > 1 ? `${vals.slice(0, -1).join(", ")} or ${vals[vals.length - 1]}` : quote(vals[0] ?? "")}`;
  if (r.op === "contains") return `${name} contains "${vals[0] ?? ""}"`;
  return `${name} ${OP_LABEL[r.op]} ${quote(vals[0] ?? "")}`;
}

/** "Only if Office is London and Needs a laptop is Yes"; "" when there is no rule. */
export function conditionSummary(c: HdStepCondition | undefined, fields: FieldChoice[]): string {
  if (!c || !c.rules.length) return "";
  const parts = c.rules.map((r) => ruleSentence(r, fields));
  return `Only if ${parts.join(c.match === "any" ? " or " : " and ")}`;
}

/** A rule that cannot be checked yet (no field, or a value still to fill). */
export function ruleProblem(r: HdConditionRule, fields: FieldChoice[]): string | null {
  if (!r.field) return "Choose what to check.";
  if (!findField(fields, r)) return r.source === "output" ? "That hand-off field is no longer earlier in the workflow." : "That question is no longer on the form.";
  if (!opTakesValue(r.op)) return null;
  const v = r.value;
  if (Array.isArray(v) ? v.length === 0 : !String(v ?? "").trim()) return r.op === "in" ? "Pick at least one value." : "Fill in a value.";
  return null;
}

/** "By Office: London → Facilities UK, Paris → Facilities FR; anything else → Facilities". */
export function routeSummary(route: HdTaskRoute | undefined, fields: FieldChoice[], teamName: (id: number) => string, taskTeamId: number): string {
  if (!route) return "";
  const f = findField(fields, route);
  const name = f?.label ?? route.field;
  const rows = route.map.filter((m) => m.value !== "").map((m) => `${valueText(f, m.value)} → ${teamName(m.team_id)}`);
  const otherwise = teamName(route.fallback_team_id || taskTeamId);
  return `By ${name}: ${rows.length ? rows.join(", ") : "no rows yet"}; anything else → ${otherwise}`;
}

/** A field key from a label ("Badge number" → "badge_number"), unique among `used`. */
export function keyFromLabel(label: string, used: Iterable<string>): string {
  const base =
    label
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^\p{L}\p{N}]+/gu, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 40) || "field";
  const taken = new Set(used);
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}_${n}`)) n++;
  return `${base}_${n}`;
}

/** Options typed one per line → {value,label}. Values keep the earlier ones where the label is unchanged. */
export function optionsFromLines(text: string, prev: { value: string; label: string }[] = []): { value: string; label: string }[] {
  const out: { value: string; label: string }[] = [];
  const used: string[] = [];
  for (const raw of text.split("\n")) {
    const label = raw.trim();
    if (!label) continue;
    const keep = prev.find((p) => p.label === label && !used.includes(p.value));
    const value = keep?.value ?? keyFromLabel(label, used);
    used.push(value);
    out.push({ value, label });
    if (out.length >= 30) break;
  }
  return out;
}

export const optionsToLines = (opts: { label: string }[] | undefined) => (opts ?? []).map((o) => o.label).join("\n");

/** The placeholder a later step's message uses for a hand-off field. */
export const outputPlaceholder = (stepKey: string, key: string) => `{{outputs.${stepKey}.${key}}}`;
