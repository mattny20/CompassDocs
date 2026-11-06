// Helpdesk 1.19.0: workflow definitions (the builder's data). A workflow is
// a list of steps (Approval, Task, a parallel group of Tasks, Wait, Notify,
// Finish) that runs when someone sends a request of a type linked to it
// (hd_request_types.workflow_id; lib/helpdesk/engine runs it).
//
// Versioning: `definition` is what new runs pin, `draft` holds unpublished
// edits (NULL = none). Saving writes the draft; publishing checks the draft
// again (references included), copies it into `definition` and bumps
// `version`. A run snapshots the definition it started with
// (hd_workflow_runs.current.definition), so publishing never changes a
// request that is already on its way.
//
// The test run (simulateWorkflow) walks a definition with sample answers
// and says what each step would do, who would approve, when tasks would be
// due and waits would end. It reads (team names, the manager from the
// directory) and never writes.
//
// Server-only.

import "server-only";
import { slugify } from "../db";
import { hq, hqOne } from "./db-core";
import type { HdQueryable } from "./db-core";
import { answerText, isIsoDate } from "./request-types";
import type { Checked } from "./request-types";
import { HD_CONDITION_OPS, HD_REQUESTER_FIELDS } from "./types";
import { checkCount, countedHoursLabel, countedReminderAt, countedTaskDue, countedWaitUntil, countMode, shiftBusinessDays, shortDate } from "./business-waits-shared";
import type {
  HdApproverDefB,
  HdConditionOp,
  HdConditionRule,
  HdOutputValue,
  HdStepCondition,
  HdStepExtrasB,
  HdTaskOutputDef,
  HdTaskOutputType,
  HdTaskRoute,
  HdTaskStepDefB,
  HdWorkflowDefinitionB,
  HdWorkflowStepB,
} from "./types";
import type {
  HdApprovalStepDef,
  HdApproverDef,
  HdDueDef,
  HdFinishStepDef,
  HdFormAnswers,
  HdFormField,
  HdNotifyStepDef,
  HdParallelStepDef,
  HdTaskStepDef,
  HdWaitStepDef,
  HdWorkflow,
  HdWorkflowDefinition,
  HdWorkflowStep,
} from "./types";

export const WORKFLOW_LIMITS = {
  steps: 30,
  parallel: 10,
  key: 40,
  title: 200,
  description: 4_000,
  message: 4_000,
  remindHours: 24 * 30,
  afterHours: 24 * 365,
  offsetDays: 365,
  workflowTitle: 120,
  workflowDescription: 500,
  slug: 60,
} as const;

const KEY_RE = /^[a-z0-9][a-z0-9_-]*$/;
const FIELD_RE = /^[a-z][a-z0-9_]*$/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const posInt = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v > 0 ? v : null);

export const EMPTY_DEFINITION: HdWorkflowDefinition = { trigger: {}, steps: [] };

// --- Validation (shape) -----------------------------------------------------------

function checkDue(raw: unknown, where: string): Checked<HdDueDef | undefined> {
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  if (!isObj(raw)) return { ok: false, error: `${where}: the due date is a form field or a number of hours.` };
  if (raw.field !== undefined) {
    const field = str(raw.field);
    if (!FIELD_RE.test(field)) return { ok: false, error: `${where}: the due date's field is a form field key.` };
    const off = raw.offset_days === undefined || raw.offset_days === null ? 0 : raw.offset_days;
    if (typeof off !== "number" || !Number.isInteger(off) || Math.abs(off) > WORKFLOW_LIMITS.offsetDays) {
      return { ok: false, error: `${where}: the days before or after are a whole number up to ${WORKFLOW_LIMITS.offsetDays}.` };
    }
    return { ok: true, value: off ? { field, offset_days: off } : { field } };
  }
  const h = raw.after_hours;
  if (typeof h !== "number" || !Number.isInteger(h) || h < 1 || h > WORKFLOW_LIMITS.afterHours) {
    return { ok: false, error: `${where}: the hours are a whole number from 1 to ${WORKFLOW_LIMITS.afterHours}.` };
  }
  return { ok: true, value: { after_hours: h } };
}

function checkApprover(raw: unknown, where: string): Checked<HdApproverDef> {
  if (!isObj(raw)) return { ok: false, error: `${where}: choose who approves.` };
  if (raw.kind === "manager") return { ok: true, value: { kind: "manager" } };
  // The "Request access" approver (HdApproverDefB in ./types): the space's owner, else whoever manages space access.
  if (raw.kind === "space_owner") return { ok: true, value: { kind: "space_owner" } as HdApproverDefB as HdApproverDef };
  if (raw.kind === "team") {
    const id = posInt(raw.team_id);
    return id ? { ok: true, value: { kind: "team", team_id: id } } : { ok: false, error: `${where}: pick the team that approves.` };
  }
  if (raw.kind === "user") {
    const id = posInt(raw.user_id);
    return id ? { ok: true, value: { kind: "user", user_id: id } } : { ok: false, error: `${where}: pick the person who approves.` };
  }
  return { ok: false, error: `${where}: the approver is a team, the requester's manager, a named person or the space's owner.` };
}

function checkTitle(raw: unknown, where: string): Checked<string> {
  const t = str(raw);
  if (!t || t.length > WORKFLOW_LIMITS.title) return { ok: false, error: `${where} needs a title (at most ${WORKFLOW_LIMITS.title} characters).` };
  return { ok: true, value: t };
}

function checkTask(raw: Record<string, unknown>, key: string, where: string): Checked<HdTaskStepDef> {
  const title = checkTitle(raw.title, where);
  if (!title.ok) return title;
  const team = posInt(raw.team_id);
  if (!team) return { ok: false, error: `${where}: pick the team that does it.` };
  const due = checkDue(raw.due, where);
  if (!due.ok) return due;
  const description = str(raw.description);
  if (description.length > WORKFLOW_LIMITS.description) return { ok: false, error: `${where}: the description is longer than ${WORKFLOW_LIMITS.description} characters.` };
  const step: HdTaskStepDefB = { key, kind: "task", title: title.value, team_id: team };
  if (due.value) step.due = due.value;
  if (description) step.description = description;
  const when = checkWhen(raw.when, where);
  if (!when.ok) return when;
  if (when.value) step.when = when.value;
  const route = checkRoute(raw.route, where);
  if (!route.ok) return route;
  if (route.value) step.route = route.value;
  if (raw.on_cant_do !== undefined && raw.on_cant_do !== null) {
    if (raw.on_cant_do !== "stop" && raw.on_cant_do !== "continue") return { ok: false, error: `${where}: if it can't be done, stop for the coordinating team or carry on.` };
    step.on_cant_do = raw.on_cant_do;
  }
  const outputs = checkOutputs(raw.outputs, where);
  if (!outputs.ok) return outputs;
  if (outputs.value) step.outputs = outputs.value;
  // How the due counts (1.19.1): only with a due date to count.
  const count = checkCount(raw, where);
  if (!count.ok) return count;
  if (step.due) Object.assign(step, count.value);
  return { ok: true, value: step as HdTaskStepDef };
}

// --- Conditions, routes and hand-offs (shape) ------------------------------------------

const REQUESTER_FIELD_RE = /^[a-z][a-z0-9_]*$/;
const OUTPUT_REF_RE = /^[a-z0-9][a-z0-9_-]*\.[a-z][a-z0-9_]*$/;
const VALUE_OPS = new Set<HdConditionOp>(["equals", "not_equals", "in", "contains"]);

