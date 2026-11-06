"use client";

// The small request dialog every CompassDocs trigger opens (1.19.0): Report
// a problem with this page, Ask about this policy, Request access, This
// link is broken. One recipe on components/Modal: a title that says what
// is being sent, one lede naming what it is about (the page, the policy,
// the link), the request type's own questions (prefilled from what the
// trigger knows), a subject and a description when the type asks none of
// its own, then Cancel and one primary. The request carries the trigger as
// its source and what it is about as source_ref, so the desk sees the page
// the person was on. Success toasts with a View action and closes.

import { useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Modal } from "@/components/Modal";
import { Button } from "@/components/Button";
import { Field, FormError, TextInput, Textarea } from "@/components/form";
import { toast } from "@/components/Toasts";
import type { HdFormAnswers, HdRequestType } from "@/lib/helpdesk/types";
import { BODY_MAX, FormFieldControl, SUBJECT_MAX, asksSubject, deriveSubject, isBlank } from "./RequestForm";
import { fetchJson } from "./shared";
import type { TriggerSource } from "./trigger-type";

export interface HelpDialogProps {
  open: boolean;
  onClose: () => void;
  /** "Report a problem with this page". */
  title: string;
  /** One sentence naming what it is about. */
  lede: React.ReactNode;
  source: TriggerSource;
  sourceRef: Record<string, unknown>;
  /** The type the trigger starts (trigger-type.ts); null: a general request. */
  type: HdRequestType | null;
  /** What the trigger knows, for the first questions. */
  prefill: { subject: string; body?: string; answers?: HdFormAnswers };
  /** The description's label ("What's wrong with it?"). */
  bodyLabel?: string;
  confirmLabel?: string;
}

export function HelpRequestDialog(props: HelpDialogProps) {
  const { open, onClose, type } = props;
  const router = useRouter();
  const headingId = useId();
  const [answers, setAnswers] = useState<HdFormAnswers>({});
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const refs = useRef(new Map<string, HTMLElement | null>());
  const free = asksSubject(type);
  const fields = type?.form ?? [];

  // Every opening starts from what the trigger knows.
  useEffect(() => {
    if (!open) return;
    setAnswers({ ...(props.prefill.answers ?? {}) });
    setSubject(props.prefill.subject.slice(0, SUBJECT_MAX));
    setBody(props.prefill.body ?? "");
    setTried(false);
    setError("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const errors: Record<string, string> = {};
  if (tried) {
    if (free && !subject.trim()) errors.__subject = "Say in a few words what's wrong.";
    if (free && !body.trim()) errors.__body = "Tell us a little more.";
    for (const f of fields) if (f.required && isBlank(answers[f.key])) errors[f.key] = f.type === "choice" ? "Pick one." : "This is needed.";
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setTried(true);
    setError("");
    const bad: string[] = [];
    if (free && !subject.trim()) bad.push("__subject");
    if (free && !body.trim()) bad.push("__body");
    for (const f of fields) if (f.required && isBlank(answers[f.key])) bad.push(f.key);
    if (bad.length) {
      refs.current.get(bad[0])?.focus();
      return;
    }
    setBusy(true);
    const res = await fetchJson<{ ticket?: { number: number }; request?: { number: number } }>(
      "/api/helpdesk/requests",
      {
        method: "POST",
        body: JSON.stringify({
          request_type_id: type?.id ?? null,
          subject: free ? subject.trim() : deriveSubject(type!, answers),
          body: body.trim(),
          answers,
          source: props.source,
          source_ref: props.sourceRef,
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
    onClose();
    toast("ok", number ? `Request #${number} sent. We'll keep you posted.` : "Request sent. We'll keep you posted.", {
      action: number ? { label: "View", onClick: () => router.push(`/help/requests/${number}`) } : undefined,
    });
  }

  return (
    <Modal open={open} onClose={onClose} labelledBy={headingId} className="w-full max-w-lg overflow-hidden rounded-xl border border-slate-200 bg-surface shadow-modal">
      <form onSubmit={submit} noValidate className="flex max-h-[85vh] flex-col">
        <div className="overflow-y-auto px-5 pb-2 pt-5">
          <h2 id={headingId} className="text-lg font-semibold text-slate-900">
            {props.title}
          </h2>
          <p className="mt-1 text-sm text-slate-500">{props.lede}</p>
          <div className="mt-4 flex flex-col gap-4">
            {free && (
              <Field label="Subject" error={errors.__subject}>
                <TextInput
                  ref={(el) => {
                    refs.current.set("__subject", el);
                  }}
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  maxLength={SUBJECT_MAX}
                />
              </Field>
            )}
            {fields.map((f) => (
              <FormFieldControl
                key={f.key}
                field={f}
                value={answers[f.key]}
                onChange={(v) => setAnswers((a) => ({ ...a, [f.key]: v }))}
                error={errors[f.key]}
                refs={refs}
                prefilled={false}
              />
            ))}
            {free && (
              <Field label={props.bodyLabel ?? "Tell us more"} error={errors.__body}>
                <Textarea
                  data-autofocus
                  ref={(el) => {
                    refs.current.set("__body", el);
                  }}
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  rows={4}
                  maxLength={BODY_MAX}
                />
              </Field>
            )}
            <FormError>{error}</FormError>
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-slate-100 px-5 py-3.5">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" busy={busy}>
            {props.confirmLabel ?? "Send request"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
