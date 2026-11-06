"use client";

// A team's Status page services (1.19.2, agent W6; mock-up s2): tick the
// services that matter to the team, see each one's state now, and choose
// the pop-up level per ticked service (Outage and degraded, Outage only,
// Off: banner only). One Save puts the whole list
// (PUT /api/helpdesk/team-status/teams/[id], audited).
//
//   TeamStatusSection  the collapsible section on Desk settings → Teams,
//                      beside "Reply targets" (teams.manage).
//   TeamStatusDialog   the same editor in a dialog, from the top bar's
//                      status popover, for a team's lead (agents.manage_team
//                      in that team), who can't open the Teams page.

import { useEffect, useState } from "react";
import { Activity, Save } from "lucide-react";
import { Button } from "@/components/Button";
import { chipClass } from "@/components/Chip";
import { Modal } from "@/components/Modal";
import { FormError, Select, SectionEmpty } from "@/components/form";
import { LoadingRow } from "@/components/Spinner";
import { TABLE_HEAD_ROW, TD, TH, TR, FIT, TableWrap } from "@/components/Table";
import { toast } from "@/components/Toasts";
import {
  POPUP_LEVELS,
  POPUP_LEVEL_LABEL,
  stateLabel,
  stateTone,
  type PopupLevel,
  type TeamStatusSettingsRow,
} from "@/lib/helpdesk/status-teams-shared";
import { getJson, sendJson } from "../api";