function checkRule(raw: unknown, where: string): Checked<HdConditionRule> {
  if (!isObj(raw)) return { ok: false, error: `${where}: a condition is a source, a field and a test.` };
  const source = raw.source;
  if (source !== "answer" && source !== "requester" && source !== "output") return { ok: false, error: `${where}: a condition reads an answer, the requester or an earlier task's hand-off.` };
  const field = str(raw.field);
  const fieldOk = source === "output" ? OUTPUT_REF_RE.test(field) : source === "answer" ? FIELD_RE.test(field) : REQUESTER_FIELD_RE.test(field);
  if (!field || field.length > 81 || !fieldOk) {
    return { ok: false, error: source === "output" ? `${where}: a hand-off is named "<step key>.<output key>".` : `${where}: pick the field the condition reads.` };
  }
  const op = raw.op as HdConditionOp;
  if (!(HD_CONDITION_OPS as readonly string[]).includes(op)) return { ok: false, error: `${where}: the condition's test is not one this version knows.` };
  const rule: HdConditionRule = { source, field, op };
  if (VALUE_OPS.has(op)) {
    if (op === "in") {
      if (!Array.isArray(raw.value) || raw.value.length === 0 || raw.value.length > 50 || raw.value.some((v) => typeof v !== "string" || v.length > 200)) {
        return { ok: false, error: `${where}: "is one of" needs a list of values.` };
      }
      rule.value = (raw.value as string[]).map((v) => v.trim());
    } else {
      if (typeof raw.value !== "string" || raw.value.length > 200) return { ok: false, error: `${where}: the condition needs a value to compare.` };
      rule.value = raw.value.trim();
    }
  }
  return { ok: true, value: rule };
}

function checkWhen(raw: unknown, where: string): Checked<HdStepCondition | undefined> {
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  if (!isObj(raw)) return { ok: false, error: `${where}: the condition must be an object.` };
  const match = raw.match === undefined ? "all" : raw.match;
  if (match !== "all" && match !== "any") return { ok: false, error: `${where}: match all of the rules or any of them.` };
  if (!Array.isArray(raw.rules) || raw.rules.length === 0) return { ok: true, value: undefined };
  if (raw.rules.length > 20) return { ok: false, error: `${where}: at most 20 rules.` };
  const rules: HdConditionRule[] = [];
  for (const r of raw.rules) {
    const c = checkRule(r, where);
    if (!c.ok) return c;
    rules.push(c.value);
  }
  return { ok: true, value: { match, rules } };
}

function checkRoute(raw: unknown, where: string): Checked<HdTaskRoute | undefined> {
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  if (!isObj(raw)) return { ok: false, error: `${where}: routing must be an object.` };
  const source = raw.source;
  if (source !== "answer" && source !== "requester") return { ok: false, error: `${where}: route by an answer or by the requester.` };
  const field = str(raw.field);
  if (!(source === "answer" ? FIELD_RE : REQUESTER_FIELD_RE).test(field)) return { ok: false, error: `${where}: pick the field the routing reads.` };
  if (!Array.isArray(raw.map) || raw.map.length === 0) return { ok: false, error: `${where}: routing needs at least one value and team.` };
  if (raw.map.length > 50) return { ok: false, error: `${where}: routing has at most 50 values.` };
  const map: HdTaskRoute["map"] = [];
  for (const m of raw.map) {
    const value = isObj(m) ? str(m.value) : "";
    const team = isObj(m) ? posInt(m.team_id) : null;
    if (!value || value.length > 200 || !team) return { ok: false, error: `${where}: every routing row needs a value and a team.` };
    map.push({ value, team_id: team });
  }
  const route: HdTaskRoute = { source, field, map };
  if (raw.fallback_team_id !== undefined && raw.fallback_team_id !== null) {
    const fb = posInt(raw.fallback_team_id);
    if (!fb) return { ok: false, error: `${where}: pick the team for anything else.` };
    route.fallback_team_id = fb;
  }
  return { ok: true, value: route };
}

const OUTPUT_TYPES: readonly HdTaskOutputType[] = ["text", "number", "date", "select", "yes_no"];

function checkOutputs(raw: unknown, where: string): Checked<HdTaskOutputDef[] | undefined> {
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  if (!Array.isArray(raw)) return { ok: false, error: `${where}: hand-offs are a list.` };
  if (raw.length === 0) return { ok: true, value: undefined };
  if (raw.length > 20) return { ok: false, error: `${where}: at most 20 hand-off fields.` };
  const keys = new Set<string>();
  const out: HdTaskOutputDef[] = [];
  for (const o of raw) {
    if (!isObj(o)) return { ok: false, error: `${where}: a hand-off field is not a field.` };
    const key = str(o.key);
    if (!FIELD_RE.test(key) || key.length > 40) return { ok: false, error: `${where}: a hand-off field needs a key of lower-case letters, digits and underscores.` };
    if (keys.has(key)) return { ok: false, error: `${where}: two hand-off fields use the key "${key}".` };
    keys.add(key);
    const label = str(o.label);
    if (!label || label.length > 200) return { ok: false, error: `${where}: hand-off "${key}" needs a label.` };
    const type = o.type as HdTaskOutputType;
    if (!OUTPUT_TYPES.includes(type)) return { ok: false, error: `${where}: hand-off "${key}" has an unknown type.` };
    const def: HdTaskOutputDef = { key, label, type };
    if (o.required !== undefined && typeof o.required !== "boolean") return { ok: false, error: `${where}: hand-off "${key}": required is true or false.` };
    if (o.required) def.required = true;
    if (type === "select") {
      if (!Array.isArray(o.options) || o.options.length === 0 || o.options.length > 50) return { ok: false, error: `${where}: hand-off "${key}" needs its options.` };
      const values = new Set<string>();
      def.options = [];
      for (const op of o.options) {
        const value = isObj(op) ? str(op.value) : "";
        const olabel = isObj(op) ? str(op.label) || value : "";
        if (!value || value.length > 100 || olabel.length > 200 || values.has(value)) return { ok: false, error: `${where}: hand-off "${key}" has a bad option.` };
        values.add(value);
        def.options.push({ value, label: olabel });
      }
    }
    out.push(def);
  }
  return { ok: true, value: out };
}

/**
 * Check a definition's shape and return it cleaned (unknown properties
 * dropped). Keys are unique across the whole definition, groups included;
 * a parallel group holds tasks only; Finish, if present, is the last step.
 * References (teams, people, form fields) are checkWorkflowRefs' job.
 */
