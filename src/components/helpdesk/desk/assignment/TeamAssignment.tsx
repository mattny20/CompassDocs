"use client";

// Settings → Assignment → Teams (agent N): one team at a time (the switcher
// keeps it in ?team=). Three mode cards (Manual, Round robin, Load balanced)
// in plain words, then who takes tickets (Available only / Available or
// away, which desk roles, a capacity, office hours), the extras (sticky
// requester, reassign when away, reassign when unanswered), one Save row.
// Under it the people: weight steppers and pause buttons save at once (they
// are per person, not the page's form), with each person's open tickets,
// availability and why the next ticket would pass them over; above them,
// "Who's next" says where the next ticket would go right now.

import { useEffect, useId, useState } from "react";
import { Hand, Minus, Plus, Repeat, Scale, Shuffle, UserRoundCheck, UserRoundX } from "lucide-react";
import { Button, iconButtonClass } from "@/components/Button";
import { Card } from "@/components/Card";
import { Chip, chipClass } from "@/components/Chip";
import { EmptyState, Field, SectionEmpty, Select, TextInput, Toggle } from "@/components/form";
import { SaveRow } from "@/components/SaveRow";
import { LoadingRow } from "@/components/Spinner";
import { toast } from "@/components/Toasts";
import { CARD_TITLE_TEXT, EYEBROW_TEXT } from "@/components/Heading";
import { initialsOf } from "@/components/UserAvatar";
import {
  HD_ASSIGN_MODES,
  HD_ASSIGN_MODE_HINT,
  HD_ASSIGN_MODE_LABEL,
  HD_ASSIGN_ROLE_CHOICES,
  HD_ELIGIBILITY_LABEL,
  ASSIGNMENT_LIMITS,
  type HdAssignMode,
  type HdAssignmentMemberView,
  type HdTeamAssignment,
} from "@/lib/helpdesk/assignment/shared";
import { HD_ROLE_LABEL } from "@/lib/helpdesk/roles-shared";
import { HD_AVAILABILITY_LABEL } from "@/lib/helpdesk/types";
import { getJson, sendJson } from "../api";
import { TeamPicker } from "./TeamPicker";
import { useAssignmentOverview, useSelectedTeam } from "./data";

interface View {
  team: { id: number; name: string };
  settings: HdTeamAssignment;
  members: HdAssignmentMemberView[];
  next: { user_id: number | null; name: string | null; reason: string };
  open: boolean;
  queued: number;
}

const MODE_ICON: Record<HdAssignMode, typeof Hand> = { manual: Hand, round_robin: Repeat, load_balanced: Scale };

const AVAIL_DOT: Record<string, string> = { available: "bg-emerald-500", away: "bg-amber-500", offline: "bg-slate-400" };

type Form = Pick<
  HdTeamAssignment,
  "mode" | "eligible" | "include_roles" | "max_open_per_agent" | "respect_shift" | "sticky_requester" | "reassign_when_away" | "unanswered_minutes"
>;

const formOf = (s: HdTeamAssignment): Form => ({
  mode: s.mode,
  eligible: s.eligible,
  include_roles: [...s.include_roles],
  max_open_per_agent: s.max_open_per_agent,
  respect_shift: s.respect_shift,
  sticky_requester: s.sticky_requester,
  reassign_when_away: s.reassign_when_away,
  unanswered_minutes: s.unanswered_minutes,
});

