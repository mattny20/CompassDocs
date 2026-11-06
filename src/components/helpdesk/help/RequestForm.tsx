"use client";

// A request form (/help/new/[slug], 1.19.0, the approved "form" preview):
// the request type's own questions, rendered from its field definitions,
// beside "What happens next", the type's workflow as the requester will
// live it with the approver already named. A type with no questions, and
// the general request (/help/new, "Send a request" under the guide
// search), ask for a subject and a description instead. The page resolves
// the type, the workflow preview and the directory prefill on the server
// (form-data.ts), so the form arrives whole.
//
// Validation is inline (STYLEGUIDE §Forms): required fields are checked on
// Send with the rules the API enforces, the first one missing takes focus,
// and a refusal from the server is a FormError above the buttons.

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Bell,
  CircleCheckBig,
  Hourglass,
  ListChecks,
  MessageSquare,
  Stamp,
  X,
} from "lucide-react";
import { CARD_CLASS } from "@/components/Card";
import { Eyebrow } from "@/components/Heading";
import { Button, iconButtonClass } from "@/components/Button";
import { Field, FormError, Select, TextInput, Textarea } from "@/components/form";
import { EntityPicker, type PickerOption } from "@/components/EntityPicker";
import { toast } from "@/components/Toasts";
import type { HdFormAnswers, HdFormField, HdRequestType } from "@/lib/helpdesk/types";
import type { HdNextStep } from "@/lib/helpdesk/types";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import { PageHeader } from "@/components/PageHeader";
import { fetchJson, requestTypeIcon } from "./shared";
import { AttachButton, AttachmentChips, useUploads } from "./attachments";
import { TeamClosedNotice } from "./TeamClosedNotice";

export const SUBJECT_MAX = 200;
export const BODY_MAX = 10000;
const TEXT_MAX = 500;
const TEXTAREA_MAX = 5000;

/** Fields that sit two to a row: one line each. */
const SHORT: ReadonlySet<HdFormField["type"]> = new Set(["text", "date", "number", "select", "user"]);

const STEP_ICON: Record<HdNextStep["kind"], React.ReactNode> = {
  approval: <Stamp />,
  task: <ListChecks />,
  wait: <Hourglass />,
  notify: <Bell />,
  finish: <CircleCheckBig />,
  reply: <MessageSquare />,
};

/** The subject a form-only request is filed under: "New laptop or device: Developer laptop". */
export function deriveSubject(t: HdRequestType, answers: HdFormAnswers): string {
  const choice = t.form.find((f) => (f.type === "choice" || f.type === "select") && answers[f.key]);
  const label = choice?.options?.find((o) => o.value === String(answers[choice.key]))?.label;
  const textField = t.form.find((f) => f.type === "text" && typeof answers[f.key] === "string" && answers[f.key]);
  const tail = label || (textField ? String(answers[textField.key]) : "");
  return (tail ? `${t.title}: ${tail}` : t.title).slice(0, SUBJECT_MAX);
}

/**
 * Does this form also ask for a subject and a description? The general
 * request does, and so does a type whose questions hold no long answer
 * (Report a problem asks only how much it stops you): without them the
 * desk would get a ticket with nothing to read.
 */
export function asksSubject(t: HdRequestType | null): boolean {
  return !t || !t.form.some((f) => f.type === "textarea");
}

export function isBlank(v: HdFormAnswers[string] | undefined): boolean {
  return v === undefined || v === null || v === "" || v === false;
}