export function TeamStatusServices({ teamId, teamName, onSaved }: { teamId: number; teamName: string; onSaved?: () => void }) {
  const [rows, setRows] = useState<TeamStatusSettingsRow[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    let live = true;
    setRows(null);
    setError("");
    setDirty(false);
    getJson<{ services: TeamStatusSettingsRow[] }>(`/api/helpdesk/team-status/teams/${teamId}`, "Couldn't load the Status page services.")
      .then((d) => live && setRows(d.services))
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [teamId]);

  const change = (id: number, patch: Partial<TeamStatusSettingsRow>) => {
    setRows((rs) => rs?.map((r) => (r.id === id ? { ...r, ...patch } : r)) ?? rs);
    setDirty(true);
  };

  async function save() {
    if (!rows) return;
    setBusy(true);
    setError("");
    try {
      const d = await sendJson<{ services: TeamStatusSettingsRow[] }>(
        `/api/helpdesk/team-status/teams/${teamId}`,
        "PUT",
        { services: rows.filter((r) => r.followed).map((r) => ({ service_id: r.id, popup_level: r.popup_level })) },
        "Couldn't save the status services."
      );
      setRows(d.services);
      setDirty(false);
      toast("ok", `${teamName}'s status services saved.`);
      onSaved?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <p className="text-sm text-slate-600">
        Agents in {teamName} see these services in the desk&apos;s top bar and get a pop-up when one degrades or goes down. Services come from the Status page.
      </p>
      {rows === null && !error && <LoadingRow className="py-6" />}
      {rows && rows.length === 0 && (
        <SectionEmpty className="mt-3">
          The Status page tracks no services yet.{" "}
          <a href="/status" target="_blank" rel="noopener" className="link font-medium">
            Add them on the Status page
          </a>
          .
        </SectionEmpty>
      )}
      {rows && rows.length > 0 && (
        <TableWrap className="mt-3">
          <table className="w-full text-sm">
            <thead>
              <tr className={TABLE_HEAD_ROW}>
                <th className={`${TH} ${FIT}`}>
                  <span className="sr-only">Follow</span>
                </th>
                <th className={TH}>Service</th>
                <th className={`${TH} ${FIT}`}>Now</th>
                <th className={TH}>Pop-up for</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const id = `ts-${teamId}-${r.id}`;
                return (
                  <tr key={r.id} className={TR}>
                    <td className={`${TD} ${FIT}`}>
                      <input
                        id={id}
                        type="checkbox"
                        checked={r.followed}
                        disabled={busy}
                        onChange={(e) => change(r.id, { followed: e.target.checked })}
                        className="h-4 w-4 accent-compass-600"
                      />
                    </td>
                    <td className={TD}>
                      <label htmlFor={id} className="font-semibold text-slate-900">
                        {r.name}
                      </label>
                    </td>
                    <td className={`${TD} ${FIT}`}>
                      <span className={chipClass(stateTone(r.status), "sm")}>{stateLabel(r.status)}</span>
                    </td>
                    <td className={`${TD} py-2`}>
                      {r.followed && (
                        <Select
                          dense
                          className="w-auto min-w-[12rem]"
                          aria-label={`Pop-up for ${r.name}`}
                          value={r.popup_level}
                          disabled={busy}
                          onChange={(e) => change(r.id, { popup_level: e.target.value as PopupLevel })}
                        >
                          {POPUP_LEVELS.map((l) => (
                            <option key={l} value={l}>
                              {POPUP_LEVEL_LABEL[l]}
                            </option>
                          ))}
                        </Select>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </TableWrap>
      )}
      <FormError className="mt-3">{error}</FormError>
      {rows && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-slate-500">
            Need another service? Add it on the{" "}
            <a href="/status" target="_blank" rel="noopener" className="link">
              Status page
            </a>{" "}
            (vendor status feeds or your own internal services).
          </p>
          {rows.length > 0 && (
            <Button icon={<Save />} onClick={save} busy={busy} disabled={!dirty}>
              Save
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

/** The Teams page's section: mounted (and loaded) only once opened. */
export function TeamStatusSection({ teamId, teamName }: { teamId: number; teamName: string }) {
  const [open, setOpen] = useState(false);
  return (
    <details className="rounded-lg border border-slate-200 bg-surface text-left" onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary className="cursor-pointer px-3 py-2 text-sm font-semibold text-slate-800">Status services for {teamName}</summary>
      <div className="border-t border-slate-100 p-3">{open && <TeamStatusServices teamId={teamId} teamName={teamName} />}</div>
    </details>
  );
}

/** A lead's way in: the editor in a dialog, for one of the teams they lead. */
export function TeamStatusDialog({
  open,
  onClose,
  teams,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  teams: { id: number; name: string }[];
  onSaved?: () => void;
}) {
  const [teamId, setTeamId] = useState<number | null>(teams[0]?.id ?? null);
  useEffect(() => {
    if (open && (teamId === null || !teams.some((t) => t.id === teamId))) setTeamId(teams[0]?.id ?? null);
  }, [open, teams, teamId]);
  const team = teams.find((t) => t.id === teamId);
  return (
    <Modal
      open={open}
      onClose={onClose}
      labelledBy="team-status-title"
      className="max-h-[calc(100vh-2rem)] w-full max-w-3xl overflow-y-auto rounded-xl border border-slate-200 bg-surface p-5 shadow-modal sm:p-6"
    >
      <h2 id="team-status-title" className="flex items-center gap-2 text-lg font-semibold text-slate-900">
        <Activity className="h-5 w-5 text-slate-700" aria-hidden />
        Status services
      </h2>
      {teams.length > 1 && (
        <div className="mt-3 max-w-xs">
          <label htmlFor="team-status-team" className="block text-sm font-medium text-slate-800">
            Team
          </label>
          <Select id="team-status-team" className="mt-1" value={teamId ?? ""} onChange={(e) => setTeamId(Number(e.target.value))}>
            {teams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </Select>
        </div>
      )}
      <div className="mt-4">{open && team && <TeamStatusServices teamId={team.id} teamName={team.name} onSaved={onSaved} />}</div>
      <div className="mt-4 flex justify-end">
        <Button variant="secondary" onClick={onClose}>
          Close
        </Button>
      </div>
    </Modal>
  );
}
