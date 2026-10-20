"use client";

// My policies (B4, 1.12.0): one person's standing on every policy they can
// be asked to confirm. A standing line and the progress bar the Record tab
// draws, then two groups: To confirm and Confirmed. The server orders the
// first group in the person's priority (E1, 1.13.0): overdue first, then
// the soonest deadline, then the most recently changed; the second most
// recently changed first. Each row is the space icon, the title as a link
// to the confirmation card at the end of the document, when it was last
// saved, and one chip from a closed set: "Overdue · due {date}" (error),
// "To confirm · due {date}" or "To confirm" (warn), "Changed since you
// confirmed {date}" (warn) or "Confirmed {date} · v12" (ok). A filter box
// appears once there are more than ten rows (STYLEGUIDE §Tables). No
// history, print or CSV here: the person record (F3) holds those.

import { useState } from "react";
import Link from "next/link";
import { Check, CircleAlert, CircleDashed, ClipboardCheck, ShieldCheck } from "lucide-react";
import { Card } from "@/components/Card";
import { chipClass } from "@/components/Chip";
import { Eyebrow } from "@/components/Heading";
import { EmptyState, SectionEmpty } from "@/components/form";
import { ListFilter } from "@/components/ListFilter";
import { RelativeTime } from "@/components/RelativeTime";
import { useFormatDate } from "@/components/SettingsProvider";
import { TeamLeadBanner } from "@/components/compliance/TeamLeadBanner";
import type { MyPolicyRow } from "@/lib/db";
import { setGroupLabel } from "@/lib/policy-sets";

/** The filter box appears above this many rows. */
const FILTER_FROM = 10;

/** "5 policies" / "1 policy". */
function policies(n: number): string {
  return `${n} ${n === 1 ? "policy" : "policies"}`;
}

/**
 * The To confirm rows grouped by set (D3, 1.14.0): a row sits under the
 * first of its sets (`set_names[0]`) in that set's order (`set_position`),
 * and rows in no set follow under no heading. A group's label counts the
 * person's rows in that set over every state ("New starter onboarding · 3
 * of 8 done"), so the number holds while the filter narrows the list.
 */
function groupBySet(
  toConfirm: MyPolicyRow[],
  all: MyPolicyRow[]
): { groups: { name: string; label: string; rows: MyPolicyRow[] }[]; rest: MyPolicyRow[] } {
  const bySet = new Map<string, MyPolicyRow[]>();
  const rest: MyPolicyRow[] = [];
  for (const r of toConfirm) {
    const name = r.set_names[0];
    if (!name) rest.push(r);
    else bySet.set(name, [...(bySet.get(name) ?? []), r]);
  }
  const groups = [...bySet].map(([name, rows]) => {
    const mine = all.filter((x) => x.set_names[0] === name);
    const done = mine.filter((x) => x.state === "confirmed").length;
    return {
      name,
      label: setGroupLabel(name, done, mine.length),
      rows: rows.sort((a, b) => (a.set_position ?? 0) - (b.set_position ?? 0)),
    };
  });
  return { groups, rest };
}

