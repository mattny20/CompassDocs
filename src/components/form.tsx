"use client";

// Shared form primitives (STYLEGUIDE.md "Forms"): one way to render a
// labeled control with help text and a field-level error, and one input
// recipe. Field wraps any control and — through context, so call sites
// need no wiring — hands the control its description (help or error) and
// its invalid state; errors are announced. TextInput/Select/Textarea are
// the standard styled controls; Toggle is a switch for boolean options;
// FormError is the banner for a failure that belongs to the whole form
// (wrong password). Inline errors here are field validation — action
// results still go through components/Toasts.

import { createContext, forwardRef, useContext, useId } from "react";
import Link from "next/link";
import { buttonClass } from "./Button";

/* ---------------------------------------------------------------------------
 * Width scale. Single-line controls have a natural width: a number is a few
 * digits, a name or password a few words, a URL or key a line. Left at
 * w-full they run to the page edge — 2,000px at 2560 Full — so Field and
 * Toggle take a size. Field defaults to full (nothing moves until a call
 * site opts in); Toggle defaults to lg so the switch sits near its label.
 * Grid cells and flex rows keep their own widths: a size is a *cap*.
 * ------------------------------------------------------------------------ */
const SIZE = {
  /** A number, a short code: 10rem. */
  xs: "max-w-40",
  /** A label, a username: 16rem. */
  sm: "max-w-64",
  /** A name, an email, a password: 28rem. */
  md: "max-w-md",
  /** A URL, a key, a long sentence: 36rem. */
  lg: "max-w-xl",
  full: "",
} as const;
export type FieldSize = keyof typeof SIZE;

type FieldA11y = { describedBy?: string; invalid: boolean };
const FieldContext = createContext<FieldA11y | null>(null);

export function Field({
  label,
  help,
  error,
  size = "full",
  className = "",
  children,
}: {
  label: React.ReactNode;
  /** Muted line under the control; hidden while an error is shown. */
  help?: React.ReactNode;
  /** Field-level validation error (red, replaces help, announced). */
  error?: React.ReactNode;
  /** Width cap for a single-line control (see the scale above). */
  size?: FieldSize;
  className?: string;
  children: React.ReactNode;
}) {
  const id = useId();
  const helpId = `${id}-help`;
  const errorId = `${id}-error`;
  const describedBy = error ? errorId : help ? helpId : undefined;
  return (
    <FieldContext.Provider value={{ describedBy, invalid: Boolean(error) }}>
      <div className={`${SIZE[size]} ${className}`.trim()}>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-slate-500">{label}</span>
          {children}
        </label>
        {error ? (
          <span id={errorId} role="alert" className="mt-1 block text-xs text-red-600">
            {error}
          </span>
        ) : help ? (
          <span id={helpId} className="mt-1 block text-xs text-slate-500">
            {help}
          </span>
        ) : null}
      </div>
    </FieldContext.Provider>
  );
}

/**
 * A failure that belongs to the whole form rather than one field — a wrong
 * password, a server that said no. Announced (alert) the moment it appears;
 * renders nothing while empty, so it can sit in the markup unconditionally.
 */
export function FormError({
  children,
  className = "",
}: {
  children?: React.ReactNode;
  className?: string;
}) {
  if (!children) return null;
  return (
    <div role="alert" className={`notice-error rounded-lg border px-3 py-2 text-sm ${className}`.trim()}>
      {children}
    </div>
  );
}

/** Inline validation for a bounded whole number ("Days (0–3650)"). */
export function rangeError(value: number | string, min: number, max: number): string | undefined {
  const n = typeof value === "number" ? value : Number(value);
  if (value === "" || Number.isNaN(n)) return "Enter a number.";
  if (!Number.isInteger(n)) return "Whole numbers only.";
  if (n < min || n > max) return `Must be between ${min} and ${max}.`;
  return undefined;
}

// Keyboard focus is the global :focus-visible outline (globals.css, STYLEGUIDE
// §Focus) — one indicator, not outline + a 1.3:1 ring that nobody could see.
// The border still tints on focus so a mouse click reads as "active" too.
const control = "w-full rounded-lg border bg-surface px-3 py-2 text-sm placeholder:text-slate-400 disabled:opacity-50";
const controlDense = "w-full rounded-lg border bg-surface px-2.5 py-1.5 text-sm placeholder:text-slate-400 disabled:opacity-50";
const controlOk = "border-slate-200 focus:border-compass-500";
const controlErr = "border-red-300 focus:border-red-400";

