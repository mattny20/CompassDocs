"use client";

// The request form's questions (a request type's `form`): one card per
// question with its label, kind, whether it is required, a help line and,
// for a choice or a list, its options (label and an optional hint, such as
// a price). Questions move up and down and are removed from their card's
// own buttons; Add question appends one. Keys are made from the label
// when a question is added and kept after that, so workflows that refer
// to a field (a start date to wait for) keep working when it is renamed.

import { ArrowDown, ArrowUp, Plus, Trash2, X } from "lucide-react";
import { Button, iconButtonClass } from "@/components/Button";
import { Field, Select, TextInput } from "@/components/form";
import { SectionEmpty } from "@/components/form";
import type { HdFormField, HdFormFieldType } from "@/lib/helpdesk/types";

export const FIELD_TYPE_LABEL: Record<HdFormFieldType, string> = {
  text: "Short answer",
  textarea: "Long answer",
  choice: "Pick one (cards)",
  select: "Pick one (list)",
  checkbox: "Yes / no",
  date: "Date",
  // 1.20.6: a date with a time, for requests that go on the calendar (lib/helpdesk/desk-calendar).
  datetime: "Date and time",
  number: "Number",
  user: "A person",
};

function keyFrom(label: string, taken: Set<string>): string {
  let base = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 34);
  if (!/^[a-z]/.test(base)) base = `q_${base}`.replace(/_+$/, "");
  if (!base || base === "q") base = "question";
  let k = base;
  let n = 2;
  while (taken.has(k)) k = `${base}_${n++}`;
  return k;
}

/**
 * The words the builder uses, for a form that isn't a request form (1.20.5: the "Before you solve" closing
 * fields, Desk settings → Before you solve). Left out, it reads as the request form's builder always has.
 */
export interface FormBuilderCopy {
  /** "Question" (the default) or "Field": the card's label, as in "Question 2". */
  noun?: string;
  /** The line shown while there are none. */
  empty?: string;
  /** The label field's placeholder. */
  placeholder?: string;
  /** An option's placeholder. */
  optionPlaceholder?: string;
  /** 1.20.6, with `single`: the label field's own label ("Label"). */
  label?: string;
  /** 1.20.6: the kind select's label ("Kind"); left out, "Kind of answer". */
  kindLabel?: string;
}

