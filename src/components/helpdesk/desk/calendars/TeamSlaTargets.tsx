"use client";

// <TeamSlaTargets teamId /> (agent L, for D's Reply targets team switcher
// and each team's settings): the team's own reply targets per priority.
// Each row shows the workspace default greyed ("Workspace default: 4h /
// 2d"); "Custom for this team" opens first reply and resolution inputs (h
// or m / h or business days, 8 hours a day as on Reply targets) and the
// business-hours box. Its own Save (not sticky, no Ctrl+S: the host page
// has its own) and "Reset to workspace targets". Saving re-times the team's
// open, running tickets: time already used stays used.

import { useCallback, useEffect, useState } from "react";
import { RotateCcw } from "lucide-react";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { confirmDialog } from "@/components/Dialog";
import { FormError, Select, TextInput } from "@/components/form";
import { SaveRow } from "@/components/SaveRow";
import { LoadingRow } from "@/components/Spinner";
import { toast } from "@/components/Toasts";
import { useUnsavedChanges } from "@/lib/use-unsaved";
import type { HdTeamSlaTarget, HdTeamSlaView } from "@/lib/helpdesk/calendars-shared";
import { HD_PRIORITIES, HD_PRIORITY_LABEL, type HdPriority } from "@/lib/helpdesk/types";
import { getJson, sendJson } from "../api";
import { shortTarget } from "./data";

interface Row {
  priority: HdPriority;
  custom: boolean;
  first: string;
  firstUnit: "minutes" | "hours";
  resolve: string;
  resolveUnit: "hours" | "days";
  business: boolean;
}

function rowOf(priority: HdPriority, t: HdTeamSlaTarget | undefined, ws: HdTeamSlaTarget | undefined): Row {
  const src = t ?? ws ?? { first_reply_minutes: 240, resolve_minutes: 960, business_hours: 1 };
  const fr = src.first_reply_minutes;
  const rs = src.resolve_minutes;
  return {
    priority,
    custom: !!t,
    first: fr % 60 === 0 ? String(fr / 60) : String(fr),
    firstUnit: fr % 60 === 0 ? "hours" : "minutes",
    resolve: rs >= 480 && rs % 480 === 0 ? String(rs / 480) : String(Math.round((rs / 60) * 100) / 100),
    resolveUnit: rs >= 480 && rs % 480 === 0 ? "days" : "hours",
    business: src.business_hours === 1,
  };
}

function minutesOf(r: Row): { first: number; resolve: number } {
  return { first: Math.round(Number(r.first) * (r.firstUnit === "hours" ? 60 : 1)), resolve: Math.round(Number(r.resolve) * (r.resolveUnit === "days" ? 480 : 60)) };
}

