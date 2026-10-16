// Custom tooltip wrapper for cases where the target element can't carry the
// data-tt attribute itself (third-party children, disabled buttons — which
// don't fire hover reliably). For ordinary buttons/links, skip the wrapper
// and put data-tt="Label" (and data-tt-pos="bottom" near the viewport top)
// straight on the element — the styling lives in globals.css.
//
// A disabled child cannot take focus, so the wrapper takes the tab stop in
// its place (STYLEGUIDE §Accessibility: anything hoverable reveals its
// tooltip on focus-visible, and a data-tt on a non-interactive element gets
// tabIndex={0}) and carries the sentence as its accessible name, so a
// keyboard or screen-reader user learns why the control is off. An enabled
// child keeps the focus itself and the wrapper stays inert, exactly as
// before.

import { isValidElement } from "react";

export function Tooltip({
  label,
  side = "top",
  children,
  className = "",
}: {
  label: string;
  side?: "top" | "bottom";
  children: React.ReactNode;
  className?: string;
}) {
  const childDisabled = isValidElement<{ disabled?: boolean }>(children) && children.props.disabled === true;
  return (
    <span
      className={`inline-flex ${className}`}
      data-tt={label}
      data-tt-pos={side === "bottom" ? "bottom" : undefined}
      tabIndex={childDisabled ? 0 : undefined}
      role={childDisabled ? "note" : undefined}
      aria-label={childDisabled ? label : undefined}
    >
      {children}
    </span>
  );
}
