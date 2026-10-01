// The one button recipe (STYLEGUIDE §Buttons). Four variants, three sizes
// with fixed heights so adjacent controls line up, a busy state that keeps
// the label. Server-safe: buttonClass() is a string helper for the places
// that must stay a bare <button>/<Link> (forms with refs, menu items);
// <Button> is the component for everything else.
//
// Radius scale, for reference: cards rounded-xl, controls rounded-lg, small
// controls rounded-md, chips rounded-full.

import Link from "next/link";
import { Spinner } from "./Spinner";
import type { ComponentProps, ReactNode } from "react";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

const BASE =
  "inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg transition disabled:cursor-not-allowed disabled:opacity-60";

const SIZE: Record<ButtonSize, string> = {
  /** Row actions in tables and dense lists. */
  sm: "h-7 px-2.5 text-xs",
  /** The default: forms, cards, headers. */
  md: "h-9 px-4 text-sm",
  /** Hero and sign-in actions. */
  lg: "h-10 px-5 text-sm",
};

const VARIANT: Record<ButtonVariant, string> = {
  primary: "bg-compass-600 font-semibold text-white shadow-xs hover:bg-compass-700",
  secondary: "border border-slate-200 bg-surface font-medium text-slate-700 hover:bg-slate-50",
  ghost: "font-medium text-slate-600 hover:bg-slate-100 hover:text-slate-800",
  danger: "border border-red-200 bg-surface font-medium text-red-600 hover-danger",
};

export function buttonClass(variant: ButtonVariant = "primary", size: ButtonSize = "md", extra = ""): string {
  return `${BASE} ${SIZE[size]} ${VARIANT[variant]} ${extra}`.trim();
}

/** Icon-only controls (STYLEGUIDE §Buttons): a square box no smaller than
 *  28px (WCAG 2.5.8), `quiet` for toolbars and rows, `bordered` where it
 *  stands alone. The caller supplies data-tt and aria-label. */
export function iconButtonClass(variant: "quiet" | "bordered" = "quiet", size: "sm" | "md" = "sm", extra = ""): string {
  const box = size === "sm" ? "h-7 w-7 [&>svg]:h-4 [&>svg]:w-4" : "h-9 w-9 [&>svg]:h-4 [&>svg]:w-4";
  const look =
    variant === "bordered"
      ? "rounded-lg border border-slate-200 bg-surface text-slate-500 hover:bg-slate-50 hover:text-slate-700"
      : "rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-700";
  return `inline-flex shrink-0 items-center justify-center transition disabled:cursor-not-allowed disabled:opacity-60 ${box} ${look} ${extra}`.trim();
}

type Common = {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Shows a spinner before the label and disables the control; the label
   *  stays so the row does not jump and the action stays readable. */
  busy?: boolean;
  /** A lucide icon element; sized here. */
  icon?: ReactNode;
  children?: ReactNode;
  className?: string;
};

type ButtonProps = Common & Omit<ComponentProps<"button">, keyof Common | "children"> & { href?: undefined };
type LinkProps = Common & Omit<ComponentProps<typeof Link>, keyof Common | "children"> & { href: string };

export function Button(props: ButtonProps | LinkProps) {
  const { variant = "primary", size = "md", busy = false, icon, children, className = "", ...rest } = props;
  const glyph = size === "sm" ? "[&>svg]:h-3.5 [&>svg]:w-3.5" : "[&>svg]:h-4 [&>svg]:w-4";
  const cls = buttonClass(variant, size, className);
  const body = (
    <>
      {busy ? (
        <Spinner size={size === "sm" ? "sm" : "md"} />
      ) : (
        icon && (
          <span className={`shrink-0 ${glyph}`} aria-hidden>
            {icon}
          </span>
        )
      )}
      {children}
    </>
  );
  if ("href" in rest && typeof rest.href === "string") {
    const { href, ...link } = rest as Omit<LinkProps, keyof Common>;
    return (
      <Link href={href} className={cls} {...link}>
        {body}
      </Link>
    );
  }
  const { type = "button", disabled, ...btn } = rest as Omit<ButtonProps, keyof Common>;
  return (
    <button type={type} className={cls} disabled={disabled || busy} aria-busy={busy || undefined} {...btn}>
      {body}
    </button>
  );
}
