"use client";

// Themed confirm, prompt and small-form dialogs (STYLEGUIDE §Overlays and
// modals). The calls return promises, so a call site reads like the native
// call it replaces:
//
//   if (!(await confirmDialog({ title: "Delete this webhook?", confirmLabel: "Delete", danger: true }))) return;
//   const pw = await promptDialog({ title: "Set a temporary password", label: "Password", type: "password",
//     validate: (v) => (v.length < 6 ? "At least 6 characters." : undefined) });
//   const v = await formDialog({ title: "Insert button", fields: [{ key: "label", label: "Label" }, { key: "href", label: "Link URL", type: "url" }] });
//
// One DialogHost is mounted in the app layout beside the ToastHost. Each
// dialog is a Modal (overlay stack, focus trap, inert background, focus
// back). Without a host (a page outside the shell) the native dialogs are
// the fallback, so nothing ever silently resolves. The editor's leave
// prompt stays native on purpose (lib/use-unsaved).

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { TriangleAlert } from "lucide-react";
import { Button } from "./Button";
import { Field, TextInput, Textarea, rangeError } from "./form";
import { Modal } from "./Modal";

export interface ConfirmOptions {
  title: string;
  /** The consequence, in a sentence or two. */
  body?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Destructive: red button, warning icon, focus starts on Cancel. */
  danger?: boolean;
  /** The word the person must type before the button enables (a name, "RESTORE"). */
  typeToConfirm?: string;
  /** A third choice ("Save as draft"); resolves "secondary". */
  secondary?: { label: string };
}

export interface DialogField {
  key: string;
  label: ReactNode;
  initial?: string;
  placeholder?: string;
  type?: "text" | "password" | "number" | "url" | "email" | "textarea";
  /** Return a message to block, undefined to accept. */
  validate?: (value: string, all: Record<string, string>) => string | undefined;
  /** For type="number": bounds checked with rangeError. */
  min?: number;
  max?: number;
  /** Empty is refused unless false. */
  required?: boolean;
  help?: ReactNode;
  /** Single-line extras (font-mono). */
  className?: string;
}

export interface PromptOptions extends Omit<DialogField, "key" | "label"> {
  title: string;
  body?: ReactNode;
  label: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
}

export interface FormOptions {
  title: string;
  body?: ReactNode;
  fields: DialogField[];
  confirmLabel?: string;
  cancelLabel?: string;
}

type Request =
  | { kind: "confirm"; opts: ConfirmOptions; resolve: (v: boolean | "secondary") => void }
  | { kind: "prompt"; opts: PromptOptions; resolve: (v: string | null) => void }
  | { kind: "form"; opts: FormOptions; resolve: (v: Record<string, string> | null) => void };

let host: ((req: Request) => void) | null = null;

export function confirmDialog(opts: ConfirmOptions): Promise<boolean | "secondary"> {
  return new Promise((resolve) => {
    if (host) host({ kind: "confirm", opts, resolve });
    else resolve(typeof window !== "undefined" && window.confirm(opts.title));
  });
}

export function promptDialog(opts: PromptOptions): Promise<string | null> {
  return new Promise((resolve) => {
    if (host) host({ kind: "prompt", opts, resolve });
    else resolve(typeof window !== "undefined" ? window.prompt(opts.title, opts.initial ?? "") : null);
  });
}

export function formDialog(opts: FormOptions): Promise<Record<string, string> | null> {
  return new Promise((resolve) => {
    if (host) host({ kind: "form", opts, resolve });
    else if (typeof window === "undefined") resolve(null);
    else {
      const out: Record<string, string> = {};
      for (const f of opts.fields) {
        const v = window.prompt(typeof f.label === "string" ? f.label : opts.title, f.initial ?? "");
        if (v === null) return resolve(null);
        out[f.key] = v;
      }
      resolve(out);
    }
  });
}

export function DialogHost() {
  const [queue, setQueue] = useState<Request[]>([]);
  const current = queue[0];

  useEffect(() => {
    host = (req) => setQueue((q) => [...q, req]);
    return () => {
      host = null;
    };
  }, []);

  const finish = useCallback(() => setQueue((q) => q.slice(1)), []);

  if (!current) return null;
  return <DialogCard key={queue.length} req={current} onDone={finish} />;
}

function fieldsOf(req: Request): DialogField[] {
  if (req.kind === "confirm") return [];
  if (req.kind === "form") return req.opts.fields;
  const { title: _t, body: _b, label, confirmLabel: _c, cancelLabel: _x, ...rest } = req.opts;
  return [{ key: "value", label, ...rest }];
}