export function parseWorkflowDefinition(raw: unknown): Checked<HdWorkflowDefinition> {
  if (!isObj(raw)) return { ok: false, error: "Send the workflow as a JSON object." };
  const trig = isObj(raw.trigger) ? raw.trigger : {};
  const rtId = trig.request_type_id === undefined || trig.request_type_id === null ? null : posInt(trig.request_type_id);
  if (trig.request_type_id !== undefined && trig.request_type_id !== null && !rtId) return { ok: false, error: "The trigger names a request type by id." };
  if (!Array.isArray(raw.steps)) return { ok: false, error: "A workflow is a list of steps." };
  if (raw.steps.length > WORKFLOW_LIMITS.steps) return { ok: false, error: `A workflow has at most ${WORKFLOW_LIMITS.steps} steps.` };

  const keys = new Set<string>();
  const takeKey = (v: unknown, n: string): Checked<string> => {
    const k = str(v);
    if (!k || k.length > WORKFLOW_LIMITS.key || !KEY_RE.test(k)) return { ok: false, error: `${n} needs a key of lower-case letters, digits, hyphens and underscores.` };
    if (keys.has(k)) return { ok: false, error: `Two steps use the key "${k}".` };
    keys.add(k);
    return { ok: true, value: k };
  };

  const steps: HdWorkflowStep[] = [];
  for (const [i, s] of raw.steps.entries()) {
    const where = `Step ${i + 1}`;
    if (!isObj(s)) return { ok: false, error: `${where} is not a step.` };
    const key = takeKey(s.key, where);
    if (!key.ok) return key;
    if (steps.some((x) => x.kind === "finish")) return { ok: false, error: "Finish is the last step." };
    switch (s.kind) {
      case "approval": {
        const title = checkTitle(s.title, where);
        if (!title.ok) return title;
        const approver = checkApprover(s.approver, where);
        if (!approver.ok) return approver;
        const onDecline = s.on_decline === undefined ? "close" : s.on_decline;
        if (onDecline !== "close" && onDecline !== "continue") return { ok: false, error: `${where}: if they decline, close the request or carry on.` };
        const step: HdApprovalStepDef = { key: key.value, kind: "approval", title: title.value, approver: approver.value, on_decline: onDecline };
        if (s.remind_after_hours !== undefined && s.remind_after_hours !== null && s.remind_after_hours !== 0) {
          const h = s.remind_after_hours;
          if (typeof h !== "number" || !Number.isInteger(h) || h < 1 || h > WORKFLOW_LIMITS.remindHours) {
            return { ok: false, error: `${where}: remind after a whole number of hours, up to ${WORKFLOW_LIMITS.remindHours}.` };
          }
          step.remind_after_hours = h;
        }
        steps.push(step);
        break;
      }
      case "task": {
        const t = checkTask(s, key.value, where);
        if (!t.ok) return t;
        steps.push(t.value);
        break;
      }
      case "parallel": {
        if (!Array.isArray(s.steps) || s.steps.length === 0) return { ok: false, error: `${where}: a group holds at least one task.` };
        if (s.steps.length > WORKFLOW_LIMITS.parallel) return { ok: false, error: `${where}: a group holds at most ${WORKFLOW_LIMITS.parallel} tasks.` };
        const tasks: HdTaskStepDef[] = [];
        for (const [j, c] of s.steps.entries()) {
          const cw = `${where}, task ${j + 1}`;
          if (!isObj(c) || c.kind !== "task") return { ok: false, error: `${cw}: a group holds tasks only.` };
          const ck = takeKey(c.key, cw);
          if (!ck.ok) return ck;
          const t = checkTask(c, ck.value, cw);
          if (!t.ok) return t;
          tasks.push(t.value);
        }
        const step: HdParallelStepDef = { key: key.value, kind: "parallel", steps: tasks };
        const gt = str(s.title);
        if (gt.length > WORKFLOW_LIMITS.title) return { ok: false, error: `${where}: the group title is too long.` };
        if (gt) step.title = gt;
        steps.push(step);
        break;
      }
      case "wait": {
        const title = checkTitle(s.title, where);
        if (!title.ok) return title;
        const u = s.until;
        if (!isObj(u)) return { ok: false, error: `${where}: wait until a form date or for a number of hours.` };
        let until: HdWaitStepDef["until"];
        if (u.field !== undefined) {
          const f = str(u.field);
          if (!FIELD_RE.test(f)) return { ok: false, error: `${where}: the date is a form field key.` };
          // Days before or after the date (1.19.1); 0 is stored as no offset, as before.
          const off = u.offset_days === undefined || u.offset_days === null ? 0 : u.offset_days;
          if (typeof off !== "number" || !Number.isInteger(off) || Math.abs(off) > WORKFLOW_LIMITS.offsetDays) {
            return { ok: false, error: `${where}: the days before or after are a whole number up to ${WORKFLOW_LIMITS.offsetDays}.` };
          }
          until = off ? { field: f, offset_days: off } : { field: f };
        } else {
          const h = u.after_hours;
          if (typeof h !== "number" || !Number.isInteger(h) || h < 1 || h > WORKFLOW_LIMITS.afterHours) {
            return { ok: false, error: `${where}: wait a whole number of hours from 1 to ${WORKFLOW_LIMITS.afterHours}.` };
          }
          until = { after_hours: h };
        }
        steps.push({ key: key.value, kind: "wait", title: title.value, until });
        break;
      }
      case "notify": {
        const title = checkTitle(s.title, where);
        if (!title.ok) return title;
        let to: HdNotifyStepDef["to"];
        if (s.to === "requester" || s.to === undefined) to = "requester";
        else if (isObj(s.to) && posInt(s.to.user_id)) to = { user_id: posInt(s.to.user_id)! };
        else if (isObj(s.to) && posInt(s.to.team_id)) to = { team_id: posInt(s.to.team_id)! };
        else return { ok: false, error: `${where}: tell the requester, a person or a team.` };
        const message = typeof s.message === "string" ? s.message.trim() : "";
        if (!message || message.length > WORKFLOW_LIMITS.message) return { ok: false, error: `${where} needs a message (at most ${WORKFLOW_LIMITS.message} characters).` };
        steps.push({ key: key.value, kind: "notify", title: title.value, to, message });
        break;
      }
      case "finish": {
        const title = checkTitle(s.title, where);
        if (!title.ok) return title;
        if (s.csat !== undefined && typeof s.csat !== "boolean") return { ok: false, error: `${where}: asking how it went is on or off.` };
        const step: HdFinishStepDef = { key: key.value, kind: "finish", title: title.value };
        if (s.csat !== undefined) step.csat = s.csat;
        steps.push(step);
        break;
      }
      default:
        return { ok: false, error: `${where} is not a kind of step this version knows.` };
    }
    // Every kind may carry a condition (a task's was read with it).
    const when = checkWhen(s.when, where);
    if (!when.ok) return when;
    if (when.value) (steps[steps.length - 1] as HdStepExtrasB).when = when.value;
    // A wait, and an approval with a reminder, may count business time (1.19.1; a task's was read with it).
    const last = steps[steps.length - 1];
    if (last.kind === "wait" || (last.kind === "approval" && last.remind_after_hours)) {
      const count = checkCount(s, where);
      if (!count.ok) return count;
      Object.assign(last, count.value);
    }
  }
  return { ok: true, value: { trigger: rtId ? { request_type_id: rtId } : {}, steps } };
}

/** Every task of a definition, groups flattened. */
export function definitionTasks(def: HdWorkflowDefinition): HdTaskStepDef[] {
  return def.steps.flatMap((s) => (s.kind === "task" ? [s] : s.kind === "parallel" ? s.steps : []));
}

/**
 * Check what a definition names: teams and people exist (people active),
 * and every form field a due date or a wait reads is a date field of the
 * linked request type's form (when one is linked: `form`).
 */
