"use client";

// The "Team leads" block (F4, 1.14.0): who leads each group, and so who
// gets the scoped team view and the weekly digest. One component for both
// programmes: Training's Overview renders it with its training sentence
// against /api/training/leads (and hands it the picker options it already
// holds), and the compliance Overview renders it for programme managers
// with the policy sentence against /api/compliance/leads, which answers the
// people to pick from as well, because a compliance manager need not hold
// the Training section or its licence. The leads themselves are one table
// (group_leads), so a lead named on either page is a lead on both.
//
// Each picker saves as it changes (a lead is a membership, not a form) and
// toasts; the whole block is a card with one title and one sentence
// (STYLEGUIDE §Sections and cards).

import { useEffect, useState } from "react";
import Link from "next/link";
import { Users } from "lucide-react";
import { Card } from "@/components/Card";
import { EntityPicker, type PickerOption } from "@/components/EntityPicker";
import { SectionEmpty } from "@/components/form";
import { SettingsLink } from "@/components/SettingsLink";
import { toast } from "@/components/Toasts";

interface LeadRow {
  group_id: number;
  group_name: string;
  user_id: number;
}

interface LeadsPayload {
  groups?: { id: number; name: string }[];
  leads?: LeadRow[];
  /** The compliance route's people to pick from (the training route answers none). */
  users?: PickerOption[];
  /** The compliance route only: whether Program settings let leads see policy standing. */
  leads_see_policies?: boolean;
}

/** The copy the compliance Overview renders the block with (the training Overview keeps its own). */
export const TEAM_LEADS_COMPLIANCE_COPY =
  "Leads see a scoped view of their group's policies (and training, if licensed) and get a weekly summary.";

export function TeamLeadsBlock({
  copy,
  api = "/api/training/leads",
  userOpts,
}: {
  /** The one sentence under the title: what being a lead opens. */
  copy: string;
  /** The GET/PUT route: /api/training/leads (the default) or /api/compliance/leads. */
  api?: string;
  /** The people to pick from; left out, the route's own `users` list is used. */
  userOpts?: PickerOption[];
}) {
  const [groups, setGroups] = useState<{ id: number; name: string }[]>([]);
  const [leads, setLeads] = useState<Map<number, number[]>>(new Map());
  const [people, setPeople] = useState<PickerOption[]>([]);
  const [leadsSeePolicies, setLeadsSeePolicies] = useState<boolean | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let alive = true;
    void fetch(api)
      .then((r) => (r.ok ? (r.json() as Promise<LeadsPayload>) : null))
      .then((d) => {
        if (!alive) return;
        if (d) {
          setGroups(d.groups ?? []);
          const m = new Map<number, number[]>();
          for (const l of d.leads ?? []) m.set(l.group_id, [...(m.get(l.group_id) ?? []), l.user_id]);
          setLeads(m);
          if (d.users) setPeople(d.users);
          if (typeof d.leads_see_policies === "boolean") setLeadsSeePolicies(d.leads_see_policies);
        }
        setLoaded(true);
      })
      .catch(() => {
        if (alive) setLoaded(true);
      });
    return () => {
      alive = false;
    };
  }, [api]);

  async function save(groupId: number, userIds: number[]) {
    setLeads((m) => new Map(m).set(groupId, userIds));
    const res = await fetch(api, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ group_id: groupId, user_ids: userIds }),
    });
    if (!res.ok) {
      const d = (await res.json().catch(() => ({}))) as { error?: string };
      toast("error", d.error || "Could not save the team leads.");
    } else toast("ok", "Team leads saved.");
  }

  const options = userOpts ?? people;

  return (
    <Card title="Team leads" icon={<Users />} description={copy} padding="p-4" as="section">
      {leadsSeePolicies === false && (
        // A prerequisite state, with the control that clears it (STYLEGUIDE §Notices).
        <p className="notice-warn mb-3 rounded-lg border px-3 py-2 text-sm">
          Leads do not see policy standing yet: turn on <em>Group leads see policy standing</em> under{" "}
          <Link href="/compliance/settings" className="link font-medium">
            Program settings
          </Link>
          .
        </p>
      )}
      {loaded &&
        (groups.length === 0 ? (
          <SectionEmpty>
            No groups yet. Create them under <SettingsLink href="/admin/groups" />.
          </SectionEmpty>
        ) : (
          <div className="space-y-2">
            {groups.map((g) => (
              <div key={g.id} className="flex flex-wrap items-center gap-2">
                <span className="w-44 truncate text-sm font-medium text-slate-700" title={g.name}>
                  {g.name}
                </span>
                <div className="min-w-64 flex-1 sm:max-w-lg">
                  <EntityPicker
                    options={options}
                    value={leads.get(g.id) ?? []}
                    onChange={(ids) => void save(g.id, ids)}
                    label={`Leads of ${g.name}`}
                    placeholder="Add leads…"
                  />
                </div>
              </div>
            ))}
          </div>
        ))}
    </Card>
  );
}
