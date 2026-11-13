"use client";

// A new request in the customer portal: pick what it is about (only the
// request types the admin exposed), answer that type's questions (B's form
// definitions, no directory prefill: a customer is not in the directory),
// say it in your own words, attach files, send. Inline validation on Send,
// the first invalid control focused; the server's refusal shows above Send.
// With the help centre on (1.19.4, C3), articles that might answer it show
// under the subject (RequestSuggestions), and raising the request tells the
// help centre's stats the tab's journey ended in a request.

import { useMemo, useRef, useState } from "react";
import { Send } from "lucide-react";
import { Button } from "@/components/Button";
import { Field, FormError, Select, TextInput, Textarea } from "@/components/form";
import type { HdFormField } from "@/lib/helpdesk/types";
import { portalFetch } from "./client";
import { PortalAttachButton, PortalFileChips } from "./PortalFiles";
import { RequestSuggestions } from "./help/RequestSuggestions";
import { endJourney, journeyId } from "./help/journey";

export interface PortalTypeForForm {
  id: number;
  title: string;
  description: string;
  eta_label: string;
  form: HdFormField[];
}

type Answers = Record<string, string | boolean>;

export function PortalNewRequest({
  types,
  askName,
  initialType,
  helpCentre = false,
}: {
  types: PortalTypeForForm[];
  askName: boolean;
  initialType: number | null;
  /** The help centre is on: suggest articles from the subject. */
  helpCentre?: boolean;
}) {
  const [typeId, setTypeId] = useState<number | null>(initialType && types.some((t) => t.id === initialType) ? initialType : types.length === 1 ? types[0].id : null);
  const type = useMemo(() => types.find((t) => t.id === typeId) ?? null, [types, typeId]);
  const [answers, setAnswers] = useState<Answers>({});
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [name, setName] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState("");
  const [busy, setBusy] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const needsBody = !!type && !type.form.some((f) => f.type === "textarea");

  function pick(id: number) {
    setTypeId(id);
    setAnswers({});
    setErrors({});
    setFormError("");
  }

  function validate(): Record<string, string> {
    const out: Record<string, string> = {};
    if (!type) return { type: "Choose what your request is about." };
    for (const f of type.form) {
      const v = answers[f.key];
      const empty = v === undefined || v === "" || v === false;
      if (f.required && empty) out[f.key] = `${f.label} is required.`;
    }
    if (needsBody && !body.trim()) out.body = "Describe what you need.";
    return out;
  }

  async function send(e: React.FormEvent) {
    e.preventDefault();
    setFormError("");
    const v = validate();
    setErrors(v);
    if (Object.keys(v).length) {
      const first = Object.keys(v)[0];
      formRef.current?.querySelector<HTMLElement>(`[data-field="${first}"] input, [data-field="${first}"] textarea, [data-field="${first}"] select`)?.focus();
      return;
    }
    if (!type) return;
    setBusy(true);
    const form = new FormData();
    form.append("request_type_id", String(type.id));
    form.append("subject", subject);
    form.append("body", body);
    if (askName) form.append("name", name);
    const clean: Record<string, string | boolean | number> = {};
    for (const f of type.form) {
      const a = answers[f.key];
      if (a === undefined || a === "") continue;
      clean[f.key] = f.type === "number" && typeof a === "string" ? Number(a) : a;
    }
    form.append("answers", JSON.stringify(clean));
    for (const f of files) form.append("files", f);
    // The help centre journey this request ends (the server records it).
    if (helpCentre && journeyId()) form.append("j", journeyId());
    const r = await portalFetch<{ number: number }>("/support/api/requests", { method: "POST", body: form }, "Couldn't send your request. Try again.");
    if (r.ok) {
      if (helpCentre) endJourney();
      window.location.assign(`/support/requests/${r.data.number}`);
      return;
    }
    setBusy(false);
    if (r.status === 401) window.location.assign("/support?next=/support/new");
    setFormError(r.error);
  }

  const set = (k: string, v: string | boolean) => setAnswers((a) => ({ ...a, [k]: v }));

  return (
    <form ref={formRef} onSubmit={send} noValidate className="space-y-5">
      <fieldset data-field="type">
        <legend className="mb-2 text-sm font-semibold text-slate-800">What is it about?</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {types.map((t) => {
            const on = t.id === typeId;
            return (
              <label
                key={t.id}
                className={`flex cursor-pointer items-start gap-2.5 rounded-xl border p-3 text-sm transition ${
                  on ? "border-compass-300 bg-compass-50/60" : "border-slate-200 bg-surface hover:bg-slate-50"
                }`}
              >
                <input type="radio" name="request_type" className="mt-0.5" checked={on} onChange={() => pick(t.id)} />
                <span className="min-w-0">
                  <span className="block font-semibold text-slate-900">{t.title}</span>
                  {t.description && <span className="mt-0.5 block text-slate-500">{t.description}</span>}
                  {t.eta_label && <span className="mt-0.5 block text-xs text-slate-500">Usually {t.eta_label}</span>}
                </span>
              </label>
            );
          })}
        </div>
        {errors.type && (
          <p role="alert" className="mt-1 text-xs text-red-600">
            {errors.type}
          </p>
        )}
      </fieldset>

      {type && (
        <div className="space-y-4 rounded-xl border border-slate-200 bg-surface p-4 shadow-xs sm:p-5">
          {askName && (
            <Field label="Your name (optional)" size="md">
              <TextInput autoComplete="name" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
            </Field>
          )}
          <Field label="Subject (optional)">
            <TextInput value={subject} maxLength={300} placeholder={type.title} onChange={(e) => setSubject(e.target.value)} />
          </Field>
          {helpCentre && <RequestSuggestions text={subject} />}
          {type.form.map((f) => (
            <div key={f.key} data-field={f.key}>
              <FormFieldInput field={f} value={answers[f.key]} error={errors[f.key]} onChange={(v) => set(f.key, v)} />
            </div>
          ))}
          <div data-field="body">
            <Field label={needsBody ? "Describe what you need" : "Anything else? (optional)"} error={errors.body}>
              <Textarea rows={5} value={body} maxLength={20000} onChange={(e) => setBody(e.target.value)} className="text-base sm:text-sm" />
            </Field>
          </div>
          <PortalFileChips files={files} onChange={setFiles} />
          <FormError>{formError}</FormError>
          <div className="flex items-center gap-2 border-t border-slate-100 pt-3">
            <PortalAttachButton files={files} onChange={setFiles} onError={setFormError} />
            <Button href="/support/requests" variant="ghost" className="ml-auto">
              Cancel
            </Button>
            <Button type="submit" busy={busy} icon={<Send />}>
              Send request
            </Button>
          </div>
        </div>
      )}
    </form>
  );
}