export async function checkWorkflowRefs(def: HdWorkflowDefinition, form?: HdFormField[] | null): Promise<Checked<HdWorkflowDefinition>> {
  const teamIds = new Set<number>();
  const userIds = new Set<number>();
  const fields: { field: string; title: string }[] = [];
  for (const s of def.steps) {
    if (s.kind === "approval") {
      if (s.approver.kind === "team") teamIds.add(s.approver.team_id);
      if (s.approver.kind === "user") userIds.add(s.approver.user_id);
    }
    if (s.kind === "wait" && "field" in s.until) fields.push({ field: s.until.field, title: s.title });
    if ((s.kind === "wait" || s.kind === "approval") && s.count_team_id) teamIds.add(s.count_team_id);
    if (s.kind === "notify" && typeof s.to === "object") {
      if ("user_id" in s.to) userIds.add(s.to.user_id);
      if ("team_id" in s.to) teamIds.add(s.to.team_id);
    }
  }
  for (const t of definitionTasks(def) as HdTaskStepDefB[]) {
    teamIds.add(t.team_id);
    if (t.count_team_id) teamIds.add(t.count_team_id);
    if (t.due && "field" in t.due) fields.push({ field: t.due.field, title: t.title });
    if (t.route) {
      for (const m of t.route.map) teamIds.add(m.team_id);
      if (t.route.fallback_team_id) teamIds.add(t.route.fallback_team_id);
    }
  }
  // Conditions and routes: answers must be on the form, requester fields
  // known, hand-offs recorded by an EARLIER step (never the same group).
  const customKeys = new Set((await hq<{ key: string }>("SELECT key FROM directory_fields")).map((r) => r.key));
  const requesterOk = (f: string) => (HD_REQUESTER_FIELDS as readonly string[]).includes(f) || customKeys.has(f);
  const earlierOutputs = new Map<string, HdTaskOutputDef[]>();
  const checkRules = (rules: HdConditionRule[], title: string): string | null => {
    for (const r of rules) {
      if (r.source === "answer" && form && !form.some((x) => x.key === r.field)) return `"${title}" reads "${r.field}", which is not on the form.`;
      if (r.source === "requester" && !requesterOk(r.field)) return `"${title}" reads the requester's "${r.field}", which the directory does not have.`;
      if (r.source === "output") {
        const [stepKey, outKey] = r.field.split(".");
        const outs = earlierOutputs.get(stepKey);
        if (!outs || !outs.some((o) => o.key === outKey)) return `"${title}" reads the hand-off "${r.field}", which no earlier task records.`;
      }
    }
    return null;
  };
  const checkTaskRefs = (t: HdTaskStepDefB): string | null => {
    if (t.when) {
      const bad = checkRules(t.when.rules, t.title);
      if (bad) return bad;
    }
    if (t.route) {
      if (t.route.source === "answer" && form && !form.some((x) => x.key === t.route!.field)) return `"${t.title}" routes by "${t.route.field}", which is not on the form.`;
      if (t.route.source === "requester" && !requesterOk(t.route.field)) return `"${t.title}" routes by the requester's "${t.route.field}", which the directory does not have.`;
    }
    return null;
  };
  for (const s of def.steps as HdWorkflowStepB[]) {
    if (s.kind === "task") {
      const bad = checkTaskRefs(s);
      if (bad) return { ok: false, error: bad };
      if (s.outputs) earlierOutputs.set(s.key, s.outputs);
    } else if (s.kind === "parallel") {
      if (s.when) {
        const bad = checkRules(s.when.rules, s.title || "At the same time");
        if (bad) return { ok: false, error: bad };
      }
      for (const t of s.steps) {
        const bad = checkTaskRefs(t);
        if (bad) return { ok: false, error: bad };
      }
      for (const t of s.steps) if (t.outputs) earlierOutputs.set(t.key, t.outputs);
    } else if (s.when) {
      const bad = checkRules(s.when.rules, s.title);
      if (bad) return { ok: false, error: bad };
    }
  }
  if (teamIds.size) {
    const found = await hq<{ id: number }>("SELECT id FROM hd_teams WHERE id = ANY($1::int[])", [[...teamIds]]);
    if (found.length !== teamIds.size) return { ok: false, error: "A step names a team that no longer exists." };
  }
  if (userIds.size) {
    const found = await hq<{ id: number }>("SELECT id FROM users WHERE id = ANY($1::int[]) AND status = 'active'", [[...userIds]]);
    if (found.length !== userIds.size) return { ok: false, error: "A step names a person who is not an active account." };
  }
  if (form) {
    for (const f of fields) {
      const field = form.find((x) => x.key === f.field);
      if (!field || field.type !== "date") return { ok: false, error: `"${f.title}" reads "${f.field}", which is not a date on the form.` };
    }
  }
  return { ok: true, value: def };
}

/** The form of the request type linked to a workflow (via workflow_id, else the trigger), or null. */
async function linkedForm(workflowId: number | null, def: HdWorkflowDefinition): Promise<HdFormField[] | null> {
  const r = await hqOne<{ form: HdFormField[] }>(
    `SELECT form FROM hd_request_types WHERE ($1::int IS NOT NULL AND workflow_id = $1) OR id = $2
      ORDER BY (workflow_id IS NOT DISTINCT FROM $1) DESC LIMIT 1`,
    [workflowId, def.trigger.request_type_id ?? 0]
  );
  return r?.form ?? null;
}

/** Shape and references together (what save and publish run). */
export async function validateWorkflowDefinition(raw: unknown, workflowId: number | null = null): Promise<Checked<HdWorkflowDefinition>> {
  const parsed = parseWorkflowDefinition(raw);
  if (!parsed.ok) return parsed;
  return checkWorkflowRefs(parsed.value, await linkedForm(workflowId, parsed.value));
}

// --- Reads ---------------------------------------------------------------------------

export interface HdWorkflowListRow extends HdWorkflow {
  /** Runs started in the last 30 days ("12 this month"). */
  runs_recent: number;
  /** Runs still running or waiting. */
  runs_open: number;
  /** Request types linked to it. */
  request_types: { id: number; title: string }[];
  /** True when the draft differs from the published definition. */
  has_changes: boolean;
}

const LIST_COLS = `w.*,
  (SELECT count(*)::int FROM hd_workflow_runs r WHERE r.workflow_id = w.id AND r.started_at > now() - interval '30 days') AS runs_recent,
  (SELECT count(*)::int FROM hd_workflow_runs r WHERE r.workflow_id = w.id AND r.state IN ('running', 'waiting', 'blocked')) AS runs_open,
  coalesce((SELECT json_agg(json_build_object('id', rt.id, 'title', rt.title) ORDER BY rt.position, rt.id)
              FROM hd_request_types rt WHERE rt.workflow_id = w.id), '[]') AS request_types,
  (w.draft IS NOT NULL AND w.draft <> w.definition) AS has_changes`;

export async function listWorkflows(): Promise<HdWorkflowListRow[]> {
  return hq<HdWorkflowListRow>(`SELECT ${LIST_COLS} FROM hd_workflows w ORDER BY w.title, w.id`);
}

export async function getWorkflow(id: number): Promise<HdWorkflowListRow | undefined> {
  return hqOne<HdWorkflowListRow>(`SELECT ${LIST_COLS} FROM hd_workflows w WHERE w.id = $1`, [id]);
}

/** The definition the builder edits: the draft when there is one, else the published one. */
export function workingDefinition(w: Pick<HdWorkflow, "definition" | "draft">): HdWorkflowDefinition {
  return w.draft ?? w.definition ?? EMPTY_DEFINITION;
}

// --- Writes --------------------------------------------------------------------------

export interface WorkflowMetaInput {
  title: string;
  slug: string;
  description: string;
}

