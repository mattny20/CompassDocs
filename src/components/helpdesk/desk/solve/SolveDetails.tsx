"use client";

// The ticket side panel's "Solve details" card (1.20.5, lib/helpdesk/
// solve-requirements): the "Before you solve" closing answers kept on the
// ticket, read-only, as the Request details card lists the form's answers.
// Each answer shows under the label it was asked with; with more than one
// requirement set, each set's name heads its answers. The card stays after a
// reopen (the answers are kept and asked again only where one is missing).
// Agents only: the requester's side never loads it.

import { CARD_CLASS } from "@/components/Card";
import { EYEBROW_TEXT } from "@/components/Heading";
import { RelativeTime } from "@/components/RelativeTime";
import type { HdSolveDetail } from "@/lib/helpdesk/solve-requirements-shared";

export function SolveDetailsCard({ details }: { details: HdSolveDetail[] | undefined }) {
  const rows = (details ?? []).filter((d) => d.text !== "");
  if (rows.length === 0) return null;
  const groups: { id: number; name: string; rows: HdSolveDetail[] }[] = [];
  for (const d of rows) {
    const g = groups.find((x) => x.id === d.set_id);
    if (g) g.rows.push(d);
    else groups.push({ id: d.set_id, name: d.set_name, rows: [d] });
  }
  // The newest answer says who filled the card in last.
  const last = rows.reduce((a, b) => (Date.parse(b.answered_at) > Date.parse(a.answered_at) ? b : a));
  return (
    <section aria-labelledby="solve-details-h" className={`${CARD_CLASS} p-4`} data-testid="solve-details">
      <h3 id="solve-details-h" className={EYEBROW_TEXT}>
        Solve details
      </h3>
      {groups.map((g) => (
        <div key={g.id} className="mt-2">
          {groups.length > 1 && <p className="text-xs font-semibold text-slate-700">{g.name}</p>}
          <dl className="space-y-2 text-sm">
            {g.rows.map((d) => (
              <div key={`${d.set_id}:${d.key}`}>
                <dt className="text-xs text-slate-500">{d.label}</dt>
                <dd className="whitespace-pre-wrap break-words text-slate-800">{d.text}</dd>
              </div>
            ))}
          </dl>
        </div>
      ))}
      <p className="mt-3 text-xs text-slate-500">
        {last.answered_by_name ? `Filled in by ${last.answered_by_name}` : "Filled in"} <RelativeTime value={last.answered_at} />
      </p>
    </section>
  );
}