export function RequestForm({
  type,
  nextSteps = [],
  defaults = {},
  initialSubject = "",
  closedNotice = null,
}: {
  /** The answering team's "closed" sentence (office hours, a holiday); null while it is open. */
  closedNotice?: string | null;
  /** Null: the general request. */
  type: HdRequestType | null;
  nextSteps?: HdNextStep[];
  defaults?: HdFormAnswers;
  initialSubject?: string;
}) {
  const router = useRouter();
  const slug = type?.slug ?? null;
  const [answers, setAnswers] = useState<HdFormAnswers>(() => ({ ...defaults }));
  const [subject, setSubject] = useState(initialSubject);
  const [body, setBody] = useState("");
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const uploads = useUploads();
  const refs = useRef(new Map<string, HTMLElement | null>());

  const fields = useMemo(() => type?.form ?? [], [type]);
  // A type without questions asks what a general request asks.
  const freeForm = asksSubject(type);

  const errors = useMemo(() => {
    const out: Record<string, string> = {};
    if (!tried) return out;
    if (freeForm) {
      if (!subject.trim()) out.__subject = "Say in a few words what you need.";
      if (!body.trim()) out.__body = "Tell us a little more.";
    }
    for (const f of fields) {
      if (f.required && isBlank(answers[f.key])) out[f.key] = f.type === "choice" ? "Pick one." : "This is needed.";
      if (f.type === "number" && !isBlank(answers[f.key]) && Number.isNaN(Number(answers[f.key]))) out[f.key] = "Enter a number.";
    }
    return out;
  }, [tried, freeForm, subject, body, fields, answers]);

  function set(key: string, value: HdFormAnswers[string]) {
    setAnswers((a) => ({ ...a, [key]: value }));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setTried(true);
    setError("");
    // The same checks as `errors`, computed now (state lands next render).
    const bad: string[] = [];
    if (freeForm && !subject.trim()) bad.push("__subject");
    if (freeForm && !body.trim()) bad.push("__body");
    for (const f of fields) if (f.required && isBlank(answers[f.key])) bad.push(f.key);
    if (bad.length > 0) {
      refs.current.get(bad[0])?.focus();
      return;
    }
    if (uploads.busy) {
      setError("Wait for the attachments to finish uploading.");
      return;
    }
    setBusy(true);
    const res = await fetchJson<{ ticket?: { number: number }; request?: { number: number } }>(
      "/api/helpdesk/requests",
      {
        method: "POST",
        body: JSON.stringify({
          request_type_id: type?.id ?? null,
          subject: freeForm ? subject.trim() : deriveSubject(type!, answers),
          body: body.trim(),
          answers,
          source: "portal",
          attachments: uploads.done,
        }),
      },
      "Couldn't send your request. Try again in a moment."
    );
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    const number = res.data.ticket?.number ?? res.data.request?.number;
    toast("ok", number ? `Request #${number} sent.` : "Request sent.");
    router.push(number ? `/help/requests/${number}` : "/help/requests");
  }

  // The general request has no workflow: the helpdesk replies, then it is solved.
  const steps: HdNextStep[] =
    nextSteps.length > 0 || type
      ? nextSteps
      : [
          { kind: "reply", title: "The helpdesk replies", detail: "We'll email you when they do" },
          { kind: "finish", title: "Sorted, and solved", detail: "Reply any time to reopen it" },
        ];

  // Consecutive one-line fields pair up; choices, long text and checkboxes take the row.
  const rows: HdFormField[][] = [];
  for (const f of fields) {
    const last = rows[rows.length - 1];
    if (SHORT.has(f.type) && last && last.length === 1 && SHORT.has(last[0].type)) last.push(f);
    else rows.push([f]);
  }

  const Icon = requestTypeIcon(type?.icon ?? "lifebuoy");
  const title = type?.title ?? "Send a request";
  return (
    <>
    <Breadcrumbs
      className="mb-2"
      items={[
        { href: "/help", label: "Get help" },
        { href: slug ? `/help/new/${encodeURIComponent(slug)}` : "/help/new", label: title, title },
      ]}
    />
    <PageHeader
      icon={<Icon />}
      title={title}
      subtitle={type?.description || (slug === null ? "Tell us what you need and the right team picks it up." : undefined)}
    />
    <TeamClosedNotice message={closedNotice} className="mb-4" />
    <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_19rem]">
      <form onSubmit={submit} noValidate className={`${CARD_CLASS} flex flex-col gap-5 p-5 sm:p-6`}>
        {freeForm && (
          <>
            <Field label="What do you need?" error={errors.__subject}>
              <TextInput
                ref={(el) => {
                  refs.current.set("__subject", el);
                }}
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                maxLength={SUBJECT_MAX}
                placeholder="Laptop won't connect to the VPN"
                autoFocus={!initialSubject}
              />
            </Field>
            <Field label="Tell us more" error={errors.__body} help="What you tried, what you see, and anything we should know.">
              <Textarea
                ref={(el) => {
                  refs.current.set("__body", el);
                }}
                value={body}
                onChange={(e) => setBody(e.target.value)}
                rows={5}
                maxLength={BODY_MAX}
                autoFocus={!!initialSubject}
              />
            </Field>
          </>
        )}

        {rows.map((row) =>
          row.length === 2 ? (
            <div key={row[0].key} className="grid gap-5 sm:grid-cols-2">
              {row.map((f) => (
                <FormFieldControl key={f.key} field={f} value={answers[f.key]} onChange={(v) => set(f.key, v)} error={errors[f.key]} refs={refs} prefilled={f.key in defaults} />
              ))}
            </div>
          ) : (
            <FormFieldControl key={row[0].key} field={row[0]} value={answers[row[0].key]} onChange={(v) => set(row[0].key, v)} error={errors[row[0].key]} refs={refs} prefilled={row[0].key in defaults} />
          )
        )}

        <AttachmentChips uploads={uploads} />

        <FormError>{error}</FormError>
        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-slate-100 pt-4">
          <span className="mr-auto">
            <AttachButton uploads={uploads} />
          </span>
          <Button variant="secondary" href="/help">
            Cancel
          </Button>
          <Button type="submit" busy={busy}>
            Send request
          </Button>
        </div>
      </form>

      {steps.length > 0 && (
        <aside aria-labelledby="hd-next" className={`${CARD_CLASS} p-5`}>
          <Eyebrow as="h2" className="mb-1">
            <span id="hd-next">What happens next</span>
          </Eyebrow>
          <ol>
            {steps.map((s, i) => (
              <li key={`${s.kind}-${i}`} className="mt-3.5 flex items-start gap-3">
                <span className="grid h-7.5 w-7.5 shrink-0 place-items-center rounded-full bg-compass-50 text-compass-700 [&>svg]:h-3.5 [&>svg]:w-3.5" aria-hidden>
                  {STEP_ICON[s.kind] ?? <ListChecks />}
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-semibold text-slate-900">
                    {i + 1}. {s.title}
                  </span>
                  {s.detail && <span className="block text-xs text-slate-500">{s.detail}</span>}
                </span>
              </li>
            ))}
          </ol>
        </aside>
      )}
    </div>
    </>
  );
}