/** Check title/slug/description for a create (no base) or an update. */
export async function validateWorkflowMeta(raw: unknown, base?: HdWorkflow): Promise<Checked<WorkflowMetaInput>> {
  const body = isObj(raw) ? raw : {};
  const has = (k: string) => Object.prototype.hasOwnProperty.call(body, k);
  const title = str(has("title") ? body.title : base?.title);
  if (!title || title.length > WORKFLOW_LIMITS.workflowTitle) return { ok: false, error: `A workflow needs a name (at most ${WORKFLOW_LIMITS.workflowTitle} characters).` };
  let slug = str(has("slug") ? body.slug : base?.slug);
  if (!slug) slug = slugify(title).slice(0, WORKFLOW_LIMITS.slug).replace(/-+$/, "");
  if (!slug || slug.length > WORKFLOW_LIMITS.slug || !SLUG_RE.test(slug)) return { ok: false, error: "The address name is lower-case letters, digits and hyphens." };
  const description = str(has("description") ? body.description : base?.description);
  if (description.length > WORKFLOW_LIMITS.workflowDescription) return { ok: false, error: `The description is longer than ${WORKFLOW_LIMITS.workflowDescription} characters.` };
  const clash = await hqOne("SELECT 1 FROM hd_workflows WHERE slug = $1 AND id <> $2", [slug, base?.id ?? 0]);
  if (clash) return { ok: false, error: "Another workflow already uses that address name." };
  return { ok: true, value: { title, slug, description } };
}

/** A new workflow: unpublished, its steps in the draft (version 1 once published). */
export async function createWorkflow(meta: WorkflowMetaInput, draft: HdWorkflowDefinition): Promise<HdWorkflowListRow> {
  const r = await hqOne<{ id: number }>(
    `INSERT INTO hd_workflows (slug, title, description, definition, draft, published, version)
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, 0, 1) RETURNING id`,
    [meta.slug, meta.title, meta.description, JSON.stringify(EMPTY_DEFINITION), JSON.stringify(draft)]
  );
  return (await getWorkflow(r!.id))!;
}

/**
 * Save the builder: name/description and (when given) the draft steps.
 * Never touches the published definition; that is publishWorkflow's.
 */
export async function saveWorkflowDraft(
  id: number,
  meta: WorkflowMetaInput,
  draft: HdWorkflowDefinition | undefined
): Promise<HdWorkflowListRow | undefined> {
  const r = await hq(
    `UPDATE hd_workflows SET title = $2, slug = $3, description = $4,
            draft = CASE WHEN $5::jsonb IS NULL THEN draft ELSE $5::jsonb END, updated_at = now()
      WHERE id = $1 RETURNING id`,
    [id, meta.title, meta.slug, meta.description, draft === undefined ? null : JSON.stringify(draft)]
  );
  return r.length ? getWorkflow(id) : undefined;
}

export type PublishOutcome =
  | { ok: true; workflow: HdWorkflowListRow; version: number; changed: boolean }
  | { ok: false; status: 400 | 404 | 409; error: string };

/**
 * Publish the draft: checked again (a team may have gone since it was
 * saved), copied into `definition`, version bumped, draft cleared. A
 * workflow published for the first time keeps version 1. Publishing with
 * no draft re-publishes nothing (409), unless the workflow was never
 * published (an empty draft cannot be published either: 400).
 */
export async function publishWorkflow(id: number): Promise<PublishOutcome> {
  const w = await getWorkflow(id);
  if (!w) return { ok: false, status: 404, error: "Not found." };
  if (!w.draft && w.published) return { ok: false, status: 409, error: "There are no changes to publish." };
  const def = workingDefinition(w);
  const checked = await validateWorkflowDefinition(def, id);
  if (!checked.ok) return { ok: false, status: 400, error: checked.error };
  if (checked.value.steps.length === 0) return { ok: false, status: 400, error: "Add a step before publishing." };
  const r = await hqOne<{ version: number }>(
    `UPDATE hd_workflows
        SET definition = $2::jsonb, draft = NULL,
            version = CASE WHEN published = 1 THEN version + 1 ELSE version END,
            published = 1, updated_at = now()
      WHERE id = $1 AND draft IS NOT DISTINCT FROM $3::jsonb
      RETURNING version`,
    [id, JSON.stringify(checked.value), w.draft === null ? null : JSON.stringify(w.draft)]
  );
  // Someone saved between the read and the write: publish what they saved, not this.
  if (!r) return { ok: false, status: 409, error: "The workflow changed while publishing. Reload and try again." };
  return { ok: true, workflow: (await getWorkflow(id))!, version: r.version, changed: true };
}

/** Throw away unpublished edits. */
export async function discardWorkflowDraft(id: number): Promise<HdWorkflowListRow | undefined> {
  const r = await hq("UPDATE hd_workflows SET draft = NULL, updated_at = now() WHERE id = $1 AND published = 1 RETURNING id", [id]);
  return r.length ? getWorkflow(id) : undefined;
}

/**
 * Delete a workflow. Request types linked to it stop starting runs
 * (workflow_id SET NULL); runs already on their way finish on their pinned
 * snapshot (workflow_id SET NULL on the run, the snapshot stays).
 */
export async function deleteWorkflow(id: number): Promise<HdWorkflowListRow | undefined> {
  const w = await getWorkflow(id);
  if (!w) return undefined;
  await hq("DELETE FROM hd_workflows WHERE id = $1", [id]);
  return w;
}

// --- Dates the engine and the test run share --------------------------------------

/** A form date ("YYYY-MM-DD") plus offset days, at 09:00 UTC that day; null when the answer is missing or not a date. */
export function fieldDate(answers: HdFormAnswers, field: string, offsetDays = 0, hourUtc = 9): Date | null {
  const v = answers[field];
  if (!isIsoDate(v)) return null;
  const [y, m, d] = (v as string).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + offsetDays, hourUtc));
}

/** When a task is due: from the form date and offset, or hours after `from`; null = no due date. */
export function taskDueAt(due: HdDueDef | undefined, answers: HdFormAnswers, from: Date): Date | null {
  if (!due) return null;
  if ("field" in due) return fieldDate(answers, due.field, due.offset_days ?? 0, 17);
  return new Date(from.getTime() + due.after_hours * 3_600_000);
}

/** When a wait ends: the form date plus its offset days (start of that day, UTC) or hours after `from`. A missing date ends it at once. */
export function waitUntil(until: HdWaitStepDef["until"], answers: HdFormAnswers, from: Date): Date {
  if ("field" in until) return fieldDate(answers, until.field, until.offset_days ?? 0, 0) ?? from;
  return new Date(from.getTime() + until.after_hours * 3_600_000);
}

/**
 * `{{placeholders}}` in a notify message or a task description: requester,
 * subject, number, request_type, workflow, tasks, the form's answers as
 * answer.KEY or the bare field key ({{start_date}}), and what earlier
 * tasks handed off as outputs.STEP.KEY. An unknown name is left as written.
 */
export function renderTemplate(
  message: string,
  vars: Record<string, string>,
  answers: Record<string, string> = {},
  outputs: Record<string, Record<string, string>> = {}
): string {
  return message.replace(/\{\{\s*([a-z][a-z0-9_]*)((?:\.[a-z0-9_-]+){0,2})\s*\}\}/gi, (whole, name: string, rest: string) => {
    const n = name.toLowerCase();
    const parts = rest ? rest.slice(1).split(".") : [];
    if ((n === "answer" || n === "answers") && parts.length === 1) return answers[parts[0]] ?? "";
    if ((n === "outputs" || n === "output") && parts.length === 2) return outputs[parts[0]]?.[parts[1]] ?? "";
    if (parts.length) return whole;
    if (n in vars) return vars[n];
    if (n in answers) return answers[n];
    return whole;
  });
}