// A caller's own width, padding, radius, size or surface must win over the
// shared default, and the stylesheet's order says otherwise (w-full is
// emitted after w-44, so both together always came out full width). Drop
// the default of any family the extras set.
const FAMILIES: [RegExp, RegExp][] = [
  [/(^|\s)w-\S+/, /\bw-full\b/],
  [/(^|\s)(?:p|px|pl|pr)-\S+/, /\bpx-[\d.]+\b/],
  [/(^|\s)(?:p|py|pt|pb)-\S+/, /\bpy-[\d.]+\b/],
  [/(^|\s)rounded(?:-\S+)?(?=\s|$)/, /\brounded-lg\b/],
  [/(^|\s)text-(?:2xs|3xs|xs|sm|base|lg|xl|\[[^\]]+\])\b/, /\btext-sm\b/],
  [/(^|\s)bg-\S+/, /\bbg-surface\b/],
];

export function controlClass(hasError?: boolean, extra = "", dense = false): string {
  let base = dense ? controlDense : control;
  for (const [inExtra, inBase] of FAMILIES) if (inExtra.test(extra)) base = base.replace(inBase, "");
  return `${base} ${hasError ? controlErr : controlOk} ${extra}`.replace(/\s+/g, " ").trim();
}

/** The description and invalid state a wrapping Field hands its control. */
function useFieldA11y<P extends { hasError?: boolean; "aria-describedby"?: string; "aria-invalid"?: React.AriaAttributes["aria-invalid"] }>(
  props: P
): { hasError: boolean; describedBy?: string; invalid?: React.AriaAttributes["aria-invalid"] } {
  const ctx = useContext(FieldContext);
  const hasError = props.hasError ?? ctx?.invalid ?? false;
  return {
    hasError,
    describedBy: props["aria-describedby"] ?? ctx?.describedBy,
    invalid: props["aria-invalid"] ?? (hasError ? true : undefined),
  };
}

type ControlExtras = { hasError?: boolean; /** Compact padding for table rows and toolbars. */ dense?: boolean };

type InputProps = React.InputHTMLAttributes<HTMLInputElement> & ControlExtras;
export const TextInput = forwardRef<HTMLInputElement, InputProps>(function TextInput(
  { hasError, dense, className = "", ...props },
  ref
) {
  const a = useFieldA11y({ hasError, ...props });
  return (
    <input
      ref={ref}
      className={controlClass(a.hasError, className, dense)}
      {...props}
      aria-describedby={a.describedBy}
      aria-invalid={a.invalid}
    />
  );
});

type SelectProps = React.SelectHTMLAttributes<HTMLSelectElement> & ControlExtras;
export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { hasError, dense, className = "", ...props },
  ref
) {
  const a = useFieldA11y({ hasError, ...props });
  return (
    <select
      ref={ref}
      className={controlClass(a.hasError, className, dense)}
      {...props}
      aria-describedby={a.describedBy}
      aria-invalid={a.invalid}
    />
  );
});

type TextareaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement> & ControlExtras;
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { hasError, dense, className = "", ...props },
  ref
) {
  const a = useFieldA11y({ hasError, ...props });
  return (
    <textarea
      ref={ref}
      className={controlClass(a.hasError, className, dense)}
      {...props}
      aria-describedby={a.describedBy}
      aria-invalid={a.invalid}
    />
  );
});