export function TeamSlaTargets({
  teamId,
  onSaved,
  framed = true,
}: {
  teamId: number;
  onSaved?: () => void;
  /** False inside a host's own card or <details> (no second card, no title; Reset moves into the footer). */
  framed?: boolean;
}) {
  const [view, setView] = useState<HdTeamSlaView | null>(null);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState("");
  const [forbidden, setForbidden] = useState(false);
  const [busy, setBusy] = useState(false);
  const [tried, setTried] = useState(false);
  const snap = JSON.stringify(rows);
  const { dirty, markDirty, markClean } = useUnsavedChanges(snap);

  const load = useCallback(async () => {
    try {
      const v = await getJson<HdTeamSlaView>(`/api/helpdesk/admin/calendars/teams/${teamId}/sla`, "Couldn't load the team's targets.");
      setView(v);
      const next = [...HD_PRIORITIES].reverse().map((p) => rowOf(p, v.targets.find((t) => t.priority === p), v.workspace.find((w) => w.priority === p)));
      setRows(next);
      markClean(JSON.stringify(next));
      setError("");
    } catch (e) {
      if ((e as { status?: number }).status === 403) setForbidden(true);
      else setError((e as Error).message);
    }
  }, [teamId, markClean]);
  useEffect(() => {
    setRows(null);
    void load();
  }, [load]);

  if (forbidden) return null;
  if (error && !rows) return <p className="notice-error rounded-lg border px-3 py-2 text-sm">{error}</p>;
  if (!rows || !view) return <LoadingRow className="py-6" />;

  const setRow = (i: number, p: Partial<Row>) => {
    markDirty();
    setRows(rows.map((r, j) => (j === i ? { ...r, ...p } : r)));
  };
  const bad = rows.find((r) => {
    if (!r.custom) return false;
    const m = minutesOf(r);
    return !(m.first > 0 && m.resolve > 0 && m.first <= 129_600 && m.resolve <= 129_600);
  });
  const anyCustom = view.targets.length > 0;

  async function save() {
    setTried(true);
    if (bad || !rows) return;
    setBusy(true);
    try {
      const targets = rows.filter((r) => r.custom).map((r) => {
        const m = minutesOf(r);
        return { priority: r.priority, first_reply_minutes: m.first, resolve_minutes: m.resolve, business_hours: r.business ? 1 : 0 };
      });
      const r = await sendJson<{ retimed: number }>(`/api/helpdesk/admin/calendars/teams/${teamId}/sla`, "PUT", { targets: targets.length ? targets : null }, "Couldn't save the team's targets.");
      toast("ok", `${view!.team.name}'s targets saved.${r.retimed ? ` ${r.retimed} open ticket${r.retimed === 1 ? "" : "s"} re-timed.` : ""}`);
      await load();
      onSaved?.();
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function reset() {
    const ok = await confirmDialog({
      title: `Use the workspace targets for ${view!.team.name}?`,
      body: "The team's own targets are removed. Its open tickets are re-timed to the workspace targets, keeping the time already used.",
      confirmLabel: "Reset to workspace targets",
    });
    if (!ok) return;
    try {
      await sendJson(`/api/helpdesk/admin/calendars/teams/${teamId}/sla`, "PUT", { targets: null }, "Couldn't reset the targets.");
      toast("ok", `${view!.team.name} uses the workspace targets again.`);
      await load();
      onSaved?.();
    } catch (e) {
      toast("error", (e as Error).message);
    }
  }

  const resetButton = anyCustom ? (
    <Button variant="secondary" size="sm" icon={<RotateCcw />} onClick={reset}>
      Reset to workspace targets
    </Button>
  ) : null;
  const content = (
    <>
      <ul role="list" className="divide-y divide-slate-100">
        {rows.map((r, i) => {
          const ws = view.workspace.find((w) => w.priority === r.priority);
          const label = HD_PRIORITY_LABEL[r.priority];
          return (
            <li key={r.priority} className={`flex flex-col gap-3 py-3 @container ${framed ? "px-4" : ""}`}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-slate-800">{label}</p>
                  <p className="text-xs text-slate-500">
                    {ws ? `Workspace default: ${shortTarget(ws.first_reply_minutes)} / ${shortTarget(ws.resolve_minutes)}${ws.business_hours ? "" : " around the clock"}` : "No workspace target for this priority"}
                  </p>
                </div>
                <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-700">
                  <input type="checkbox" className="h-4 w-4" checked={r.custom} onChange={(e) => setRow(i, { custom: e.target.checked })} />
                  Custom for this team
                </label>
              </div>
              {r.custom && (
                <div className="flex flex-wrap items-end gap-x-4 gap-y-2">
                  <div className="flex flex-col gap-1">
                    <span className="text-xs font-medium text-slate-600">First reply</span>
                    <div className="flex gap-1.5">
                      <TextInput dense type="number" min={1} className="w-20" aria-label={`First reply for ${label}`} value={r.first} onChange={(e) => setRow(i, { first: e.target.value })} />
                      <Select dense className="w-auto" aria-label={`Unit for ${label} first reply`} value={r.firstUnit} onChange={(e) => setRow(i, { firstUnit: e.target.value as Row["firstUnit"] })}>
                        <option value="minutes">minutes</option>
                        <option value="hours">hours</option>
                      </Select>
                    </div>
                  </div>
                  <div className="flex flex-col gap-1">
                    <span className="text-xs font-medium text-slate-600">Resolve</span>
                    <div className="flex gap-1.5">
                      <TextInput dense type="number" min={1} className="w-20" aria-label={`Resolution for ${label}`} value={r.resolve} onChange={(e) => setRow(i, { resolve: e.target.value })} />
                      <Select dense className="w-auto" aria-label={`Unit for ${label} resolution`} value={r.resolveUnit} onChange={(e) => setRow(i, { resolveUnit: e.target.value as Row["resolveUnit"] })}>
                        <option value="hours">hours</option>
                        <option value="days">business days</option>
                      </Select>
                    </div>
                  </div>
                  <label className="flex cursor-pointer items-center gap-2 pb-1.5 text-sm text-slate-700">
                    <input type="checkbox" className="h-4 w-4" checked={r.business} onChange={(e) => setRow(i, { business: e.target.checked })} />
                    Count office hours only
                  </label>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      <FormError className={framed ? "mx-4 mb-2" : "mb-2"}>{tried && bad ? `Give ${HD_PRIORITY_LABEL[bad.priority]} a first reply and a resolution time above zero (90 days at most).` : undefined}</FormError>
      <div className={`border-t border-slate-100 py-3 ${framed ? "px-4" : ""}`}>
        <SaveRow dirty={dirty} busy={busy} onSave={save} label="Save team targets" sticky={false} shortcut={false}>
          {!framed && resetButton}
        </SaveRow>
      </div>
    </>
  );
  if (!framed) return content;
  return (
    <Card padding="none" title={`${view.team.name}: reply targets`} description="Leave a priority on the workspace default, or give this team its own." actions={resetButton ?? undefined}>
      {content}
    </Card>
  );
}