/** One question, by its type. */
export function FormFieldControl({
  field: f,
  value,
  onChange,
  error,
  refs,
  prefilled,
}: {
  field: HdFormField;
  value: HdFormAnswers[string] | undefined;
  onChange: (v: HdFormAnswers[string]) => void;
  error?: string;
  refs: React.RefObject<Map<string, HTMLElement | null>>;
  /** Prefilled from the person's directory entry: say so under the control. */
  prefilled: boolean;
}) {
  const label = f.required ? f.label : `${f.label} (optional)`;
  const help = f.help || (prefilled && f.default_from ? "From your directory entry" : undefined);
  const ref = (el: HTMLElement | null) => {
    refs.current.set(f.key, el);
  };
  const str = value === null || value === undefined ? "" : String(value);

  if (f.type === "choice") {
    return <ChoiceCards field={f} label={label} value={str} onChange={onChange} error={error} help={help} refFirst={ref} />;
  }
  if (f.type === "checkbox") {
    return (
      <div>
        <label className="flex items-start gap-2.5 text-sm text-slate-700">
          <input
            ref={ref}
            type="checkbox"
            checked={value === true}
            onChange={(e) => onChange(e.target.checked)}
            className="mt-0.5 h-4 w-4"
            aria-invalid={error ? true : undefined}
          />
          <span>
            {label}
            {help && <span className="mt-0.5 block text-xs text-slate-500">{help}</span>}
          </span>
        </label>
        {error && (
          <span role="alert" className="mt-1 block text-xs text-red-600">
            {error}
          </span>
        )}
      </div>
    );
  }
  if (f.type === "user") {
    return <PersonField field={f} label={label} value={value} onChange={onChange} error={error} help={help} refInput={ref} />;
  }
  return (
    <Field label={label} help={help} error={error}>
      {f.type === "textarea" ? (
        <Textarea ref={ref} rows={3} value={str} onChange={(e) => onChange(e.target.value)} maxLength={TEXTAREA_MAX} />
      ) : f.type === "select" ? (
        <Select ref={ref} value={str} onChange={(e) => onChange(e.target.value)}>
          <option value="">Choose…</option>
          {(f.options ?? []).map((o) => (
            <option key={o.value} value={o.value}>
              {o.hint ? `${o.label} · ${o.hint}` : o.label}
            </option>
          ))}
        </Select>
      ) : f.type === "date" ? (
        <TextInput ref={ref} type="date" value={str} onChange={(e) => onChange(e.target.value)} />
      ) : f.type === "number" ? (
        <TextInput ref={ref} type="number" inputMode="decimal" value={str} onChange={(e) => onChange(e.target.value === "" ? "" : e.target.value)} />
      ) : (
        <TextInput ref={ref} value={str} onChange={(e) => onChange(e.target.value)} maxLength={TEXT_MAX} />
      )}
    </Field>
  );
}