export function MyPolicies({ rows }: { rows: MyPolicyRow[] }) {
  const fmt = useFormatDate();
  const [filter, setFilter] = useState("");
  const total = rows.length;
  const confirmed = rows.filter((r) => r.state === "confirmed").length;

  if (total === 0) {
    return (
      <>
        {/* A lead with nothing to confirm themselves still gets the way to their team (F4). */}
        <TeamLeadBanner />
        <EmptyState
          icon={<ShieldCheck />}
          title="Nothing to confirm"
          body="Policies you're asked to read and confirm will appear here with their due dates."
        />
      </>
    );
  }

  const needle = filter.trim().toLowerCase();
  const shown = needle
    ? rows.filter((r) => `${r.title} ${r.space_name}`.toLowerCase().includes(needle))
    : rows;
  const toConfirm = shown.filter((r) => r.state !== "confirmed");
  const done = shown.filter((r) => r.state === "confirmed");
  const grouped = groupBySet(toConfirm, rows);
  const pct = Math.round((confirmed / total) * 100);

  return (
    <div>
      {/* The lead's banner (F4, 1.14.0): one sentence and the link to the
          team page, only for someone that page would open for. */}
      <TeamLeadBanner />
      {/* The standing line and the bar from the Record tab: how far along
          this person is, in the words the portal uses for a policy. Beside
          it the link to the person's own record (F3, 1.14.0): the evidence,
          the prior cycles, print and CSV live there, not here. */}
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <p className="text-sm font-medium text-slate-700">
          {confirmed} of {policies(total)} confirmed
        </p>
        <Link
          href="/compliance/person/me"
          className="inline-flex items-center gap-1.5 text-sm font-medium text-compass-700 hover:underline print:hidden"
        >
          <ClipboardCheck className="h-4 w-4" aria-hidden />
          Your record
        </Link>
      </div>
      <div className="mb-5 mt-2 h-2 overflow-hidden rounded-full bg-slate-100">
        <div className="h-full rounded-full bg-compass-500" style={{ width: `${pct}%` }} />
      </div>

      {total > FILTER_FROM && (
        <ListFilter
          value={filter}
          onChange={setFilter}
          label="Filter policies"
          noun="policies"
          shown={shown.length}
          total={total}
          className="mb-4"
        />
      )}

      {toConfirm.length > 0 && (
        <section aria-label="To confirm" className="mb-6">
          <Eyebrow as="h2">To confirm</Eyebrow>
          <Card padding="none">
            {/* The set groups first (D3), each under its own eyebrow with the
                person's standing in it; then the rows in no set, unlabelled. */}
            {grouped.groups.map((g) => (
              <section key={g.name} aria-label={g.label} className="border-b border-slate-100 last:border-b-0">
                <Eyebrow as="h3" className="border-b border-slate-100 bg-canvas px-4 py-2">
                  {g.label}
                </Eyebrow>
                <ul className="divide-y divide-slate-100">
                  {g.rows.map((r) => (
                    <PolicyRow key={r.id} row={r} date={fmt.date} />
                  ))}
                </ul>
              </section>
            ))}
            {grouped.rest.length > 0 && (
              <ul className="divide-y divide-slate-100">
                {grouped.rest.map((r) => (
                  <PolicyRow key={r.id} row={r} date={fmt.date} />
                ))}
              </ul>
            )}
          </Card>
        </section>
      )}

      {done.length > 0 && (
        <section aria-label="Confirmed">
          <Eyebrow as="h2">Confirmed</Eyebrow>
          <Card padding="none">
            <ul className="divide-y divide-slate-100">
              {done.map((r) => (
                <PolicyRow key={r.id} row={r} date={fmt.date} />
              ))}
            </ul>
            {toConfirm.length === 0 && !needle && (
              <SectionEmpty className="border-t border-slate-100 px-4 py-3">
                You&apos;re up to date. {policies(confirmed)} confirmed.
              </SectionEmpty>
            )}
          </Card>
        </section>
      )}

      {shown.length === 0 && <SectionEmpty>No policies match your filter.</SectionEmpty>}
    </div>
  );
}

function PolicyRow({ row: r, date }: { row: MyPolicyRow; date: (iso: string | null) => string }) {
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3">
      <span className="shrink-0 text-lg" aria-hidden>
        {r.space_icon}
      </span>
      <span className="min-w-0 flex-1">
        <Link
          href={`/doc/${r.id}#confirm-reading`}
          className="block truncate text-sm font-medium text-slate-800 hover:text-compass-700"
        >
          {r.title}
        </Link>
        <span className="block text-xs text-slate-500">
          {r.space_name} · Updated <RelativeTime value={r.updated_at} />
        </span>
      </span>
      <StateChip row={r} date={date} />
    </li>
  );
}

/** The closed set of standings (STYLEGUIDE §Status chips): shown, never a link. */
function StateChip({ row: r, date }: { row: MyPolicyRow; date: (iso: string | null) => string }) {
  if (r.state === "confirmed") {
    return (
      <span className={chipClass("ok")}>
        <Check className="h-3 w-3" aria-hidden /> Confirmed {date(r.acknowledged_at)}
        {r.rev ? ` · v${r.rev}` : ""}
      </span>
    );
  }
  // Overdue (E1) outranks the other two: the deadline is the fact to act on.
  if (r.state === "overdue") {
    return (
      <span className={chipClass("error")}>
        <CircleAlert className="h-3 w-3" aria-hidden /> Overdue · due {date(r.due_at)}
      </span>
    );
  }
  if (r.state === "reconfirm") {
    return (
      <span className={chipClass("warn")}>
        <CircleDashed className="h-3 w-3" aria-hidden /> Changed since you confirmed {date(r.prior_acknowledged_at)}
      </span>
    );
  }
  return (
    <span className={chipClass("warn")}>
      <CircleDashed className="h-3 w-3" aria-hidden /> To confirm{r.due_at ? ` · due ${date(r.due_at)}` : ""}
    </span>
  );
}
