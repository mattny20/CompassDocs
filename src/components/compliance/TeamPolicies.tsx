"use client";

// Compliance › Team (F4, 1.14.0): where the groups this person leads stand
// on the policies that ask their members, from GET /api/compliance/team
// (one row per member and policy, scoped in SQL to the spaces the viewer
// can read). One card per group: its name, "{n} members · {m} confirmed ·
// {k} open" and an error chip "{x} overdue" when anyone is; a table of
// Person (a link to the person's compliance record) / Policy / Status /
// Due / Actions. A member with nothing to confirm still appears; a policy
// the viewer cannot read is a count on the member's row ("and 2 policies
// you can't view"), never a title. Show narrows every table to the open or
// the overdue rows. Remind queues one reminder for one person through POST
// /api/compliance/team; the server's refusal (the row's cadence, "Ben Lo
// was reminded 3 days ago.") is the toast, through useAction. A row the
// POST would refuse (a compliance.team_read holder who leads none of the
// member's groups and manages no programme: `may_remind` false) shows the
// control disabled inside a Tooltip saying why, never one that fails.
//
// The section header and the tab row are the layout's, so the title here
// is a section heading (the page's h1 is "Compliance"), as the Settings
// tab keeps its one sentence under the shared header.

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { BellRing, CircleAlert, UsersRound } from "lucide-react";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { chipClass } from "@/components/Chip";
import { SectionHeading } from "@/components/Heading";
import { EmptyState, SectionEmpty } from "@/components/form";
import { Segmented, type SegmentedOption } from "@/components/Segmented";
import { LoadingRow } from "@/components/Spinner";
import { Table, TABLE_HEAD_ROW, TR, Td, Th } from "@/components/Table";
import { useFormatDate } from "@/components/SettingsProvider";
import { Tooltip } from "@/components/Tooltip";
import { useAction } from "@/lib/use-action";
import type { TeamPolicyRow, TeamPolicyStatus } from "@/lib/db";
import type { TeamViewRow } from "@/lib/team-access";

/** The route's group summary: distinct active members, confirmed rows, open (pending + overdue) rows and overdue rows. */
export interface TeamGroup {
  id: number;
  name: string;
  members: number;
  confirmed: number;
  open: number;
  overdue: number;
}

export interface TeamPayload {
  groups: TeamGroup[];
  /** The route's rows, each with `may_remind` (whether POST would let this viewer remind it). */
  rows: TeamViewRow[];
}

type Show = "all" | "open" | "overdue";

const SHOW_OPTIONS: SegmentedOption<Show>[] = [
  { value: "all", label: "All" },
  { value: "open", label: "Open" },
  { value: "overdue", label: "Overdue" },
];

const LOAD_FAILED = "Couldn't load your team's policies.";
/** The tooltip on a Remind the POST would refuse (the route's 403 for a viewer who leads none of the member's groups). */
const CANNOT_REMIND_TIP = "Only the group's lead or a programme manager can remind";

/** "3 policies" / "1 policy": the count's noun (STYLEGUIDE §Vocabulary). */
function policies(n: number): string {
  return `${n} ${n === 1 ? "policy" : "policies"}`;
}

function members(n: number): string {
  return `${n} ${n === 1 ? "member" : "members"}`;
}

function shows(r: TeamPolicyRow, show: Show): boolean {
  if (show === "all") return true;
  if (show === "open") return r.status === "pending" || r.status === "overdue";
  return r.status === "overdue";
}

/** The closed set of standings (STYLEGUIDE §Status chips), the roster's tones. */
function StatusChip({ status }: { status: TeamPolicyStatus | null }) {
  if (status === "confirmed") return <span className={chipClass("ok")}>Confirmed</span>;
  if (status === "overdue") return <span className={chipClass("error")}>Overdue</span>;
  if (status === "exempt") return <span className={chipClass("neutral")}>Exempt</span>;
  return <span className={chipClass("warn")}>Pending</span>;
}