export function FormBuilder({
  form,
  onChange,
  copy,
  max = 40,
  single = false,
  kinds,
}: {
  form: HdFormField[];
  onChange: (next: HdFormField[]) => void;
  copy?: FormBuilderCopy;
  /** How many the form may hold (the request form's 40 by default). */
  max?: number;
  /**
   * 1.20.6 (Desk settings → Custom fields): the form is one field edited on its own, so the builder draws only that
   * field's label, kind, help line and options: no number, no move or remove, no Required tick and no Add button.
   */
  single?: boolean;
  /** 1.20.6: the kinds offered and what each is called here; left out, every kind as the request form names it. */
  kinds?: { value: HdFormFieldType; label: string }[];
}) {
  const Noun = copy?.noun ?? "Question";
  const noun = Noun.toLowerCase();
  const set = (i: number, p: Partial<HdFormField>) => onChange(form.map((f, j) => (j === i ? { ...f, ...p } : f)));
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= form.length) return;
    const next = form.slice();
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };
  const add = () => {
    const taken = new Set(form.map((f) => f.key));
    onChange([...form, { key: keyFrom(`question ${form.length + 1}`, taken), label: "", type: "text", required: false }]);
  };

  return (
    <div className="space-y-3">
      {form.length === 0 && !single && <SectionEmpty>{copy?.empty ?? "No extra questions: people write a subject and a description."}</SectionEmpty>}
      {form.map((f, i) => {
        const n = i + 1;
        const hasOptions = f.type === "choice" || f.type === "select";
        return (
          <fieldset key={i} className={single ? "min-w-0" : "rounded-lg border border-slate-200 p-3"}>
            <legend className="sr-only">{Noun} {n}</legend>
            <div className="flex items-start gap-2">
              {!single && (
                <span className="mt-7 w-5 shrink-0 text-right text-xs tabular-nums text-slate-500" aria-hidden>
                  {n}
                </span>
              )}
              <div className="grid min-w-0 flex-1 gap-3 sm:grid-cols-[minmax(0,1fr)_12rem]">
                <Field label={single ? (copy?.label ?? "Label") : `${Noun} ${n}`}>
                  <TextInput
                    value={f.label}
                    maxLength={200}
                    placeholder={copy?.placeholder ?? "What do you need?"}
                    onChange={(e) => {
                      const label = e.target.value;
                      // A brand-new question takes its key from its first label.
                      const fresh = /^question(_\d+)?$/.test(f.key) || /^q_/.test(f.key);
                      const taken = new Set(form.filter((_, j) => j !== i).map((x) => x.key));
                      set(i, fresh && label.trim() ? { label, key: keyFrom(label, taken) } : { label });
                    }}
                  />
                </Field>
                <Field label={copy?.kindLabel ?? "Kind of answer"}>
                  <Select
                    value={f.type}
                    onChange={(e) => {
                      const type = e.target.value as HdFormFieldType;
                      set(i, { type, options: type === "choice" || type === "select" ? f.options?.length ? f.options : [{ value: "option_1", label: "" }] : undefined });
                    }}
                  >
                    {(kinds ?? (Object.keys(FIELD_TYPE_LABEL) as HdFormFieldType[]).map((t) => ({ value: t, label: FIELD_TYPE_LABEL[t] }))).map((k) => (
                      <option key={k.value} value={k.value}>
                        {k.label}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Help line (optional)" className="sm:col-span-2">
                  <TextInput value={f.help ?? ""} maxLength={500} onChange={(e) => set(i, { help: e.target.value || undefined })} />
                </Field>
                {hasOptions && (
                  <div className="sm:col-span-2">
                    <p className="mb-1 text-xs font-medium text-slate-500">Options</p>
                    <ul className="space-y-1.5">
                      {(f.options ?? []).map((o, oi) => (
                        <li key={oi} className="flex items-center gap-2">
                          <TextInput
                            dense
                            className="min-w-0 flex-1"
                            aria-label={`Option ${oi + 1} of ${noun} ${n}`}
                            value={o.label}
                            maxLength={200}
                            placeholder={copy?.optionPlaceholder ?? "Developer laptop"}
                            onChange={(e) => {
                              const opts = (f.options ?? []).slice();
                              const taken = new Set(opts.filter((_, j) => j !== oi).map((x) => x.value));
                              const fresh = /^option_\d+$/.test(o.value);
                              opts[oi] = { ...o, label: e.target.value, value: fresh && e.target.value.trim() ? keyFrom(e.target.value, taken) : o.value };
                              set(i, { options: opts });
                            }}
                          />
                          <TextInput
                            dense
                            className="min-w-0 flex-1"
                            aria-label={`Hint for option ${oi + 1} of ${noun} ${n}`}
                            value={o.hint ?? ""}
                            maxLength={200}
                            placeholder="Hint (optional)"
                            onChange={(e) => {
                              const opts = (f.options ?? []).slice();
                              opts[oi] = { ...o, hint: e.target.value || undefined };
                              set(i, { options: opts });
                            }}
                          />
                          <button
                            type="button"
                            disabled={(f.options ?? []).length <= 1}
                            onClick={() => set(i, { options: (f.options ?? []).filter((_, j) => j !== oi) })}
                            aria-label={`Remove option ${oi + 1} of ${noun} ${n}`}
                            data-tt="Remove"
                            className={iconButtonClass("quiet", "sm")}
                          >
                            <X aria-hidden />
                          </button>
                        </li>
                      ))}
                    </ul>
                    <Button
                      variant="ghost"
                      size="sm"
                      icon={<Plus />}
                      className="mt-1.5"
                      disabled={(f.options ?? []).length >= 50}
                      onClick={() => {
                        const opts = f.options ?? [];
                        set(i, { options: [...opts, { value: `option_${opts.length + 1}`, label: "" }] });
                      }}
                    >
                      Add option
                    </Button>
                  </div>
                )}
                {!single && (
                  <label className="inline-flex items-center gap-2 text-sm text-slate-700 sm:col-span-2">
                    <input type="checkbox" checked={!!f.required} onChange={(e) => set(i, { required: e.target.checked })} />
                    Required
                    <span className="text-xs text-slate-500">· key {f.key}</span>
                  </label>
                )}
              </div>
              <div className={single ? "hidden" : "flex shrink-0 flex-col gap-1"}>
                <button type="button" disabled={i === 0} onClick={() => move(i, -1)} aria-label={`Move ${noun} ${n} up`} data-tt="Move up" className={iconButtonClass("quiet", "sm")}>
                  <ArrowUp aria-hidden />
                </button>
                <button type="button" disabled={i === form.length - 1} onClick={() => move(i, 1)} aria-label={`Move ${noun} ${n} down`} data-tt="Move down" className={iconButtonClass("quiet", "sm")}>
                  <ArrowDown aria-hidden />
                </button>
                <button type="button" onClick={() => onChange(form.filter((_, j) => j !== i))} aria-label={`Remove ${noun} ${n}`} data-tt="Remove" className={iconButtonClass("quiet", "sm", "hover-danger")}>
                  <Trash2 aria-hidden />
                </button>
              </div>
            </div>
          </fieldset>
        );
      })}
      {!single && (
        <Button variant="secondary" icon={<Plus />} onClick={add} disabled={form.length >= max}>
          Add {noun}
        </Button>
      )}
    </div>
  );
}