// --- Conditions, routes and hand-offs (evaluation) -----------------------------------

/** What a condition or a route may read about one request. */
export interface FactSource {
  form: HdFormField[];
  answers: HdFormAnswers;
  /** The requester's directory facts (requesterFacts). */
  requester: Record<string, string>;
  /** Hand-offs recorded so far: step key → output key → value. */
  outputs: Record<string, Record<string, HdOutputValue>>;
  /** Every task's output definitions, by step key (labels). */
  outputDefs: Map<string, HdTaskOutputDef[]>;
  /** Names for user answers. */
  names?: Map<number, string>;
  /** Hand-offs not known yet (a dry run): rules reading them pass, with a note. */
  outputsUnknown?: boolean;
}

const REQUESTER_LABEL: Record<string, string> = {
  department: "Department",
  office: "Office",
  location: "Location",
  title: "Job title",
  manager: "Manager",
};

const isEmpty = (v: unknown) => v === undefined || v === null || (typeof v === "string" && v.trim() === "");
const truthy = (v: unknown) => v === true || (typeof v === "string" && ["yes", "true", "1", "on"].includes(v.trim().toLowerCase())) || v === 1;
const falsy = (v: unknown) => v === false || (typeof v === "string" && ["no", "false", "0", "off"].includes(v.trim().toLowerCase())) || v === 0;

/** Text for comparing: case-folded; yes/no for booleans. */
function norm(v: unknown): string {
  if (v === true) return "yes";
  if (v === false) return "no";
  const t = String(v ?? "").trim().toLowerCase();
  return t === "true" ? "yes" : t === "false" ? "no" : t;
}

/** An output value as a person reads it. */
export function outputText(def: HdTaskOutputDef | undefined, v: unknown): string {
  if (isEmpty(v)) return "";
  if (def?.type === "yes_no" || typeof v === "boolean") return truthy(v) ? "Yes" : "No";
  if (def?.type === "select") return def.options?.find((o) => o.value === v)?.label ?? String(v);
  return String(v);
}

/** One fact: its raw value, a label and the text a person reads ("Office", "London"). */
export function factOf(src: FactSource, source: HdConditionRule["source"], field: string): { raw: unknown; label: string; text: string; known: boolean } {
  if (source === "answer") {
    const f = src.form.find((x) => x.key === field);
    const raw = src.answers[field];
    return { raw, label: f?.label ?? field, text: f ? answerText(f, raw, src.names) : isEmpty(raw) ? "" : String(raw), known: true };
  }
  if (source === "requester") {
    const raw = src.requester[field] ?? "";
    return { raw, label: REQUESTER_LABEL[field] ?? field.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()), text: raw, known: true };
  }
  const [stepKey, outKey] = field.split(".");
  const def = src.outputDefs.get(stepKey)?.find((o) => o.key === outKey);
  const raw = src.outputs[stepKey]?.[outKey];
  return { raw, label: def?.label ?? field, text: outputText(def, raw), known: !src.outputsUnknown };
}

function testRule(rule: HdConditionRule, raw: unknown): boolean {
  const value = rule.value;
  switch (rule.op) {
    case "equals":
      return !isEmpty(raw) && norm(raw) === norm(value);
    case "not_equals":
      return isEmpty(raw) || norm(raw) !== norm(value);
    case "in":
      return !isEmpty(raw) && (Array.isArray(value) ? value : [value]).some((x) => norm(x) === norm(raw));
    case "contains":
      return !isEmpty(raw) && norm(raw).includes(norm(value));
    case "is_empty":
      return isEmpty(raw);
    case "not_empty":
      return !isEmpty(raw);
    case "is_true":
      return truthy(raw);
    case "is_false":
      return falsy(raw) || isEmpty(raw);
  }
}

/**
 * Does the step's condition hold? The reason names the fact that decided
 * it: "Needs a laptop is No", "Office is empty".
 */
export function evaluateWhen(when: HdStepCondition | undefined, src: FactSource): { pass: boolean; reason: string } {
  if (!when || when.rules.length === 0) return { pass: true, reason: "" };
  const results = when.rules.map((r) => {
    const f = factOf(src, r.source, r.field);
    const pass = f.known ? testRule(r, f.raw) : true;
    const reason = f.known ? `${f.label} is ${f.text || "empty"}` : `${f.label} is not known until that task is done`;
    return { pass, reason };
  });
  if (when.match === "any") {
    const hit = results.find((r) => r.pass);
    return hit ? { pass: true, reason: hit.reason } : { pass: false, reason: results.map((r) => r.reason).join(" and ") };
  }
  const miss = results.find((r) => !r.pass);
  return miss ? { pass: false, reason: miss.reason } : { pass: true, reason: results.map((r) => r.reason).join(" and ") };
}

/** The team a routed task goes to, and why ("Office is London"). */
export function pickRouteTeam(route: HdTaskRoute | undefined, src: FactSource, teamId: number): { team_id: number; reason: string; routed: boolean } {
  if (!route) return { team_id: teamId, reason: "", routed: false };
  const f = factOf(src, route.source, route.field);
  const hit = isEmpty(f.raw) ? undefined : route.map.find((m) => norm(m.value) === norm(f.raw));
  const said = `${f.label} is ${f.text || "empty"}`;
  if (hit) return { team_id: hit.team_id, reason: said, routed: true };
  if (route.fallback_team_id) return { team_id: route.fallback_team_id, reason: `${said}, so the fallback team`, routed: true };
  return { team_id: teamId, reason: `${said}, so the task's own team`, routed: false };
}

/** The requester's directory facts (department, office, title, location, manager, custom fields), '' when unknown. */
export async function requesterFacts(userId: number | null, client?: HdQueryable): Promise<Record<string, string>> {
  const out: Record<string, string> = { department: "", office: "", title: "", location: "", manager: "" };
  if (!userId) return out;
  const r = await hqOne<{ department: string; office: string; title: string; custom: Record<string, unknown> | null; manager: string | null }>(
    `SELECT p.department, p.office, p.title, p.custom, m.name AS manager
       FROM users u JOIN directory_people p ON p.id = u.directory_person_id
       LEFT JOIN LATERAL (
         SELECT t.name FROM directory_person_links l JOIN directory_people t ON t.id = l.target_id
          WHERE l.person_id = p.id AND l.field_key = 'manager' ORDER BY l.sort, t.name LIMIT 1) m ON true
      WHERE u.id = $1`,
    [userId],
    client
  );
  if (!r) return out;
  for (const [k, v] of Object.entries(r.custom ?? {})) if (typeof v === "string" || typeof v === "number") out[k] = String(v);
  out.department = r.department ?? "";
  out.office = r.office ?? "";
  out.title = r.title ?? "";
  out.manager = r.manager ?? "";
  out.location = (typeof r.custom?.location === "string" && r.custom.location) || r.office || "";
  return out;
}

/** Every task's output definitions in a definition, by step key. */
export function outputDefsOf(def: HdWorkflowDefinition): Map<string, HdTaskOutputDef[]> {
  const m = new Map<string, HdTaskOutputDef[]>();
  for (const t of definitionTasks(def) as HdTaskStepDefB[]) if (t.outputs?.length) m.set(t.key, t.outputs);
  return m;
}