function DialogCard({ req, onDone }: { req: Request; onDone: () => void }) {
  const fields = fieldsOf(req);
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(fields.map((f) => [f.key, f.initial ?? ""]))
  );
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const [typed, setTyped] = useState("");
  const [settled, setSettled] = useState(false);
  const titleId = "dialog-title";
  const bodyId = "dialog-body";

  function settle(result: boolean | "secondary" | string | Record<string, string> | null) {
    if (settled) return;
    setSettled(true);
    if (req.kind === "confirm") req.resolve(result as boolean | "secondary");
    else if (req.kind === "prompt") req.resolve(result as string | null);
    else req.resolve(result as Record<string, string> | null);
    onDone();
  }
  const cancel = useCallback(() => settle(req.kind === "confirm" ? false : null), []); // eslint-disable-line react-hooks/exhaustive-deps

  function submit(e?: React.FormEvent) {
    e?.preventDefault();
    if (req.kind === "confirm") {
      settle(true);
      return;
    }
    const next: Record<string, string | undefined> = {};
    for (const f of fields) {
      const v = values[f.key] ?? "";
      let msg: string | undefined;
      if ((f.required ?? true) && !v.trim()) msg = "Enter a value.";
      else if (f.type === "number" && v.trim() && (f.min !== undefined || f.max !== undefined))
        msg = rangeError(v, f.min ?? -Infinity, f.max ?? Infinity);
      else if (f.validate) msg = f.validate(v, values);
      if (msg) next[f.key] = msg;
    }
    if (Object.values(next).some(Boolean)) {
      setErrors(next);
      return;
    }
    settle(req.kind === "prompt" ? values.value : values);
  }

  const danger = req.kind === "confirm" && Boolean(req.opts.danger);
  const needsWord = req.kind === "confirm" ? req.opts.typeToConfirm : undefined;
  const wordOk = !needsWord || typed.trim().toLowerCase() === needsWord.trim().toLowerCase();
  const confirmLabel = req.opts.confirmLabel ?? (req.kind === "confirm" ? "Confirm" : "OK");
  const cancelLabel = req.opts.cancelLabel ?? "Cancel";

  return (
    <Modal
      open
      onClose={cancel}
      labelledBy={titleId}
      describedBy={req.opts.body ? bodyId : undefined}
      className="w-full max-w-md rounded-xl border border-slate-200 bg-surface p-5 shadow-modal"
    >
      <form onSubmit={submit}>
        <div className="flex gap-3">
          {danger && (
            <span className="mt-0.5 shrink-0 text-red-600" aria-hidden>
              <TriangleAlert className="h-5 w-5" />
            </span>
          )}
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="text-base font-semibold text-slate-900">
              {req.opts.title}
            </h2>
            {req.opts.body && (
              <div id={bodyId} className="mt-1 text-sm text-slate-600">
                {req.opts.body}
              </div>
            )}
          </div>
        </div>

        {fields.length > 0 && (
          <div className="mt-4 space-y-3">
            {fields.map((f, i) => (
              <Field key={f.key} label={f.label} error={errors[f.key]} help={f.help}>
                {f.type === "textarea" ? (
                  <Textarea
                    value={values[f.key] ?? ""}
                    onChange={(e) => {
                      setValues((v) => ({ ...v, [f.key]: e.target.value }));
                      if (errors[f.key]) setErrors((er) => ({ ...er, [f.key]: undefined }));
                    }}
                    placeholder={f.placeholder}
                    className={`h-24 ${f.className ?? ""}`.trim()}
                    data-autofocus={i === 0 ? "" : undefined}
                  />
                ) : (
                  <TextInput
                    type={f.type ?? "text"}
                    value={values[f.key] ?? ""}
                    onChange={(e) => {
                      setValues((v) => ({ ...v, [f.key]: e.target.value }));
                      if (errors[f.key]) setErrors((er) => ({ ...er, [f.key]: undefined }));
                    }}
                    placeholder={f.placeholder}
                    min={f.min}
                    max={f.max}
                    autoComplete={f.type === "password" ? "new-password" : "off"}
                    spellCheck={false}
                    className={f.className}
                    data-autofocus={i === 0 ? "" : undefined}
                  />
                )}
              </Field>
            ))}
          </div>
        )}

        {needsWord && (
          <div className="mt-4">
            <Field
              label={
                <>
                  Type <span className="font-mono font-semibold text-slate-800">{needsWord}</span> to confirm
                </>
              }
            >
              <TextInput
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                autoComplete="off"
                spellCheck={false}
                data-autofocus=""
              />
            </Field>
          </div>
        )}

        <div className="mt-5 flex flex-wrap items-center justify-end gap-2">
          {/* A destructive confirm starts on Cancel so Enter can't delete by reflex. */}
          <Button type="button" variant="ghost" onClick={cancel} data-autofocus={danger && !needsWord ? "" : undefined}>
            {cancelLabel}
          </Button>
          {req.kind === "confirm" && req.opts.secondary && (
            <Button type="button" variant="secondary" onClick={() => settle("secondary")}>
              {req.opts.secondary.label}
            </Button>
          )}
          <Button
            type="submit"
            variant={danger ? "danger" : "primary"}
            disabled={!wordOk}
            data-autofocus={!danger && fields.length === 0 ? "" : undefined}
          >
            {confirmLabel}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
