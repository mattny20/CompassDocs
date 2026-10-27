// The one heading of a sign-in surface (1.16.0, STYLEGUIDE §Sign-in
// surfaces): the step's h1 and a line under it. tabIndex -1 so a step
// without a field can take focus on its heading. Server-safe.

import type { Ref } from "react";

export function AuthHeading({
  title,
  subtitle,
  ref,
}: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  ref?: Ref<HTMLHeadingElement>;
}) {
  return (
    <header className="mb-8">
      <h1 id="auth-title" ref={ref} tabIndex={-1} className="text-balance text-3xl font-bold tracking-[-0.02em] text-slate-900">
        {title}
      </h1>
      {subtitle && <p className="mt-2 text-sm text-slate-500 wrap-anywhere">{subtitle}</p>}
    </header>
  );
}
