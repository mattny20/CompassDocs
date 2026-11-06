"use client";

// "Only if…": a step's condition in the builder's settings panel. With no
// rule the step always runs; each rule picks what to check (a question on
// the request form, the requester's directory entry, or an earlier task's
// hand-off field), an operator that fits that field, and a value control
// that matches it (the field's own options for a choice). Two or more
// rules take All / Any. The sentence under the rules says it in plain
// words, the same sentence the step card's chip carries.

import { useId } from "react";
import { Filter, Plus, X } from "lucide-react";
import { Button, iconButtonClass } from "@/components/Button";
import { SUB_HEADING_TEXT } from "@/components/Heading";
import { Segmented } from "@/components/Segmented";
import { Select, TextInput } from "@/components/form";
import type { HdConditionOp, HdConditionRule, HdStepCondition } from "./contract";
import {
  OP_LABEL,
  conditionSummary,
  fieldId,
  findField,
  opTakesValue,
  opsFor,
  ruleProblem,
  type FieldChoice,
} from "./conditions";

const MAX_RULES = 10;

export function OnlyIfEditor({
  value,
  fields,
  onChange,
  stepLabel,
}: {
  value: HdStepCondition | undefined;
  fields: FieldChoice[];
  onChange: (next: HdStepCondition | undefined) => void;
  /** "this step", "this task", "these tasks". */
  stepLabel?: string;
}) {
  const headId = useId();
  const rules = value?.rules ?? [];
  const match = value?.match ?? "all";
  const set = (next: HdConditionRule[], m = match) => onChange(next.length ? { match: m, rules: next } : undefined);
  const summary = conditionSummary(value, fields);

  function addRule() {
    const f = fields[0];
    const r: HdConditionRule = f ? { source: f.source, field: f.field, op: opsFor(f.kind)[0] } : { source: "answer", field: "", op: "equals" };
    if (f && opTakesValue(r.op)) r.value = f.options?.[0]?.value ?? "";
    set([...rules, r]);
  }

  return (
    <section aria-labelledby={headId} className="border-t border-slate-100 pt-4">
      <h3 id={headId} className={`${SUB_HEADING_TEXT} flex items-center gap-1.5`}>
        <Filter className="h-3.5 w-3.5 text-slate-400" aria-hidden />
        Only if…
      </h3>
      <p className="mt-0.5 text-xs text-slate-500">
        {rules.length ? `Skip ${stepLabel ?? "this step"} unless these are true.` : `${capital(stepLabel ?? "this step")} runs on every request. Add a rule to run it only sometimes.`}
      </p>

      {rules.length > 1 && (
        <div className="mt-3">
          <Segmented
            size="sm"
            label="Which rules must be true"
            value={match}
            onChange={(m) => set(rules, m)}
            options={[
              { value: "all", label: "All of these" },
              { value: "any", label: "Any of these" },
            ]}
          />
        </div>
      )}

      {rules.length > 0 && (
        <ol className="mt-3 space-y-2" aria-label="Rules">
          {rules.map((r, i) => (
            <RuleRow
              key={i}
              index={i}
              rule={r}
              fields={fields}
              joiner={i === 0 ? null : match === "any" ? "or" : "and"}
              onChange={(next) => set(rules.map((x, j) => (j === i ? next : x)))}
              onRemove={() => set(rules.filter((_, j) => j !== i))}
            />
          ))}
        </ol>
      )}

      <Button variant="secondary" size="sm" icon={<Plus />} className="mt-3" onClick={addRule} disabled={rules.length >= MAX_RULES || fields.length === 0}>
        {rules.length ? "Add another rule" : "Add a rule"}
      </Button>

      {summary && (
        <p className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-700" aria-live="polite">
          {summary}.
        </p>
      )}
    </section>
  );
}

