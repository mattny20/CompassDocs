"use client";

// Settings → Reply targets: the target per priority (first reply,
// resolution), PUT /api/helpdesk/admin/sla. The hours they count in come
// from each team's calendar (Settings → Calendars, agent L's page). The
// clock pauses while a ticket waits on the requester or is on hold.

import { useEffect, useState } from "react";
import { Clock } from "lucide-react";
import { Card } from "@/components/Card";
import Link from "next/link";
import { FormError, Select, TextInput } from "@/components/form";
import { PageHeader } from "@/components/PageHeader";
import { PageContainer } from "@/components/PageWidth";
import { SaveRow } from "@/components/SaveRow";
import { LoadingRow } from "@/components/Spinner";
import { Table, Td, Th } from "@/components/Table";
import { toast } from "@/components/Toasts";
import { useLeaveGuard, useUnsavedChanges } from "@/lib/use-unsaved";
import { HD_PRIORITIES, HD_PRIORITY_LABEL, type HdBusinessHours, type HdPriority, type HdSlaPolicy } from "@/lib/helpdesk/types";
import { getJson, listOf, sendJson } from "../api";
import { useTeams } from "../admin-data";
import { TeamSlaTargets } from "../calendars/TeamSlaTargets";


interface Target {
  priority: HdPriority;
  first_reply: string;
  first_unit: "minutes" | "hours";
  resolve: string;
  resolve_unit: "hours" | "days";
  business_hours: boolean;
}

function toTarget(p: Partial<HdSlaPolicy> & { priority: HdPriority }): Target {
  const fr = p.first_reply_minutes ?? 240;
  const rs = p.resolve_minutes ?? 960;
  return {
    priority: p.priority,
    first_reply: fr % 60 === 0 ? String(fr / 60) : String(fr),
    first_unit: fr % 60 === 0 ? "hours" : "minutes",
    // A business day is the working day's length; 8 hours is close enough for display.
    resolve: rs % 480 === 0 && rs >= 480 ? String(rs / 480) : String(Math.round(rs / 60)),
    resolve_unit: rs % 480 === 0 && rs >= 480 ? "days" : "hours",
    business_hours: (p.business_hours ?? 1) === 1,
  };
}

function minutes(t: Target): { first: number; resolve: number } {
  const f = Number(t.first_reply) * (t.first_unit === "hours" ? 60 : 1);
  const r = Number(t.resolve) * (t.resolve_unit === "days" ? 480 : 60);
  return { first: f, resolve: r };
}

