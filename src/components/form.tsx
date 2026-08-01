"use client";

// Shared form primitives for settings pages (STYLEGUIDE.md "Settings pages"):
// one way to render a labeled control with help text and a field-level error.
// Field wraps any control; TextInput/Select/Textarea are the standard styled
// controls; Toggle is a switch for boolean options. Inline errors here are
// field validation — action results still go through components/Toasts.

import { forwardRef, useId } from "react";

export function Field({
  label,
  help,
  error,
  children,
}: {
  label: React.ReactNode;
  /** Muted line under the control; hidden while an error is shown. */
  help?: React.ReactNode;
  /** Field-level validation error (red, replaces help). */
  error?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-slate-500">{label}</span>
      {children}
      {error ? (
        <span className="mt-1 block text-xs text-red-600">{error}</span>
      ) : help ? (
        <span className="mt-1 block text-xs text-slate-400">{help}</span>
      ) : null}
    </label>
  );
}

const control =
  "w-full rounded-lg border bg-surface px-3 py-2 text-sm outline-hidden focus:ring-2 " +
  "placeholder:text-slate-400 disabled:opacity-50";
const controlOk = "border-slate-200 focus:border-compass-400 focus:ring-compass-100";
const controlErr = "border-red-300 focus:border-red-400 focus:ring-red-100";

export function controlClass(hasError?: boolean, extra = ""): string {
  return `${control} ${hasError ? controlErr : controlOk} ${extra}`.trim();
}

type InputProps = React.InputHTMLAttributes<HTMLInputElement> & { hasError?: boolean };
export const TextInput = forwardRef<HTMLInputElement, InputProps>(function TextInput(
  { hasError, className = "", ...props },
  ref
) {
  return <input ref={ref} className={controlClass(hasError, className)} {...props} />;
});

type SelectProps = React.SelectHTMLAttributes<HTMLSelectElement> & { hasError?: boolean };
export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { hasError, className = "", ...props },
  ref
) {
  return <select ref={ref} className={controlClass(hasError, className)} {...props} />;
});

type TextareaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement> & { hasError?: boolean };
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { hasError, className = "", ...props },
  ref
) {
  return <textarea ref={ref} className={controlClass(hasError, className)} {...props} />;
});

/** A labeled switch for boolean settings. Label first, switch aligned right. */
export function Toggle({
  label,
  help,
  checked,
  onChange,
  disabled,
}: {
  label: React.ReactNode;
  help?: React.ReactNode;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="flex items-start justify-between gap-4">
      <label htmlFor={id} className="min-w-0 cursor-pointer">
        <span className="block text-sm font-medium text-slate-800">{label}</span>
        {help && <span className="mt-0.5 block text-xs text-slate-400">{help}</span>}
      </label>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={`relative mt-0.5 h-5 w-9 shrink-0 rounded-full transition disabled:opacity-50 ${
          checked ? "bg-compass-600" : "bg-slate-300"
        }`}
      >
        <span
          className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-[left] ${
            checked ? "left-[18px]" : "left-0.5"
          }`}
        />
      </button>
    </div>
  );
}

/**
 * The red-bordered card for destructive actions (delete, restore-over,
 * disconnect). One per page, at the bottom, so danger never hides among
 * routine controls.
 */
export function DangerZone({
  title = "Danger zone",
  children,
}: {
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-red-200 p-4 dark:border-red-900/50">
      <h3 className="mb-3 text-sm font-semibold text-red-700">{title}</h3>
      <div className="space-y-3">{children}</div>
    </section>
  );
}

/** One row inside a DangerZone: what it does, why it's dangerous, the button. */
export function DangerAction({
  label,
  description,
  children,
}: {
  label: React.ReactNode;
  description: React.ReactNode;
  /** The destructive button itself. */
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="min-w-0">
        <p className="text-sm font-medium text-slate-800">{label}</p>
        <p className="mt-0.5 text-xs text-slate-400">{description}</p>
      </div>
      {children}
    </div>
  );
}