function capital(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function RuleRow({
  index,
  rule,
  fields,
  joiner,
  onChange,
  onRemove,
}: {
  index: number;
  rule: HdConditionRule;
  fields: FieldChoice[];
  joiner: "and" | "or" | null;
  onChange: (r: HdConditionRule) => void;
  onRemove: () => void;
}) {
  const f = findField(fields, rule);
  const ops = f ? opsFor(f.kind) : (["equals"] as HdConditionOp[]);
  const problem = ruleProblem(rule, fields);
  const n = index + 1;
  const groups = [...new Set(fields.map((x) => x.group))];

  function pickField(id: string) {
    const nf = fields.find((x) => fieldId(x) === id);
    if (!nf) return;
    const op = opsFor(nf.kind).includes(rule.op) ? rule.op : opsFor(nf.kind)[0];
    onChange({ source: nf.source, field: nf.field, op, value: opTakesValue(op) ? (op === "in" ? [] : nf.options?.[0]?.value ?? "") : undefined });
  }

  function pickOp(op: HdConditionOp) {
    if (!opTakesValue(op)) return onChange({ source: rule.source, field: rule.field, op });
    const cur = rule.value;
    const value = op === "in" ? (Array.isArray(cur) ? cur : cur ? [cur] : []) : Array.isArray(cur) ? cur[0] ?? "" : cur ?? f?.options?.[0]?.value ?? "";
    onChange({ ...rule, op, value });
  }

  return (
    <li className="rounded-lg border border-slate-200 p-2.5">
      <div className="flex items-center gap-2">
        <span className="text-2xs font-semibold uppercase tracking-wider text-slate-500">{joiner ?? "Rule"}</span>
        <span className="flex-1" />
        <button type="button" onClick={onRemove} aria-label={`Remove rule ${n}`} data-tt="Remove" className={iconButtonClass("quiet", "sm", "hover-danger")}>
          <X aria-hidden />
        </button>
      </div>
      <div className="mt-1.5 space-y-2">
        <Select dense aria-label={`Rule ${n}: what to check`} value={f ? fieldId(f) : ""} onChange={(e) => pickField(e.target.value)}>
          {!f && (
            <option value="" disabled>
              Choose what to check
            </option>
          )}
          {groups.map((g) => (
            <optgroup key={g} label={g}>
              {fields
                .filter((x) => x.group === g)
                .map((x) => (
                  <option key={fieldId(x)} value={fieldId(x)}>
                    {x.label}
                  </option>
                ))}
            </optgroup>
          ))}
        </Select>
        <Select dense aria-label={`Rule ${n}: how to compare`} value={rule.op} onChange={(e) => pickOp(e.target.value as HdConditionOp)}>
          {ops.map((o) => (
            <option key={o} value={o}>
              {OP_LABEL[o]}
            </option>
          ))}
        </Select>
        {opTakesValue(rule.op) && <ValueControl n={n} rule={rule} field={f} onChange={(value) => onChange({ ...rule, value })} />}
      </div>
      {problem && <p className="mt-1.5 text-xs ink-warn">{problem}</p>}
    </li>
  );
}

function ValueControl({
  n,
  rule,
  field,
  onChange,
}: {
  n: number;
  rule: HdConditionRule;
  field: FieldChoice | undefined;
  onChange: (v: string | string[]) => void;
}) {
  const label = `Rule ${n}: value`;
  const opts = field?.options ?? [];
  if (rule.op === "in" && opts.length) {
    const chosen = Array.isArray(rule.value) ? rule.value : rule.value ? [rule.value] : [];
    return (
      <fieldset>
        <legend className="sr-only">{label}</legend>
        <ul className="max-h-40 space-y-1 overflow-y-auto">
          {opts.map((o) => (
            <li key={o.value}>
              <label className="flex items-center gap-2 text-sm text-slate-700">
                <input
                  type="checkbox"
                  checked={chosen.includes(o.value)}
                  onChange={(e) => onChange(e.target.checked ? [...chosen, o.value] : chosen.filter((v) => v !== o.value))}
                />
                {o.label}
              </label>
            </li>
          ))}
        </ul>
      </fieldset>
    );
  }
  const v = Array.isArray(rule.value) ? rule.value.join(", ") : rule.value ?? "";
  if (opts.length) {
    return (
      <Select dense aria-label={label} value={v} onChange={(e) => onChange(e.target.value)}>
        {!opts.some((o) => o.value === v) && <option value="">Choose…</option>}
        {opts.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </Select>
    );
  }
  const type = field?.kind === "number" ? "number" : field?.kind === "date" ? "date" : "text";
  return (
    <TextInput
      dense
      aria-label={label}
      type={type}
      value={v}
      maxLength={200}
      placeholder={field?.source === "requester" ? "As written in the directory" : ""}
      onChange={(e) => onChange(rule.op === "in" ? e.target.value.split(",").map((s) => s.trimStart()) : e.target.value)}
    />
  );
}

