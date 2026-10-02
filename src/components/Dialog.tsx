"use client";

// Themed confirm and prompt dialogs (STYLEGUIDE §Overlays and modals).
// `confirmDialog()` and `promptDialog()` return promises, so a call site
// reads like the native call it replaces:
//
//   if (!(await confirmDialog({ title: "Delete this webhook?", confirmLabel: "Delete", danger: true }))) return;
//   const pw = await promptDialog({ title: "Set a temporary password", label: "Password", type: "password",
//     validate: (v) => (v.length < 6 ? "At least 6 characters." : undefined) });
//
// One DialogHost is mounted in the app layout beside the ToastHost. The
// dialog sits on the shared overlay stack (Escape closes only it), traps
// Tab, makes the page behind it inert, and hands focus back. Without a
// host (a page outside the shell) the native dialogs are the fallback, so
// nothing ever silently resolves. The editor's leave prompt stays native
// on purpose (lib/use-unsaved).

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { TriangleAlert } from "lucide-react";
import { Button } from "./Button";
import { Field, TextInput, rangeError } from "./form";
import { useModalOverlay } from "./overlay/useModalOverlay";

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

export interface PromptOptions {
  title: string;
  body?: ReactNode;
  label: string;
  initial?: string;
  placeholder?: string;
  type?: "text" | "password" | "number" | "url" | "email";
  /** Return a message to block, undefined to accept. */
  validate?: (value: string) => string | undefined;
  /** For type="number": bounds checked with rangeError. */
  min?: number;
  max?: number;
  /** Empty is refused unless false. */
  required?: boolean;
  confirmLabel?: string;
  cancelLabel?: string;
  help?: ReactNode;
}

type Request =
  | { kind: "confirm"; opts: ConfirmOptions; resolve: (v: boolean | "secondary") => void }
  | { kind: "prompt"; opts: PromptOptions; resolve: (v: string | null) => void };

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

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

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

function DialogCard({ req, onDone }: { req: Request; onDone: () => void }) {
  const panel = useRef<HTMLFormElement>(null);
  const [value, setValue] = useState(req.kind === "prompt" ? (req.opts.initial ?? "") : "");
  const [error, setError] = useState<string | undefined>();
  const [typed, setTyped] = useState("");
  const settled = useRef(false);
  const titleId = "dialog-title";
  const bodyId = "dialog-body";

  function settle(result: boolean | "secondary" | string | null) {
    if (settled.current) return;
    settled.current = true;
    if (req.kind === "confirm") req.resolve(result as boolean | "secondary");
    else req.resolve(result as string | null);
    onDone();
  }
  const cancel = useCallback(() => settle(req.kind === "confirm" ? false : null), []); // eslint-disable-line react-hooks/exhaustive-deps

  useModalOverlay(true, cancel, { panelRef: panel });

  // Initial focus: the input when there is one, Cancel for a destructive
  // confirm (so Enter can't delete by reflex), else the confirm button.
  useEffect(() => {
    const el = panel.current;
    if (!el) return;
    const input = el.querySelector<HTMLElement>("input");
    const danger = req.kind === "confirm" && req.opts.danger;
    const target = input ?? el.querySelector<HTMLElement>(danger ? '[data-dialog="cancel"]' : '[data-dialog="confirm"]');
    (target ?? el).focus();
  }, [req]);

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key !== "Tab" || !panel.current) return;
    const items = Array.from(panel.current.querySelectorAll<HTMLElement>(FOCUSABLE));
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  function submit(e?: React.FormEvent) {
    e?.preventDefault();
    if (req.kind === "prompt") {
      const o = req.opts;
      const v = value;
      let msg: string | undefined;
      if ((o.required ?? true) && !v.trim()) msg = "Enter a value.";
      else if (o.type === "number" && (o.min !== undefined || o.max !== undefined))
        msg = rangeError(v, o.min ?? -Infinity, o.max ?? Infinity);
      else if (o.validate) msg = o.validate(v);
      if (msg) {
        setError(msg);
        return;
      }
      settle(v);
      return;
    }
    settle(true);
  }

  const danger = req.kind === "confirm" && Boolean(req.opts.danger);
  const needsWord = req.kind === "confirm" ? req.opts.typeToConfirm : undefined;
  const wordOk = !needsWord || typed.trim().toLowerCase() === needsWord.trim().toLowerCase();
  const confirmLabel = req.opts.confirmLabel ?? (req.kind === "confirm" ? "Confirm" : "OK");
  const cancelLabel = req.opts.cancelLabel ?? "Cancel";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onMouseDown={(e) => e.target === e.currentTarget && cancel()}>
      <form
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={req.opts.body ? bodyId : undefined}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        onSubmit={submit}
        className="w-full max-w-md rounded-xl border border-slate-200 bg-surface p-5 shadow-modal outline-hidden"
      >
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

        {req.kind === "prompt" && (
          <div className="mt-4">
            <Field label={req.opts.label} error={error} help={req.opts.help}>
              <TextInput
                type={req.opts.type ?? "text"}
                value={value}
                onChange={(e) => {
                  setValue(e.target.value);
                  if (error) setError(undefined);
                }}
                placeholder={req.opts.placeholder}
                min={req.opts.min}
                max={req.opts.max}
                autoComplete={req.opts.type === "password" ? "new-password" : "off"}
                spellCheck={false}
              />
            </Field>
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
              <TextInput value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} />
            </Field>
          </div>
        )}

        <div className="mt-5 flex flex-wrap items-center justify-end gap-2">
          <Button type="button" variant="ghost" data-dialog="cancel" onClick={cancel}>
            {cancelLabel}
          </Button>
          {req.kind === "confirm" && req.opts.secondary && (
            <Button type="button" variant="secondary" onClick={() => settle("secondary")}>
              {req.opts.secondary.label}
            </Button>
          )}
          <Button type="submit" variant={danger ? "danger" : "primary"} data-dialog="confirm" disabled={!wordOk}>
            {confirmLabel}
          </Button>
        </div>
      </form>
    </div>
  );
}