/**
 * Check a task team's hand-off values against the task's outputs: unknown
 * keys dropped, each value its type, required ones present when `requireAll`
 * (a "done" outcome; "can't be done" asks for nothing).
 */
export function validateOutputs(
  defs: HdTaskOutputDef[],
  raw: unknown,
  requireAll: boolean
): { ok: true; value: Record<string, HdOutputValue> } | { ok: false; error: string; missing?: string[] } {
  const given = isObj(raw) ? raw : {};
  const out: Record<string, HdOutputValue> = {};
  const missing: string[] = [];
  for (const d of defs) {
    const v = given[d.key];
    if (isEmpty(v)) {
      if (d.required && requireAll) missing.push(d.key);
      continue;
    }
    switch (d.type) {
      case "text":
        if (typeof v !== "string" || v.trim().length > 2000) return { ok: false, error: `"${d.label}" is text of at most 2,000 characters.` };
        out[d.key] = v.trim();
        break;
      case "number": {
        const n = typeof v === "number" ? v : typeof v === "string" ? Number(v.trim()) : NaN;
        if (!Number.isFinite(n)) return { ok: false, error: `"${d.label}" must be a number.` };
        out[d.key] = n;
        break;
      }
      case "date":
        if (!isIsoDate(v)) return { ok: false, error: `"${d.label}" must be a date.` };
        out[d.key] = v as string;
        break;
      case "select":
        if (typeof v !== "string" || !d.options?.some((o) => o.value === v)) return { ok: false, error: `"${d.label}" must be one of its options.` };
        out[d.key] = v;
        break;
      case "yes_no":
        if (truthy(v)) out[d.key] = true;
        else if (falsy(v)) out[d.key] = false;
        else return { ok: false, error: `"${d.label}" is yes or no.` };
        break;
    }
  }
  if (missing.length) {
    const labels = defs.filter((d) => missing.includes(d.key)).map((d) => d.label);
    return { ok: false, error: `Fill in the hand-off first: ${labels.join(", ")}.`, missing };
  }
  return { ok: true, value: out };
}

// --- Test run ------------------------------------------------------------------------

export interface SimulatedStep {
  key: string;
  kind: HdWorkflowStep["kind"];
  title: string;
  /** Nesting: 1 for a task inside a parallel group. */
  depth: number;
  /** What would happen, in a sentence. */
  outcome: string;
  /** When it would start (tasks in a group start together; after a wait, at its end). */
  starts_at: string;
  due_at?: string | null;
  wait_until?: string | null;
  /** The condition was false: the step would be skipped (reason says why). */
  skipped?: boolean;
  /** Why it is skipped, or how a task is routed ("Office is London"). */
  reason?: string;
  /** The team a task would go to (after routing). */
  team_name?: string;
  /** Business counting (1.19.1): whose calendar counted, and the holidays it passed over. */
  count_note?: string;
  warnings: string[];
}

export interface SimulationInput {
  answers?: HdFormAnswers;
  /** Whose manager the approval would go to (default: the caller). */
  requester_id?: number;
  /** The request type whose team stands in for a missing manager (default: the one linked). */
  request_type_id?: number | null;
  /** Assume every approval is declined at this step key (shows the decline path). */
  decline_at?: string;
  /** Sample hand-offs (step key → output key → value); without them, rules reading hand-offs pass with a note. */
  outputs?: Record<string, Record<string, HdOutputValue>>;
  now?: Date;
}

export interface SimulationResult {
  steps: SimulatedStep[];
  /** How the run would end. */
  ends: "solved" | "declined" | "open";
  warnings: string[];
}

async function nameOfUser(id: number): Promise<string | null> {
  const r = await hqOne<{ name: string }>(
    "SELECT coalesce(nullif(name, ''), username) AS name FROM users WHERE id = $1 AND status = 'active'",
    [id]
  );
  return r?.name ?? null;
}

async function teamNames(ids: number[]): Promise<Map<number, string>> {
  if (!ids.length) return new Map();
  const rows = await hq<{ id: number; name: string }>("SELECT id, name FROM hd_teams WHERE id = ANY($1::int[])", [ids]);
  return new Map(rows.map((r) => [r.id, r.name]));
}

const fmt = (d: Date) => d.toISOString();
const dayText = (d: Date, timeZone = "UTC") =>
  d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone });

/**
 * A dry run: what each step would do with these answers. Reads only. Time
 * moves only at waits (approvals and tasks take "as long as they take";
 * their reminders and due dates are shown from the moment they would
 * start).
 */
