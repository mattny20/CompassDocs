// The identifier once it is chosen (1.16.0): read-only, in the field's own
// 2.5rem box so nothing jumps, with an action (Change, or Sign out on the
// forced password change). Not a Field: a <label> around the button would
// fire it on a click on the words. A long email keeps its domain in view and
// truncates the part before the @. Server-safe.

import { useId } from "react";
import { CircleUserRound } from "lucide-react";

export function IdentifierRow({ label, value, action }: { label: string; value: string; action?: React.ReactNode }) {
  const lid = useId();
  const at = value.lastIndexOf("@");
  const local = at > 0 ? value.slice(0, at) : value;
  const domain = at > 0 ? value.slice(at) : "";
  return (
    <div>
      <span id={lid} className="mb-1 block text-xs font-medium text-slate-500">
        {label}
      </span>
      <div
        role="group"
        aria-labelledby={lid}
        className="flex h-10 min-w-0 items-center gap-2 rounded-lg border border-slate-200 bg-slate-100 pl-3 pr-1 text-base sm:text-sm"
      >
        <CircleUserRound className="h-4 w-4 shrink-0 text-slate-400" aria-hidden />
        {/* Plain text, so a native title for the truncated value is allowed (STYLEGUIDE §Tooltips: never on controls). */}
        <span className="flex min-w-0 flex-1 text-slate-800" title={value}>
          <span className="min-w-0 truncate">{local}</span>
          {/* The domain never shrinks; only a domain wider than the row (less a glimpse of the local part) truncates. */}
          {domain && <span className="max-w-[calc(100%-1.5em)] shrink-0 truncate">{domain}</span>}
        </span>
        {action}
      </div>
    </div>
  );
}