export function TeamPolicies() {
  const fmt = useFormatDate();
  const { run, isBusy } = useAction();
  const [data, setData] = useState<TeamPayload | null>(null);
  const [loadError, setLoadError] = useState("");
  const [show, setShow] = useState<Show>("all");

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/compliance/team");
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d?.error || LOAD_FAILED);
      setData(d as TeamPayload);
      setLoadError("");
    } catch (e) {
      setLoadError(e instanceof Error && e.message ? e.message : LOAD_FAILED);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const rowsByGroup = useMemo(() => {
    const m = new Map<number, TeamViewRow[]>();
    for (const r of data?.rows ?? []) m.set(r.group_id, [...(m.get(r.group_id) ?? []), r]);
    return m;
  }, [data]);

  // One reminder for one person; the server's own sentence on a refusal
  // (429 inside the cadence, 403 outside the lead's groups, 400 when there
  // is nothing to remind) is the toast. The rows reload so the row's last
  // reminder reads the date the person just got.
  async function remind(r: TeamPolicyRow) {
    if (r.assignment_id == null) return;
    const ok = await run(
      `remind-${r.assignment_id}`,
      () =>
        fetch("/api/compliance/team", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ assignment_id: r.assignment_id }),
        }),
      { fallback: "Couldn't send the reminder.", ok: `Reminder queued for ${r.user_name}.`, refresh: false }
    );
    if (ok) await load();
  }

  return (
    <div>
      <SectionHeading icon={<UsersRound />} className="mb-1">
        Your team&apos;s policies
      </SectionHeading>
      <p className="mb-5 text-sm text-slate-500">Where the groups you lead stand. You also get a weekly summary by email.</p>

      {!data ? (
        loadError ? (
          <EmptyState
            icon={<CircleAlert />}
            title="Couldn't load your team's policies"
            body={loadError}
            action={{ onClick: () => void load(), label: "Try again" }}
          />
        ) : (
          <LoadingRow className="py-10" />
        )
      ) : data.groups.length === 0 ? (
        // A compliance.team_read holder in a workspace with no groups (a lead
        // always has one; the route answers 403 before the page for anyone
        // who leads nothing and holds nothing).
        <EmptyState
          icon={<UsersRound />}
          title="You don't lead any groups yet."
          body="Group leads see where their group's members stand on the policies that ask them, and get a weekly summary by email."
        />
      ) : (
        <>
          <div className="mb-4 print:hidden">
            <Segmented label="Show" size="sm" options={SHOW_OPTIONS} value={show} onChange={setShow} />
          </div>
          <div className="space-y-5">
            {data.groups.map((g) => (
              <GroupCard
                key={g.id}
                group={g}
                rows={rowsByGroup.get(g.id) ?? []}
                show={show}
                date={fmt.date}
                busy={(r) => isBusy(`remind-${r.assignment_id}`)}
                onRemind={(r) => void remind(r)}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function GroupCard({
  group: g,
  rows,
  show,
  date,
  busy,
  onRemind,
}: {
  group: TeamGroup;
  rows: TeamViewRow[];
  show: Show;
  date: (iso: string | null) => string;
  busy: (r: TeamPolicyRow) => boolean;
  onRemind: (r: TeamPolicyRow) => void;
}) {
  const shown = rows.filter((r) => shows(r, show));
  // The hidden count repeats on every row of a member: the first shown row
  // of each member carries the line once.
  const seen = new Set<number>();
  const empty =
    rows.length === 0 ? "No members in this group yet." : show === "overdue" ? "Nobody is overdue." : "No open policies.";

  return (
    <Card
      padding="none"
      title={g.name}
      description={`${members(g.members)} · ${g.confirmed} confirmed · ${g.open} open`}
      actions={
        g.overdue > 0 ? (
          <span className={chipClass("error")}>
            <CircleAlert className="h-3 w-3" aria-hidden /> {g.overdue} overdue
          </span>
        ) : undefined
      }
    >
      {shown.length === 0 ? (
        <SectionEmpty className="px-4 py-4">{empty}</SectionEmpty>
      ) : (
        <Table scroll minWidth="40rem">
          <thead className={TABLE_HEAD_ROW}>
            <tr>
              <Th>Person</Th>
              <Th>Policy</Th>
              <Th fit>Status</Th>
              <Th fit>Due</Th>
              <Th fit className="print:hidden">
                <span className="sr-only">Actions</span>
              </Th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => {
              const first = !seen.has(r.user_id);
              seen.add(r.user_id);
              const canRemind = r.status === "pending" || r.status === "overdue";
              return (
                <tr key={`${r.user_id}-${r.assignment_id ?? "none"}`} className={TR}>
                  <Td>
                    <Link href={`/compliance/person/${r.user_id}`} className="font-medium text-slate-800 hover:text-compass-700">
                      {r.user_name}
                    </Link>
                    <span className="block text-xs text-slate-500">@{r.username}</span>
                    {first && r.assignment_id != null && r.hidden_count > 0 && (
                      <span className="block text-xs text-slate-500">and {policies(r.hidden_count)} you can&apos;t view</span>
                    )}
                  </Td>
                  {r.assignment_id == null ? (
                    // One row for a member with nothing to confirm; when
                    // everything they owe is out of the viewer's scope, the
                    // count is the whole story.
                    <Td colSpan={4}>
                      <SectionEmpty>
                        {r.hidden_count > 0 ? `${policies(r.hidden_count)} you can't view` : "No policies to confirm"}
                      </SectionEmpty>
                    </Td>
                  ) : (
                    <>
                      <Td>
                        <Link href={`/doc/${r.document_id}`} className="font-medium text-slate-800 hover:text-compass-700">
                          {r.title}
                        </Link>
                        {r.reminded_at && <span className="block text-xs text-slate-500">last reminded {date(r.reminded_at)}</span>}
                      </Td>
                      <Td fit>
                        <StatusChip status={r.status} />
                      </Td>
                      {/* The deadline is an instant (policy_assignments.due_at): the
                          instant formatter; blank without one and on an exempt row. */}
                      <Td fit className="text-slate-500">
                        {r.due_at && r.status !== "exempt" ? date(r.due_at) : ""}
                      </Td>
                      <Td fit align="right" className="print:hidden">
                        {canRemind && r.may_remind && (
                          <Button
                            size="sm"
                            variant="secondary"
                            icon={<BellRing />}
                            busy={busy(r)}
                            onClick={() => onRemind(r)}
                            data-tt="Send a reminder now"
                          >
                            Remind
                          </Button>
                        )}
                        {canRemind && !r.may_remind && (
                          // Disabled, with the reason as the wrapper's tooltip
                          // and accessible name (a disabled button takes no
                          // hover or focus of its own; the Tooltip takes both).
                          <Tooltip label={CANNOT_REMIND_TIP}>
                            <Button size="sm" variant="secondary" icon={<BellRing />} disabled>
                              Remind
                            </Button>
                          </Tooltip>
                        )}
                      </Td>
                    </>
                  )}
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}
    </Card>
  );
}