export function SlaSettings() {
  const { teams } = useTeams();
  const [scope, setScope] = useState<string>("workspace");
  const scoped = scope === "workspace" ? null : Number(scope);
  const [targets, setTargets] = useState<Target[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [tried, setTried] = useState(false);
  const snap = JSON.stringify(targets);
  const { dirty, markDirty, markClean, hasUnsavedChanges } = useUnsavedChanges(snap);
  useLeaveGuard(dirty, hasUnsavedChanges);

  useEffect(() => {
    getJson<{ policies: HdSlaPolicy[]; hours: HdBusinessHours; starter?: HdSlaPolicy[] }>("/api/helpdesk/admin/sla", "Couldn't load the targets.")
      .then((d) => {
        const pol = listOf<HdSlaPolicy>(d.policies);
        const base = pol.length ? pol : d.starter ?? [];
        setTargets(HD_PRIORITIES.slice().reverse().map((p) => toTarget(base.find((x) => x.priority === p) ?? { priority: p })));
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  if (error && !targets) return <PageContainer><p className="notice-error rounded-lg border px-3 py-2 text-sm">{error}</p></PageContainer>;
  if (!targets) return <PageContainer><LoadingRow className="py-10" /></PageContainer>;

  const setT = (i: number, p: Partial<Target>) => {
    markDirty();
    setTargets(targets.map((t, j) => (j === i ? { ...t, ...p } : t)));
  };

  const badTarget = targets.find((t) => {
    const m = minutes(t);
    return !(m.first > 0 && m.resolve > 0 && Number.isFinite(m.first) && Number.isFinite(m.resolve));
  });
  const errs = {
    targets: badTarget ? `Give ${HD_PRIORITY_LABEL[badTarget.priority]} a reply and a resolution time above zero.` : undefined,
  };

  async function save() {
    setTried(true);
    if (Object.values(errs).some(Boolean) || !targets) return;
    setBusy(true);
    try {
      await sendJson(
        "/api/helpdesk/admin/sla",
        "PUT",
        {
          policies: targets.map((t) => {
            const m = minutes(t);
            return { priority: t.priority, name: HD_PRIORITY_LABEL[t.priority], first_reply_minutes: m.first, resolve_minutes: m.resolve, business_hours: t.business_hours ? 1 : 0 };
          }),
        },
        "Couldn't save the reply targets."
      );
      markClean(snap);
      toast("ok", "Reply targets saved.");
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <PageContainer>
      <PageHeader icon={<Clock />} title="Reply targets" subtitle="How fast each priority should hear back and be resolved." />
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor="sla-scope" className="text-xs font-medium text-slate-500">
            Targets for
          </label>
          <Select id="sla-scope" dense className="w-auto" value={scope} onChange={(e) => setScope(e.target.value)}>
            <option value="workspace">All teams (workspace)</option>
            {(teams ?? []).map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </Select>
        </div>
        <p className="rounded-lg border border-compass-200 bg-compass-50/70 px-3 py-2 text-sm text-slate-700">
          Business hours come from each team&apos;s calendar: its office hours and holidays.{" "}
          <Link href="/desk/settings/calendars" className="link font-medium">
            Manage calendars
          </Link>
        </p>
        {scoped !== null && (
          <Card title={`${teams?.find((t) => t.id === scoped)?.name ?? "Team"} targets`} description="A team's own targets replace the workspace's for its tickets.">
            <TeamSlaTargets key={scoped} teamId={scoped} framed={false} />
          </Card>
        )}
        {scoped === null && <Card title="Targets by priority" description="The clock pauses while a ticket waits on the requester or is on hold." padding="none">
          <Table scroll minWidth="40rem">
            <thead>
              <tr>
                <Th>Priority</Th>
                <Th>First reply</Th>
                <Th>Resolve</Th>
                <Th fit>Counts</Th>
              </tr>
            </thead>
            <tbody>
              {targets.map((t, i) => (
                <tr key={t.priority} className="border-b border-slate-100 last:border-b-0">
                  <Td className="font-medium text-slate-800">{HD_PRIORITY_LABEL[t.priority]}</Td>
                  <Td>
                    <div className="flex gap-1.5">
                      <TextInput dense type="number" min={1} className="w-20" aria-label={`First reply for ${HD_PRIORITY_LABEL[t.priority]}`} value={t.first_reply} onChange={(e) => setT(i, { first_reply: e.target.value })} />
                      <Select dense className="w-auto" aria-label={`Unit for ${HD_PRIORITY_LABEL[t.priority]} first reply`} value={t.first_unit} onChange={(e) => setT(i, { first_unit: e.target.value as Target["first_unit"] })}>
                        <option value="minutes">minutes</option>
                        <option value="hours">hours</option>
                      </Select>
                    </div>
                  </Td>
                  <Td>
                    <div className="flex gap-1.5">
                      <TextInput dense type="number" min={1} className="w-20" aria-label={`Resolution for ${HD_PRIORITY_LABEL[t.priority]}`} value={t.resolve} onChange={(e) => setT(i, { resolve: e.target.value })} />
                      <Select dense className="w-auto" aria-label={`Unit for ${HD_PRIORITY_LABEL[t.priority]} resolution`} value={t.resolve_unit} onChange={(e) => setT(i, { resolve_unit: e.target.value as Target["resolve_unit"] })}>
                        <option value="hours">hours</option>
                        <option value="days">business days</option>
                      </Select>
                    </div>
                  </Td>
                  <Td fit>
                    <Select dense className="w-auto" aria-label={`How ${HD_PRIORITY_LABEL[t.priority]} counts time`} value={t.business_hours ? "1" : "0"} onChange={(e) => setT(i, { business_hours: e.target.value === "1" })}>
                      <option value="1">Business hours</option>
                      <option value="0">Around the clock</option>
                    </Select>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
          <FormError className="m-4">{tried ? errs.targets : undefined}</FormError>
        </Card>}
      </div>
      {scoped === null && <SaveRow dirty={dirty} busy={busy} onSave={save} label="Save reply targets" />}
    </PageContainer>
  );
}