export function TeamAssignment() {
  const { data, error } = useAssignmentOverview();
  const [teamId, setTeamId] = useSelectedTeam(data?.teams);
  const [view, setView] = useState<View | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [loadError, setLoadError] = useState("");
  const [busy, setBusy] = useState(false);
  const [capText, setCapText] = useState("");
  const [waitText, setWaitText] = useState("");

  const apply = (v: View) => {
    setView(v);
    setForm(formOf(v.settings));
    setCapText(v.settings.max_open_per_agent === null ? "" : String(v.settings.max_open_per_agent));
    setWaitText(v.settings.unanswered_minutes === null ? "" : String(v.settings.unanswered_minutes));
  };

  useEffect(() => {
    if (!teamId) return;
    let live = true;
    setView(null);
    setLoadError("");
    getJson<View>(`/api/helpdesk/admin/assignment/teams/${teamId}`, "Couldn't load the team's settings.")
      .then((v) => live && apply(v))
      .catch((e: Error) => live && setLoadError(e.message));
    return () => {
      live = false;
    };
  }, [teamId]);

  if (error) return <p className="notice-error rounded-lg border px-3 py-2 text-sm">{error}</p>;
  if (!data) return <LoadingRow className="py-10" />;
  if (data.teams.length === 0) {
    return <EmptyState icon={<Shuffle />} title="No teams to set up" body="Assignment is set per team. Create a team first, or ask a manager to add you to one." />;
  }

  const capNum = capText.trim() === "" ? null : Number(capText);
  const waitNum = waitText.trim() === "" ? null : Number(waitText);
  const capError = capNum !== null && (!Number.isInteger(capNum) || capNum < 1 || capNum > ASSIGNMENT_LIMITS.capacity) ? `Use 1 to ${ASSIGNMENT_LIMITS.capacity}, or leave it empty for no limit.` : undefined;
  const waitError = waitNum !== null && (!Number.isInteger(waitNum) || waitNum < 1 || waitNum > ASSIGNMENT_LIMITS.unanswered) ? "Use a whole number of minutes, or leave it empty." : undefined;
  const rolesError = form && form.include_roles.length === 0 ? "Choose at least one role." : undefined;
  const merged: Form | null = form ? { ...form, max_open_per_agent: capError ? form.max_open_per_agent : capNum, unanswered_minutes: waitError ? form.unanswered_minutes : waitNum } : null;
  const dirty = !!(view && merged && JSON.stringify(merged) !== JSON.stringify(formOf(view.settings)));
  const auto = form?.mode !== "manual";

  async function save() {
    if (!view || !merged || capError || waitError || rolesError) return;
    setBusy(true);
    try {
      const v = await sendJson<View>(`/api/helpdesk/admin/assignment/teams/${view.team.id}`, "PUT", merged, "Couldn't save the settings.");
      apply(v);
      toast("ok", `${v.team.name}: assignment saved.`);
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function patchMember(m: HdAssignmentMemberView, patch: { weight?: number; paused?: boolean }, ok: string) {
    if (!view) return;
    try {
      const v = await sendJson<View>(`/api/helpdesk/admin/assignment/teams/${view.team.id}/members/${m.user_id}`, "PATCH", patch, "Couldn't change that.");
      setView({ ...v, settings: view.settings });
      toast("ok", ok);
    } catch (e) {
      toast("error", (e as Error).message);
    }
  }

  return (
    <div className="space-y-5">
      <TeamPicker teams={data.teams} value={teamId} onChange={setTeamId} />
      {loadError && <p className="notice-error rounded-lg border px-3 py-2 text-sm">{loadError}</p>}
      {!view && !loadError && <LoadingRow className="py-10" />}
      {view && form && (
        <>
          <ModeCards value={form.mode} onChange={(mode) => setForm({ ...form, mode })} />

          {auto && (
            <Card title="Who takes tickets" description={`Round robin and load balancing only pick from these people in ${view.team.name}.`}>
              <div className="space-y-4">
                <Field label="Their availability">
                  <Select value={form.eligible} onChange={(e) => setForm({ ...form, eligible: e.target.value as Form["eligible"] })} className="sm:max-w-xs">
                    {Object.entries(HD_ELIGIBILITY_LABEL).map(([k, l]) => (
                      <option key={k} value={k}>
                        {l}
                      </option>
                    ))}
                  </Select>
                </Field>
                <fieldset>
                  <legend className="text-sm font-medium text-slate-800">Desk roles that take tickets</legend>
                  <p className="mt-0.5 text-xs text-slate-500">Newbies are left out unless you tick them. A rule can still ask for a team lead or above.</p>
                  <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1.5">
                    {HD_ASSIGN_ROLE_CHOICES.map((r) => (
                      <label key={r} className="inline-flex items-center gap-1.5 text-sm text-slate-700">
                        <input
                          type="checkbox"
                          checked={form.include_roles.includes(r)}
                          onChange={() =>
                            setForm({ ...form, include_roles: form.include_roles.includes(r) ? form.include_roles.filter((x) => x !== r) : [...form.include_roles, r] })
                          }
                        />
                        {HD_ROLE_LABEL[r]}
                      </label>
                    ))}
                  </div>
                  {rolesError && <p role="alert" className="mt-1 text-xs text-red-600">{rolesError}</p>}
                </fieldset>
                <Field label="Most open tickets per person" help="Counts their open tickets in every team, including ones waiting on the requester. Empty = no limit." error={capError} size="sm">
                  <TextInput inputMode="numeric" value={capText} onChange={(e) => setCapText(e.target.value)} placeholder="No limit" />
                </Field>
                <Toggle
                  label="Only during the team's office hours"
                  help={`Outside ${view.team.name}'s calendar, new tickets wait in the queue and are handed out when it opens.${view.open ? "" : " It is closed right now."}`}
                  checked={form.respect_shift === 1}
                  onChange={(v) => setForm({ ...form, respect_shift: v ? 1 : 0 })}
                />
              </div>
            </Card>
          )}

          {auto && (
            <Card title="Extras">
              <div className="space-y-4">
                <Toggle
                  label="Same person as last time"
                  help="A requester's new ticket goes to whoever solved their last one, when that person can take it."
                  checked={form.sticky_requester === 1}
                  onChange={(v) => setForm({ ...form, sticky_requester: v ? 1 : 0 })}
                />
                <Toggle
                  label="Move tickets on when their owner is away"
                  help={`After ${ASSIGNMENT_LIMITS.awayGraceMinutes} minutes away or offline, their new and open tickets go to someone else. Each ticket moves at most ${ASSIGNMENT_LIMITS.maxAutoReassigns} times on its own.`}
                  checked={form.reassign_when_away === 1}
                  onChange={(v) => setForm({ ...form, reassign_when_away: v ? 1 : 0 })}
                />
                <Field
                  label="Move a ticket on when its owner hasn't replied within"
                  help="Business minutes in the team's calendar, from when it was assigned. Empty = never."
                  error={waitError}
                  size="sm"
                >
                  <div className="flex items-center gap-2">
                    <TextInput inputMode="numeric" value={waitText} onChange={(e) => setWaitText(e.target.value)} placeholder="Never" />
                    <span className="text-sm text-slate-500">minutes</span>
                  </div>
                </Field>
              </div>
            </Card>
          )}

          <SaveRow dirty={dirty} busy={busy} onSave={save} disabled={!!(capError || waitError || rolesError)} />

          <People view={view} auto={auto} onPatch={patchMember} />
        </>
      )}
    </div>
  );
}

function ModeCards({ value, onChange }: { value: HdAssignMode; onChange: (m: HdAssignMode) => void }) {
  const labelId = useId();
  function onKey(e: React.KeyboardEvent, i: number) {
    const n = HD_ASSIGN_MODES.length;
    const next = e.key === "ArrowRight" || e.key === "ArrowDown" ? (i + 1) % n : e.key === "ArrowLeft" || e.key === "ArrowUp" ? (i - 1 + n) % n : -1;
    if (next < 0) return;
    e.preventDefault();
    onChange(HD_ASSIGN_MODES[next]);
    (e.currentTarget.parentElement?.children[next] as HTMLElement | undefined)?.focus();
  }
  return (
    <section aria-labelledby={labelId}>
      <h2 id={labelId} className={`${EYEBROW_TEXT} mb-2`}>
        How new tickets are assigned
      </h2>
      <div role="radiogroup" aria-labelledby={labelId} className="grid gap-3 sm:grid-cols-3">
        {HD_ASSIGN_MODES.map((m, i) => {
          const on = m === value;
          const Icon = MODE_ICON[m];
          return (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={on}
              tabIndex={on ? 0 : -1}
              onClick={() => onChange(m)}
              onKeyDown={(e) => onKey(e, i)}
              className={`flex items-start gap-3 rounded-xl border bg-surface p-4 text-left shadow-xs transition ${
                on ? "border-compass-500 ring-2 ring-compass-500/20" : "border-slate-200 hover:border-slate-300"
              }`}
            >
              <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-lg ${on ? "bg-compass-600 text-white" : "bg-slate-100 text-slate-600"}`}>
                <Icon className="h-5 w-5" aria-hidden />
              </span>
              <span className="min-w-0">
                <span className={`block ${CARD_TITLE_TEXT}`}>{HD_ASSIGN_MODE_LABEL[m]}</span>
                <span className="mt-0.5 block text-sm text-slate-500">{HD_ASSIGN_MODE_HINT[m]}</span>
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

function People({
  view,
  auto,
  onPatch,
}: {
  view: View;
  auto: boolean;
  onPatch: (m: HdAssignmentMemberView, patch: { weight?: number; paused?: boolean }, ok: string) => void;
}) {
  const showWeight = view.settings.mode === "round_robin" || view.settings.mode === "load_balanced";
  return (
    <Card
      padding="none"
      title="People"
      description={auto ? "Weight gives someone more turns (round robin) or a bigger share (load balancing). Paused people keep their tickets but get no new ones." : "With Manual, people take tickets from the queue themselves."}
    >
      {auto && <NextUp view={view} />}
      {view.members.length === 0 ? (
        <SectionEmpty className="px-4 py-6">Nobody is in {view.team.name} yet. Add people in Settings → Teams.</SectionEmpty>
      ) : (
        <ul className="divide-y divide-slate-100">
          {view.members.map((m) => (
            <li key={m.user_id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
              <span className="relative grid h-8 w-8 shrink-0 place-items-center rounded-full bg-compass-100 text-2xs font-bold text-compass-700" aria-hidden>
                {initialsOf(m.name)}
                <span className={`absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-surface ${AVAIL_DOT[m.availability] ?? AVAIL_DOT.offline}`} />
              </span>
              <div className="min-w-0 flex-1 basis-48">
                <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-slate-900">
                  {m.name}
                  <span className={chipClass("neutral", "sm")}>{m.role_label}</span>
                  {m.paused === 1 && <Chip tone="warn" size="sm">Paused</Chip>}
                </p>
                <p className="mt-0.5 text-xs text-slate-500">
                  {HD_AVAILABILITY_LABEL[m.availability] ?? m.availability} · {m.open_count} open
                  {auto && m.skip_reason ? <span className="ink-warn"> · Skipped: {m.skip_reason.replace(/^is /, "")}</span> : null}
                </p>
              </div>
              {auto && showWeight && <WeightStepper m={m} onChange={(w) => onPatch(m, { weight: w }, `${m.name}: weight ${w}.`)} />}
              {auto && (
                <Button
                  variant="secondary"
                  size="sm"
                  icon={m.paused ? <UserRoundCheck /> : <UserRoundX />}
                  aria-pressed={m.paused === 1}
                  onClick={() => onPatch(m, { paused: !m.paused }, m.paused ? `${m.name} gets tickets again.` : `${m.name} is paused.`)}
                >
                  {m.paused ? "Resume" : "Pause"}
                  <span className="sr-only"> auto-assign for {m.name}</span>
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function NextUp({ view }: { view: View }) {
  return (
    <div className="border-b border-slate-100 bg-slate-50 px-4 py-3" aria-live="polite">
      <p className={EYEBROW_TEXT}>Who&apos;s next</p>
      {view.next.name ? (
        <p className="mt-1 text-sm text-slate-800">
          The next ticket goes to <span className="font-semibold">{view.next.name}</span>
          <span className="text-slate-500"> · {view.next.reason}</span>
        </p>
      ) : (
        <p className="mt-1 text-sm ink-warn">{view.next.reason}</p>
      )}
      {view.queued > 0 && (
        <p className="mt-1 text-xs text-slate-500">
          {view.queued} {view.queued === 1 ? "ticket is" : "tickets are"} waiting for someone to become available.
        </p>
      )}
    </div>
  );
}

function WeightStepper({ m, onChange }: { m: HdAssignmentMemberView; onChange: (w: number) => void }) {
  const max = ASSIGNMENT_LIMITS.weight;
  return (
    <div className="flex items-center gap-1" role="group" aria-label={`Weight for ${m.name}`}>
      <span className="mr-1 text-xs text-slate-500">Weight</span>
      <button type="button" disabled={m.weight <= 1} onClick={() => onChange(m.weight - 1)} aria-label={`Lower ${m.name}'s weight`} data-tt="Fewer turns" className={iconButtonClass("bordered", "sm")}>
        <Minus aria-hidden />
      </button>
      <span className="w-6 text-center text-sm font-semibold tabular-nums text-slate-900" aria-live="polite">
        {m.weight}
      </span>
      <button type="button" disabled={m.weight >= max} onClick={() => onChange(m.weight + 1)} aria-label={`Raise ${m.name}'s weight`} data-tt="More turns" className={iconButtonClass("bordered", "sm")}>
        <Plus aria-hidden />
      </button>
    </div>
  );
}

