"use client";

// The per-policy deadline and reminder fields, shared by the Settings tab's
// Deadline and Reminders cards (PolicySettingsPanel, E1 / E2) and the
// compliance portal's "Set deadline…" and "Set reminders…" bulk dialogs
// (F5, 1.14.0), so the same radio cards, labels, ranges and inline rules
// serve one policy and two hundred. No state and no fetch: each takes the
// values, one setter and the field errors, exactly as the panel's cards do.

import { useId, type ReactNode } from "react";
import { Field, TextInput, rangeError } from "@/components/form";
import { DUE_RANGES } from "@/lib/ack-due";

/**
 * A stacked radio group (STYLEGUIDE §Overlays' radio-card recipe, outside a
 * dialog): a label and one description sentence per card, the chosen card
 * tinted, and the card's own controls (a number, a date) shown under its
 * description while it is chosen. The radio and the extra control are
 * siblings, never nested in one label, so each keeps one accessible name.
 */
export function RadioCards<T extends string>({
  label,
  name,
  value,
  onChange,
  options,
}: {
  /** The group's accessible name (the card's title). */
  label: string;
  name: string;
  value: T;
  onChange: (next: T) => void;
  options: { value: T; label: string; description: string; extra?: ReactNode }[];
}) {
  const id = useId();
  return (
    <div role="radiogroup" aria-label={label} className="space-y-2">
      {options.map((o) => {
        const checked = o.value === value;
        const rid = `${id}-${o.value}`;
        return (
          <div
            key={o.value}
            className={`flex gap-3 rounded-lg border p-3 transition ${checked ? "border-compass-300 bg-compass-50/60" : "border-slate-200 hover:bg-slate-50"}`}
          >
            <input
              type="radio"
              id={rid}
              name={name}
              value={o.value}
              checked={checked}
              onChange={() => onChange(o.value)}
              aria-describedby={`${rid}-desc`}
              className="mt-0.5 h-4 w-4 shrink-0"
            />
            <div className="min-w-0 flex-1">
              <label htmlFor={rid} className="block cursor-pointer text-sm font-medium text-slate-800">
                {o.label}
              </label>
              <span id={`${rid}-desc`} className="block text-xs text-slate-500">
                {o.description}
              </span>
              {checked && o.extra && <div className="mt-3">{o.extra}</div>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── The deadline (E1) ────────────────────────────────────────────────────────

/** The Deadline card's radio. */
export type DueMode = "inherit" | "days" | "fixed";

/** The deadline as a form holds it: the mode, the digits ('' = none) and the 'YYYY-MM-DD' ('' = none). */
export interface DeadlineFormValue {
  due_mode: DueMode;
  due_days: string;
  due_at: string;
}

/** The stored rule as a form holds it. */
export function deadlineFormFrom(rule: { due_days: number | null; due_at: string | null }): DeadlineFormValue {
  return {
    due_mode: rule.due_at ? "fixed" : rule.due_days !== null ? "days" : "inherit",
    due_days: rule.due_days !== null ? String(rule.due_days) : "",
    due_at: rule.due_at ?? "",
  };
}

/** The rule a form sends. */
export function deadlineRuleFrom(v: DeadlineFormValue): { due_days: number | null; due_at: string | null } {
  if (v.due_mode === "days") return { due_days: Number(v.due_days), due_at: null };
  if (v.due_mode === "fixed") return { due_days: null, due_at: v.due_at || null };
  return { due_days: null, due_at: null };
}

/** The days field's rule, judged only in 'days' mode. */
export function deadlineDaysError(v: DeadlineFormValue): string | undefined {
  return v.due_mode === "days" ? rangeError(v.due_days, DUE_RANGES.due_days.min, DUE_RANGES.due_days.max) : undefined;
}

/**
 * The three choices of a policy's deadline: inherit the space's or the
 * workspace's rule, a number of days after each person's assignment, or
 * one fixed date. The caller names the inherit card (one policy knows the
 * number it inherits; a bulk dialog does not) and judges the two fields.
 */
export function DeadlineFields({
  label = "Deadline",
  name,
  value,
  onChange,
  errors,
  inheritLabel,
  inheritDescription = "Follows the space's or the workspace's rule, and moves with it when that changes.",
  today,
  fixedHint,
}: {
  label?: string;
  name: string;
  value: DeadlineFormValue;
  onChange: <K extends keyof DeadlineFormValue>(key: K, value: DeadlineFormValue[K]) => void;
  errors: { due_days?: string; due_at?: string };
  inheritLabel: string;
  inheritDescription?: string;
  /** 'YYYY-MM-DD': the date input's floor. */
  today: string;
  /** Under the fixed date's field (the Settings tab's "this date has passed" hint). */
  fixedHint?: ReactNode;
}) {
  return (
    <RadioCards<DueMode>
      label={label}
      name={name}
      value={value.due_mode}
      onChange={(mode) => onChange("due_mode", mode)}
      options={[
        {
          value: "inherit",
          label: inheritLabel,
          description: inheritDescription,
        },
        {
          value: "days",
          label: "Days after assignment",
          description: "Each person's own deadline, counted from the day they are asked. A change applies to future assignments.",
          extra: (
            <Field label="Days" size="xs" error={errors.due_days}>
              <TextInput
                type="number"
                inputMode="numeric"
                min={DUE_RANGES.due_days.min}
                max={DUE_RANGES.due_days.max}
                step={1}
                value={value.due_days}
                onChange={(e) => onChange("due_days", e.target.value)}
              />
            </Field>
          ),
        },
        {
          value: "fixed",
          label: "Fixed date",
          description: "One date for everyone. Changing it moves every open deadline.",
          extra: (
            <>
              <Field label="Due date" size="sm" error={errors.due_at}>
                <TextInput type="date" min={today} value={value.due_at} onChange={(e) => onChange("due_at", e.target.value)} />
              </Field>
              {fixedHint}
            </>
          ),
        },
      ]}
    />
  );
}

// ── The reminders (E2) ───────────────────────────────────────────────────────

/** The four reminder numbers the Reminders card edits (policy_settings' columns). */
export type ReminderKey = "remind_before_days" | "remind_every_days" | "escalate_after_days" | "nudge_every_days";

/** The spec's labels, the unit in brackets (TextInput has no suffix). */
export const REMINDER_FIELDS: readonly { key: ReminderKey; label: string }[] = [
  { key: "remind_before_days", label: "Remind before due (days)" },
  { key: "remind_every_days", label: "Remind every (days while overdue)" },
  { key: "escalate_after_days", label: "Escalate after (days overdue)" },
  { key: "nudge_every_days", label: "Nudge without a deadline every (days, 0 = never)" },
];
export const REMINDER_KEYS: readonly ReminderKey[] = REMINDER_FIELDS.map((f) => f.key);

/** A blank reminder field inherits; anything typed must be a whole number in the key's range. */
export function reminderError(key: ReminderKey, value: string): string | undefined {
  return value === "" ? undefined : rangeError(value, DUE_RANGES[key].min, DUE_RANGES[key].max);
}

/**
 * The four numbers of a policy's cadence in a two-column grid, blank to
 * inherit. The caller supplies each field's placeholder (the number it
 * inherits, when known) and help line.
 */
export function ReminderFields({
  values,
  onChange,
  errors,
  placeholders,
  help,
}: {
  values: Record<ReminderKey, string>;
  onChange: (key: ReminderKey, value: string) => void;
  errors: Partial<Record<ReminderKey, string | undefined>>;
  placeholders?: Partial<Record<ReminderKey, string | number>>;
  help: (key: ReminderKey) => ReactNode;
}) {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {REMINDER_FIELDS.map((f) => (
        <Field key={f.key} label={f.label} help={help(f.key)} error={errors[f.key]}>
          <TextInput
            type="number"
            inputMode="numeric"
            min={DUE_RANGES[f.key].min}
            max={DUE_RANGES[f.key].max}
            step={1}
            placeholder={placeholders?.[f.key] === undefined ? undefined : String(placeholders[f.key])}
            value={values[f.key]}
            onChange={(e) => onChange(f.key, e.target.value)}
          />
        </Field>
      ))}
    </div>
  );
}