/** A labeled switch for boolean settings. Label first, switch aligned right. */
export function Toggle({
  label,
  help,
  checked,
  onChange,
  disabled,
  size = "lg",
  className = "",
}: {
  label: React.ReactNode;
  help?: React.ReactNode;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  /** Width cap for the row; lg by default so the switch stays near its label. */
  size?: FieldSize;
  className?: string;
}) {
  const id = useId();
  const helpId = `${id}-help`;
  return (
    <div className={`flex items-start justify-between gap-4 ${SIZE[size]} ${className}`.trim()}>
      <label htmlFor={id} className="min-w-0 cursor-pointer">
        <span className="block text-sm font-medium text-slate-800">{label}</span>
        {help && (
          <span id={helpId} className="mt-0.5 block text-xs text-slate-500">
            {help}
          </span>
        )}
      </label>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-describedby={help ? helpId : undefined}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        // 44×24: a target that passes WCAG 2.5.8 and stays easy to hit on
        // a 2560 panel. The off track keeps a visible edge (ring) so "off"
        // is a state, not an absence; the knob's travel is in rem so it
        // scales with the interface.
        className={`relative mt-0.5 h-6 w-11 shrink-0 rounded-full transition disabled:opacity-50 ${
          checked ? "bg-compass-600" : "bg-slate-200 ring-1 ring-inset ring-slate-400/60"
        }`}
      >
        <span
          className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-[left] ${
            checked ? "left-[1.375rem]" : "left-0.5"
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

/* ---------------------------------------------------------------------------
 * Empty states (STYLEGUIDE.md "Empty states"). Two tiers, one recipe each:
 * EmptyState is the card a page shows instead of its content; SectionEmpty is
 * the line a list inside a card shows instead of its rows. Nothing else may
 * hand-roll a "nothing here" box — sixteen pages once shipped eleven of them.
 * ------------------------------------------------------------------------ */

/**
 * Where to go to fill the page. Either a destination (`href`, safe to pass
 * from a server component) or a handler already on the page (`onClick`).
 */
export type EmptyAction = { label: string; icon?: React.ReactNode } & (
  | { href: string; onClick?: never }
  | { onClick: () => void; href?: never }
);

const emptyActionClass = buttonClass("primary");

/** The primary button inside an empty state — the same recipe as any primary. */
function EmptyActionButton({ action }: { action: EmptyAction }) {
  const inner = (
    <>
      {action.icon && (
        <span className="[&>svg]:h-4 [&>svg]:w-4" aria-hidden>
          {action.icon}
        </span>
      )}
      {action.label}
    </>
  );
  return action.href ? (
    <Link href={action.href} className={emptyActionClass}>
      {inner}
    </Link>
  ) : (
    <button type="button" onClick={action.onClick} className={emptyActionClass}>
      {inner}
    </button>
  );
}

/**
 * Page-level empty state: the whole page (or its whole content region) has
 * nothing in it yet. Three tiers, echoing the page header — a lucide icon, a
 * headline, a sentence — plus an optional action, so an empty page tells you
 * how to fill it instead of only naming the place.
 *
 * Pass the icon as an *element* (`icon={<Trash2 />}`), never an emoji: size
 * and tone are applied here so every empty state matches, and emoji ignore the
 * workspace accent. For a list inside a card use <SectionEmpty> — no box in a
 * box.
 */
export function EmptyState({
  icon,
  title,
  body,
  action,
  children,
}: {
  /** A lucide icon element, e.g. `<Inbox />`. Sized and toned here. */
  icon: React.ReactNode;
  /** The state in a few words — "Trash is empty". */
  title: React.ReactNode;
  /** A sentence or two: what appears here, and how it gets here. */
  body?: React.ReactNode;
  /** The destination that fills this page, rendered as the primary button. */
  action?: EmptyAction;
  /** Rare extras under the body (search tips, a secondary link). */
  children?: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-slate-200 bg-surface px-4 py-10 text-center shadow-xs">
      <span
        className="block [&>svg]:mx-auto [&>svg]:h-8 [&>svg]:w-8 [&>svg]:text-slate-400"
        aria-hidden
      >
        {icon}
      </span>
      <p className="mt-3 text-base font-semibold text-slate-800">{title}</p>
      {body && <p className="mx-auto mt-1 max-w-md text-sm text-slate-500">{body}</p>}
      {children}
      {action && (
        <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
          <EmptyActionButton action={action} />
        </div>
      )}
    </div>
  );
}

/**
 * Section-level empty state: a list *inside* a card has no rows. Plain text in
 * the flow of the card — never a second bordered box inside the first one.
 * Pass the card's own padding through `className` when the list manages it.
 */
export function SectionEmpty({
  children,
  action,
  className = "",
}: {
  children: React.ReactNode;
  /** Optional inline link to the thing that fills the list. */
  action?: EmptyAction;
  /** Padding when the surrounding list owns it, e.g. `px-4 py-6`. */
  className?: string;
}) {
  return (
    <p className={`text-sm text-slate-500 ${className}`.trim()}>
      {children}
      {action && (
        <>
          {" "}
          {action.href ? (
            <Link href={action.href} className="link font-medium">
              {action.label}
            </Link>
          ) : (
            <button
              type="button"
              onClick={action.onClick}
              className="link font-medium"
            >
              {action.label}
            </button>
          )}
        </>
      )}
    </p>
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
        <p className="mt-0.5 text-xs text-slate-500">{description}</p>
      </div>
      {children}
    </div>
  );
}
