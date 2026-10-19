"use client";

// My policies (B4, 1.12.0): one person's standing on every policy they can
// be asked to confirm. A standing line and the progress bar the Record tab
// draws, then two groups: To confirm (newest ask first) and Confirmed. Each
// row is the space icon, the title as a link to the confirmation card at the
// end of the document, when it was last saved, and one chip from a closed
// set: "To confirm" (warn), "Changed since you confirmed {date}" (warn) or
// "Confirmed {date} · v12" (ok). A filter box appears once there are more
// than ten rows (STYLEGUIDE §Tables). No history, print or CSV here: the
// person record (F3) holds those. "Overdue" and due dates arrive with E1.

import { useState } from "react";
import Link from "next/link";
import { Check, CircleDashed, ShieldCheck } from "lucide-react";
import { Card } from "@/components/Card";
import { chipClass } from "@/components/Chip";
import { Eyebrow } from "@/components/Heading";
import { EmptyState, SectionEmpty } from "@/components/form";
import { ListFilter } from "@/components/ListFilter";
import { RelativeTime } from "@/components/RelativeTime";
import { useFormatDate } from "@/components/SettingsProvider";
import type { MyPolicyRow } from "@/lib/db";

/** The filter box appears above this many rows. */
const FILTER_FROM = 10;

/** "5 policies" / "1 policy". */
function policies(n: number): string {
  return `${n} ${n === 1 ? "policy" : "policies"}`;
}

export function MyPolicies({ rows }: { rows: MyPolicyRow[] }) {
  const fmt = useFormatDate();
  const [filter, setFilter] = useState("");
  const total = rows.length;
  const confirmed = rows.filter((r) => r.state === "confirmed").length;

  if (total === 0) {
    return (
      <EmptyState
        icon={<ShieldCheck />}
        title="Nothing to confirm"
        body="Policies you're asked to read and confirm will appear here with their due dates."
      />
    );
  }

  const needle = filter.trim().toLowerCase();
  const shown = needle
    ? rows.filter((r) => `${r.title} ${r.space_name}`.toLowerCase().includes(needle))
    : rows;
  const toConfirm = shown.filter((r) => r.state !== "confirmed");
  const done = shown.filter((r) => r.state === "confirmed");
  const pct = Math.round((confirmed / total) * 100);

  return (
    <div>
      {/* The standing line and the bar from the Record tab: how far along
          this person is, in the words the portal uses for a policy. */}
      <p className="text-sm font-medium text-slate-700">
        {confirmed} of {policies(total)} confirmed
      </p>
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
            <ul className="divide-y divide-slate-100">
              {toConfirm.map((r) => (
                <PolicyRow key={r.id} row={r} date={fmt.date} />
              ))}
            </ul>
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

      {shown.length === 0 && <SectionEmpty>No policies match.</SectionEmpty>}
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
  if (r.state === "reconfirm") {
    return (
      <span className={chipClass("warn")}>
        <CircleDashed className="h-3 w-3" aria-hidden /> Changed since you confirmed {date(r.prior_acknowledged_at)}
      </span>
    );
  }
  return (
    <span className={chipClass("warn")}>
      <CircleDashed className="h-3 w-3" aria-hidden /> To confirm
    </span>
  );
}