function FormFieldInput({ field: f, value, error, onChange }: { field: HdFormField; value: string | boolean | undefined; error?: string; onChange: (v: string | boolean) => void }) {
  const label = f.required ? f.label : `${f.label} (optional)`;
  if (f.type === "checkbox") {
    return (
      <div>
        <label className="flex items-start gap-2 text-sm text-slate-800">
          <input type="checkbox" className="mt-0.5" checked={value === true} onChange={(e) => onChange(e.target.checked)} />
          <span>{label}</span>
        </label>
        {f.help && <p className="mt-1 pl-6 text-xs text-slate-500">{f.help}</p>}
        {error && <p role="alert" className="mt-1 pl-6 text-xs text-red-600">{error}</p>}
      </div>
    );
  }
  if (f.type === "choice") {
    return (
      <fieldset>
        <legend className="mb-1 text-xs font-medium text-slate-500">{label}</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {(f.options ?? []).map((o) => (
            <label key={o.value} className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-sm ${value === o.value ? "border-compass-300 bg-compass-50/60" : "border-slate-200"}`}>
              <input type="radio" name={`f-${f.key}`} className="mt-0.5" checked={value === o.value} onChange={() => onChange(o.value)} />
              <span>
                {o.label}
                {o.hint && <span className="block text-xs text-slate-500">{o.hint}</span>}
              </span>
            </label>
          ))}
        </div>
        {f.help && <p className="mt-1 text-xs text-slate-500">{f.help}</p>}
        {error && <p role="alert" className="mt-1 text-xs text-red-600">{error}</p>}
      </fieldset>
    );
  }
  const v = typeof value === "string" ? value : "";
  return (
    <Field label={label} help={f.help} error={error} size={f.type === "textarea" ? "full" : "lg"}>
      {f.type === "textarea" ? (
        <Textarea rows={4} value={v} maxLength={10000} onChange={(e) => onChange(e.target.value)} className="text-base sm:text-sm" />
      ) : f.type === "select" ? (
        <Select value={v} onChange={(e) => onChange(e.target.value)}>
          <option value="">Choose…</option>
          {(f.options ?? []).map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
      ) : (
        <TextInput
          type={f.type === "date" ? "date" : f.type === "datetime" ? "datetime-local" : f.type === "number" ? "number" : "text"}
          value={v}
          maxLength={f.type === "text" ? 500 : undefined}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </Field>
  );
}