export async function simulateWorkflow(
  rawDef: unknown,
  input: SimulationInput,
  caller: { id: number }
): Promise<Checked<SimulationResult>> {
  const parsed = parseWorkflowDefinition(rawDef);
  if (!parsed.ok) return parsed;
  const def = parsed.value;
  const answers = input.answers ?? {};
  let clock = input.now ?? new Date();
  const requesterId = input.requester_id ?? caller.id;
  const warnings: string[] = [];
  const { resolveManager, teamLeadIds } = await import("./approvals");
  const rtId = input.request_type_id ?? def.trigger.request_type_id ?? null;
  const rt = rtId
    ? await hqOne<{ team_id: number | null; form: HdFormField[] }>("SELECT team_id, form FROM hd_request_types WHERE id = $1", [rtId])
    : undefined;
  const refs = await checkWorkflowRefs(def, rt?.form ?? null);
  if (!refs.ok) warnings.push(refs.error);

  const teamIds = new Set<number>(definitionTasks(def).map((t) => t.team_id));
  for (const t of definitionTasks(def) as HdTaskStepDefB[]) {
    for (const m of t.route?.map ?? []) teamIds.add(m.team_id);
    if (t.route?.fallback_team_id) teamIds.add(t.route.fallback_team_id);
  }
  for (const s of def.steps) {
    if (s.kind === "approval" && s.approver.kind === "team") teamIds.add(s.approver.team_id);
    if (s.kind === "notify" && typeof s.to === "object" && "team_id" in s.to) teamIds.add(s.to.team_id);
  }
  if (rt?.team_id) teamIds.add(rt.team_id);
  const teams = await teamNames([...teamIds]);
  const team = (id: number) => teams.get(id) ?? `Team #${id}`;

  const facts: FactSource = {
    form: rt?.form ?? [],
    answers,
    requester: await requesterFacts(requesterId),
    outputs: input.outputs ?? {},
    outputDefs: outputDefsOf(def),
    outputsUnknown: !input.outputs,
  };
  const out: SimulatedStep[] = [];
  const skippedLine = (key: string, kind: SimulatedStep["kind"], title: string, depth: number, reason: string): SimulatedStep => ({
    key,
    kind,
    title,
    depth,
    outcome: `Skipped (${reason}).`,
    starts_at: fmt(clock),
    skipped: true,
    reason,
    warnings: [],
  });
  // Business counting (1.19.1): the counting team's calendar, its name and the holidays passed.
  const { hoursForTeam } = await import("./calendars");
  const counting = async (s: { count?: "business"; count_team_id?: number }, fallbackTeam: number | null) => {
    if (countMode(s) !== "business") return { mode: "calendar" as const, hours: null, teamId: null, name: "" };
    const teamId = s.count_team_id ?? fallbackTeam;
    if (teamId && !teams.has(teamId)) {
      const more = await teamNames([teamId]);
      for (const [k, v] of more) teams.set(k, v);
    }
    return { mode: "business" as const, hours: await hoursForTeam(teamId), teamId, name: teamId ? team(teamId) : "the default calendar" };
  };
  const countNote = (c: Awaited<ReturnType<typeof counting>>, field: { answer: unknown; offset: number; at: "open" | "close" } | null): string | undefined => {
    if (c.mode !== "business" || !c.hours) return undefined;
    const whose = c.teamId ? `${c.name}'s office hours and holidays` : "the default calendar's office hours and holidays";
    if (!field || !isIsoDate(field.answer)) return `Business time: counts ${whose}.`;
    const r = shiftBusinessDays(String(field.answer), field.offset, c.hours, field.at);
    const skipped = r.holidays.map((h) => `${shortDate(h.date)} (${h.name})`);
    return `Business days: counts ${whose}${skipped.length ? `; skips ${skipped.join(", ")}` : ""}.`;
  };
  const task = async (t: HdTaskStepDefB, depth: number): Promise<SimulatedStep> => {
    const cond = evaluateWhen(t.when, facts);
    if (!cond.pass) return skippedLine(t.key, "task", t.title, depth, cond.reason);
    const routed = pickRouteTeam(t.route, facts, t.team_id);
    const c = await counting(t, routed.team_id);
    const due = countedTaskDue(t.due, answers, clock, c.mode, c.hours);
    const tz = c.hours?.timezone ?? "UTC";
    const w: string[] = [];
    if (t.due && "field" in t.due && !due) w.push(`No date in "${t.due.field}", so the task has no due date.`);
    const routeLine = t.route ? ` Routed to ${team(routed.team_id)} (${routed.reason}).` : "";
    const cantDo = t.on_cant_do === "continue" ? " If it can't be done, the workflow carries on." : " If it can't be done, the workflow stops for the coordinating team.";
    return {
      key: t.key,
      kind: "task",
      title: t.title,
      depth,
      outcome: `A task ticket for ${team(routed.team_id)}${due ? `, due ${dayText(due, tz)}` : ""}. The next step waits until it is solved.${routeLine}${cantDo}`,
      starts_at: fmt(clock),
      due_at: due ? fmt(due) : null,
      reason: t.route ? routed.reason : undefined,
      team_name: team(routed.team_id),
      count_note: countNote(c, t.due && "field" in t.due ? { answer: answers[t.due.field], offset: t.due.offset_days ?? 0, at: "close" } : null),
      warnings: w,
    };
  };

  let ends: SimulationResult["ends"] = "open";
  for (const s of def.steps as HdWorkflowStepB[]) {
    if (s.kind !== "task") {
      const cond = evaluateWhen(s.when, facts);
      if (!cond.pass) {
        out.push(skippedLine(s.key, s.kind, s.kind === "parallel" ? s.title || "At the same time" : s.title, 0, cond.reason));
        continue;
      }
    }
    if (s.kind === "approval") {
      const w: string[] = [];
      let who = "";
      const approver = s.approver as HdApproverDefB;
      if (approver.kind === "space_owner") who = "the space's owner (else whoever manages space access)";
      else if (s.approver.kind === "team") who = `any one member of ${team(s.approver.team_id)}`;
      else if (s.approver.kind === "user") who = (await nameOfUser(s.approver.user_id)) ?? "a person who is no longer an active account";
      else {
        const mgr = await resolveManager(requesterId);
        if (mgr) who = `${mgr.name}, the requester's manager`;
        else if (rt?.team_id) {
          const leads = await teamLeadIds(rt.team_id);
          who = leads.length ? `the leads of ${team(rt.team_id)} (no manager in the directory)` : `any one member of ${team(rt.team_id)} (no manager in the directory, and the team has no leads)`;
          w.push("The requester has no manager in the directory.");
        } else {
          who = "the helpdesk admins (no manager in the directory, and the request type has no team)";
          w.push("The requester has no manager in the directory and the request type has no team: only the helpdesk admins could approve this step.");
        }
      }
      const declined = input.decline_at === s.key;
      const rc = await counting(s, rt?.team_id ?? null);
      const remindAt = countedReminderAt(clock, s.remind_after_hours, rc.mode, rc.hours);
      const remind =
        s.remind_after_hours && remindAt
          ? ` Reminder after ${countedHoursLabel(s.remind_after_hours, rc.mode)}${rc.mode === "business" ? ` (${dayText(remindAt, rc.hours?.timezone)})` : ""}.`
          : "";
      out.push({
        key: s.key,
        kind: "approval",
        title: s.title,
        depth: 0,
        outcome: declined
          ? `Asks ${who}. Declined: ${s.on_decline === "close" ? "the request is closed and the requester told why." : "the workflow carries on."}`
          : `Asks ${who}.${remind}`,
        starts_at: fmt(clock),
        count_note: s.remind_after_hours ? countNote(rc, null) : undefined,
        warnings: w,
      });
      if (declined && s.on_decline === "close") {
        ends = "declined";
        break;
      }
    } else if (s.kind === "task") {
      out.push(await task(s, 0));
    } else if (s.kind === "parallel") {
      out.push({
        key: s.key,
        kind: "parallel",
        title: s.title || "At the same time",
        depth: 0,
        outcome: `${s.steps.length} task${s.steps.length === 1 ? "" : "s"} at the same time; the next step waits for all of them.`,
        starts_at: fmt(clock),
        warnings: [],
      });
      for (const t of s.steps) out.push(await task(t, 1));
    } else if (s.kind === "wait") {
      const wc = await counting(s, rt?.team_id ?? null);
      const until = countedWaitUntil(s.until, answers, clock, wc.mode, wc.hours);
      const w: string[] = [];
      if ("field" in s.until && !isIsoDate(answers[s.until.field])) w.push(`No date in "${s.until.field}", so the wait ends at once.`);
      out.push({
        key: s.key,
        kind: "wait",
        title: s.title,
        depth: 0,
        outcome: until > clock ? `Waits until ${dayText(until, wc.hours?.timezone)}.` : "Moves straight on.",
        starts_at: fmt(clock),
        wait_until: fmt(until),
        count_note: countNote(wc, "field" in s.until ? { answer: answers[s.until.field], offset: s.until.offset_days ?? 0, at: "open" } : null),
        warnings: w,
      });
      if (until > clock) clock = until;
    } else if (s.kind === "notify") {
      let to = "the requester";
      if (typeof s.to === "object" && "user_id" in s.to) to = (await nameOfUser(s.to.user_id)) ?? "a person who is no longer an active account";
      if (typeof s.to === "object" && "team_id" in s.to) to = `everyone in ${team(s.to.team_id)}`;
      out.push({ key: s.key, kind: "notify", title: s.title, depth: 0, outcome: `Tells ${to} by email and in the bell.`, starts_at: fmt(clock), warnings: [] });
    } else if (s.kind === "finish") {
      out.push({
        key: s.key,
        kind: "finish",
        title: s.title,
        depth: 0,
        outcome: s.csat === false ? "Solves the request." : "Solves the request and asks how it went (when surveys are on).",
        starts_at: fmt(clock),
        warnings: [],
      });
      ends = "solved";
    }
  }
  if (ends === "open" && !def.steps.some((s) => s.kind === "finish")) {
    warnings.push("There is no Finish step: the request stays open for the team when the steps are done.");
  }
  return { ok: true, value: { steps: out, ends, warnings: [...warnings, ...out.flatMap((s) => s.warnings)] } };
}
