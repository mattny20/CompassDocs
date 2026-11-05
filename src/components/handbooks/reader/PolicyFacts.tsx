// The facts row under a policy's title in the handbook reader (1.18.0):
// Owner, Approved by, Version, Effective, Next review, Applies to. Every
// value comes from data the document already carries (the policy owner,
// the newest version's approver and date, the review schedule) plus the
// handbook's own "applies to"; an empty fact is left out rather than
// shown as a dash, so a plain document reads as a short row. A description
// list, so a screen reader announces each label with its value.
// Server-safe.

export interface PolicyFact {
  label: string;
  value: string;
}

export function PolicyFacts({ facts }: { facts: PolicyFact[] }) {
  const shown = facts.filter((f) => f.value.trim() !== "");
  if (shown.length === 0) return null;
  return (
    <dl className="flex flex-wrap gap-x-7 gap-y-3">
      {shown.map((f) => (
        <div key={f.label} className="min-w-0">
          <dt className="text-3xs font-semibold uppercase tracking-wider text-slate-500">{f.label}</dt>
          <dd className="mt-0.5 text-sm font-medium text-slate-800">{f.value}</dd>
        </div>
      ))}
    </dl>
  );
}