/**
 * A choice as radio cards (STYLEGUIDE §Forms, the stacked radio group in a
 * card): a label and its one-line hint per card, two to a row from `sm`,
 * the chosen card in the accent tint. Native radios, so arrows move the
 * choice and the accent comes from the global accent-color rule.
 */
function ChoiceCards({
  field: f,
  label,
  value,
  onChange,
  error,
  help,
  refFirst,
}: {
  field: HdFormField;
  label: string;
  value: string;
  onChange: (v: string) => void;
  error?: string;
  help?: string;
  refFirst: (el: HTMLElement | null) => void;
}) {
  const id = `hd-choice-${f.key}`;
  return (
    <fieldset aria-describedby={error ? `${id}-err` : help ? `${id}-help` : undefined}>
      <legend className="mb-1 block text-xs font-medium text-slate-500">{label}</legend>
      <div role="radiogroup" aria-label={f.label} aria-invalid={error ? true : undefined} className="grid gap-2.5 sm:grid-cols-2">
        {(f.options ?? []).map((o, i) => {
          const on = value === o.value;
          return (
            <label
              key={o.value}
              className={`flex cursor-pointer items-start gap-2.5 rounded-lg border px-3.5 py-3 transition ${
                on ? "border-compass-300 bg-compass-50/60" : "border-slate-200 bg-surface hover:bg-slate-50"
              }`}
            >
              <input
                ref={i === 0 ? refFirst : undefined}
                type="radio"
                name={id}
                value={o.value}
                checked={on}
                onChange={() => onChange(o.value)}
                className="mt-0.5 h-4 w-4 shrink-0"
              />
              <span className="min-w-0">
                <span className="block text-sm font-semibold text-slate-800">{o.label}</span>
                {o.hint && <span className="block text-xs text-slate-500">{o.hint}</span>}
              </span>
            </label>
          );
        })}
      </div>
      {error ? (
        <span id={`${id}-err`} role="alert" className="mt-1 block text-xs text-red-600">
          {error}
        </span>
      ) : help ? (
        <span id={`${id}-help`} className="mt-1 block text-xs text-slate-500">
          {help}
        </span>
      ) : null}
    </fieldset>
  );
}

/** A person: the people picker over the workspace's active accounts, one chosen at a time. */
function PersonField({
  field: f,
  label,
  value,
  onChange,
  error,
  help,
  refInput,
}: {
  field: HdFormField;
  label: string;
  value: HdFormAnswers[string] | undefined;
  onChange: (v: HdFormAnswers[string]) => void;
  error?: string;
  help?: string;
  refInput: (el: HTMLElement | null) => void;
}) {
  const [people, setPeople] = useState<PickerOption[]>([]);
  useEffect(() => {
    let cancelled = false;
    fetchJson<{ users?: { id: number; name: string; username: string }[] }>("/api/users/mentionable", undefined, "").then((r) => {
      if (!cancelled && r.ok) setPeople((r.data.users ?? []).map((u) => ({ id: u.id, label: u.name || u.username, sublabel: u.username })));
    });
    return () => {
      cancelled = true;
    };
  }, []);
  const chosen = typeof value === "number" ? people.find((p) => p.id === value) : undefined;
  return (
    <div ref={refInput} tabIndex={-1}>
      <span className="mb-1 block text-xs font-medium text-slate-500">{label}</span>
      {chosen ? (
        <span className="flex items-center gap-2 rounded-lg border border-slate-200 bg-surface px-3 py-1.5 text-sm text-slate-800">
          <span className="min-w-0 flex-1 truncate">{chosen.label}</span>
          <button
            type="button"
            onClick={() => onChange(null)}
            data-tt="Clear"
            aria-label={`Clear ${f.label}`}
            className={iconButtonClass("quiet", "sm")}
          >
            <X />
          </button>
        </span>
      ) : (
        <EntityPicker options={people} onPick={(id) => onChange(id)} label={f.label} placeholder="Search people…" emptyText="No one matches." />
      )}
      {error ? (
        <span role="alert" className="mt-1 block text-xs text-red-600">
          {error}
        </span>
      ) : help ? (
        <span className="mt-1 block text-xs text-slate-500">{help}</span>
      ) : null}
    </div>
  );
}
