"use client";

// Settings → Assignment → On call (agent N): one team at a time. "On call
// now" first (who, until when, cover or rota), then the rota editor (the
// people in order, how long each turn lasts, the handover time and the
// first handover's date in a timezone; one Save row), the next four weeks
// as a calendar strip (one cell per day, a chip per person on call that
// day, cover outlined), and one-off cover (someone stands in between two
// times). A rule with "Whoever is on call" hands tickets to the person
// this page says is on call at that moment.

import { useEffect, useMemo, useState } from "react";
import { ArrowDown, ArrowUp, CalendarRange, PhoneCall, Plus, Trash2, UserPlus, X } from "lucide-react";
import { Button, iconButtonClass } from "@/components/Button";
import { Card } from "@/components/Card";
import { Chip, chipClass, type ChipTone } from "@/components/Chip";
import { confirmDialog } from "@/components/Dialog";
import { EmptyState, Field, FormError, SectionEmpty, Select, TextInput } from "@/components/form";
import { SaveRow } from "@/components/SaveRow";
import { LoadingRow } from "@/components/Spinner";
import { toast } from "@/components/Toasts";
import { EYEBROW_TEXT } from "@/components/Heading";
import { initialsOf } from "@/components/UserAvatar";
import type { HdAssignmentMemberView, HdOnCallRotation, HdOnCallShift } from "@/lib/helpdesk/assignment/shared";
import { getJson, sendJson } from "../api";
import { TeamPicker } from "./TeamPicker";
import { useAssignmentOverview, useSelectedTeam, whenLabel } from "./data";

type Named = HdOnCallShift & { name: string };
interface OnCall {
  team: { id: number; name: string };
  rotation: HdOnCallRotation | null;
  overrides: Named[];
  now: Named | null;
  strip: { date: string; segments: Named[] }[];
  timezone: string;
  people: Record<number, string>;
}

const TONES: ChipTone[] = ["accent", "info", "ok", "warn", "label", "neutral"];

interface Draft {
  user_ids: number[];
  length_days: string;
  handover_time: string;
  timezone: string;
  starts_on: string;
}

function todayIn(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function browserZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

function zones(current: string): string[] {
  let list: string[] = [];
  try {
    list = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("timeZone") ?? [];
  } catch {
    list = [];
  }
  if (!list.includes("UTC")) list = ["UTC", ...list];
  return list.includes(current) ? list : [current, ...list];
}

const draftOf = (r: HdOnCallRotation | null): Draft =>
  r
    ? { user_ids: [...r.user_ids], length_days: String(r.length_days), handover_time: r.handover_time, timezone: r.timezone, starts_on: r.starts_on }
    : { user_ids: [], length_days: "7", handover_time: "09:00", timezone: browserZone(), starts_on: todayIn() };

export function OnCallSettings() {
  const { data, error } = useAssignmentOverview();
  const [teamId, setTeamId] = useSelectedTeam(data?.teams);
  const [view, setView] = useState<OnCall | null>(null);
  const [members, setMembers] = useState<HdAssignmentMemberView[]>([]);
  const [draft, setDraft] = useState<Draft>(draftOf(null));
  const [loadError, setLoadError] = useState("");
  const [busy, setBusy] = useState(false);

  const apply = (v: OnCall) => {
    setView(v);
    setDraft(draftOf(v.rotation));
  };

  useEffect(() => {
    if (!teamId) return;
    let live = true;
    setView(null);
    setLoadError("");
    Promise.all([
      getJson<OnCall>(`/api/helpdesk/admin/assignment/teams/${teamId}/on-call`, "Couldn't load the rota."),
      getJson<{ members: HdAssignmentMemberView[] }>(`/api/helpdesk/admin/assignment/teams/${teamId}`, "Couldn't load the team."),
    ])
      .then(([v, t]) => {
        if (!live) return;
        apply(v);
        setMembers(t.members);
      })
      .catch((e: Error) => live && setLoadError(e.message));
    return () => {
      live = false;
    };
  }, [teamId]);

  const toneOf = useMemo(() => {
    const ids = [...new Set([...(view?.rotation?.user_ids ?? []), ...(view?.overrides ?? []).map((o) => o.user_id)])];
    return (id: number) => TONES[Math.max(0, ids.indexOf(id)) % TONES.length];
  }, [view]);

  if (error) return <p className="notice-error rounded-lg border px-3 py-2 text-sm">{error}</p>;
  if (!data) return <LoadingRow className="py-10" />;
  if (data.teams.length === 0) return <EmptyState icon={<PhoneCall />} title="No teams to set up" body="On call is set per team. Create a team first, or ask a manager to add you to one." />;

  const nameOf = (id: number) => members.find((m) => m.user_id === id)?.name ?? view?.people[id] ?? "Someone";
  const len = Number(draft.length_days);
  const lenError = !Number.isInteger(len) || len < 1 || len > 28 ? "Each turn lasts 1 to 28 days." : undefined;
  const dirty = !!view && JSON.stringify(draft) !== JSON.stringify(draftOf(view.rotation));
  const canSave = draft.user_ids.length > 0 && !lenError && /^\d{2}:\d{2}$/.test(draft.handover_time) && /^\d{4}-\d{2}-\d{2}$/.test(draft.starts_on);

  async function save() {
    if (!view || !canSave) return;
    setBusy(true);
    try {
      const v = await sendJson<OnCall>(
        `/api/helpdesk/admin/assignment/teams/${view.team.id}/on-call`,
        "PUT",
        { ...draft, length_days: len },
        "Couldn't save the rota."
      );
      apply(v);
      toast("ok", "Rota saved.");
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function clearRota() {
    if (!view) return;
    const ok = await confirmDialog({ title: "Remove the rota?", body: "Nobody will be on call except for cover you add. Rules that assign to whoever is on call will leave tickets in the queue.", confirmLabel: "Remove rota", danger: true });
    if (ok !== true) return;
    try {
      apply(await sendJson<OnCall>(`/api/helpdesk/admin/assignment/teams/${view.team.id}/on-call`, "DELETE", undefined, "Couldn't remove the rota."));
      toast("ok", "Rota removed.");
    } catch (e) {
      toast("error", (e as Error).message);
    }
  }

  const moveIn = (i: number, d: -1 | 1) => {
    const list = [...draft.user_ids];
    const j = i + d;
    if (j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    setDraft({ ...draft, user_ids: list });
  };
  const addable = members.filter((m) => !draft.user_ids.includes(m.user_id));

  return (
    <div className="space-y-5">
      <TeamPicker teams={data.teams} value={teamId} onChange={setTeamId} showMode={false} />
      {loadError && <p className="notice-error rounded-lg border px-3 py-2 text-sm">{loadError}</p>}
      {!view && !loadError && <LoadingRow className="py-10" />}
      {view && (
        <>
          <section aria-labelledby="oncall-now" className="flex flex-wrap items-center gap-3 rounded-xl border border-slate-200 bg-surface p-4 shadow-xs">
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-compass-600 text-white" aria-hidden>
              <PhoneCall className="h-5 w-5" />
            </span>
            <div className="min-w-0 flex-1">
              <h2 id="oncall-now" className={EYEBROW_TEXT}>
                On call now
              </h2>
              {view.now ? (
                <p className="mt-0.5 text-sm text-slate-800">
                  <span className="font-semibold">{view.now.name}</span>
                  <span className="text-slate-500"> until {whenLabel(view.now.ends_at)}</span>
                  {view.now.source === "override" && (
                    <Chip tone="warn" size="sm" className="ml-2">
                      Cover
                    </Chip>
                  )}
                </p>
              ) : (
                <p className="mt-0.5 text-sm text-slate-500">Nobody. Tickets a rule sends to whoever is on call wait in the queue.</p>
              )}
            </div>
          </section>

          <Card title="Rota" description="People take turns in this order. Each turn starts at the handover time, in the rota's timezone, even across clock changes.">
            <div className="space-y-4">
              <div>
                <p className="text-sm font-medium text-slate-800">People, in order</p>
                {draft.user_ids.length === 0 ? (
                  <SectionEmpty className="mt-1">Nobody on the rota yet.</SectionEmpty>
                ) : (
                  <ol className="mt-2 divide-y divide-slate-100 rounded-lg border border-slate-200">
                    {draft.user_ids.map((id, i) => (
                      <li key={id} className="flex items-center gap-3 px-3 py-2">
                        <span className="w-5 text-right text-xs tabular-nums text-slate-500">{i + 1}</span>
                        <span className={chipClass(toneOf(id), "sm")} aria-hidden>
                          {initialsOf(nameOf(id))}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-sm font-medium text-slate-900">{nameOf(id)}</span>
                        <button type="button" disabled={i === 0} onClick={() => moveIn(i, -1)} aria-label={`Move ${nameOf(id)} up`} data-tt="Move up" className={iconButtonClass("quiet", "sm")}>
                          <ArrowUp aria-hidden />
                        </button>
                        <button type="button" disabled={i === draft.user_ids.length - 1} onClick={() => moveIn(i, 1)} aria-label={`Move ${nameOf(id)} down`} data-tt="Move down" className={iconButtonClass("quiet", "sm")}>
                          <ArrowDown aria-hidden />
                        </button>
                        <button
                          type="button"
                          onClick={() => setDraft({ ...draft, user_ids: draft.user_ids.filter((x) => x !== id) })}
                          aria-label={`Take ${nameOf(id)} off the rota`}
                          data-tt="Remove"
                          className={iconButtonClass("quiet", "sm", "hover-danger")}
                        >
                          <X aria-hidden />
                        </button>
                      </li>
                    ))}
                  </ol>
                )}
                {addable.length > 0 && (
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <Select
                      dense
                      aria-label="Add someone to the rota"
                      value=""
                      onChange={(e) => e.target.value && setDraft({ ...draft, user_ids: [...draft.user_ids, Number(e.target.value)] })}
                      className="w-auto min-w-48"
                    >
                      <option value="">Add someone…</option>
                      {addable.map((m) => (
                        <option key={m.user_id} value={m.user_id}>
                          {m.name}
                        </option>
                      ))}
                    </Select>
                    <UserPlus className="h-4 w-4 text-slate-400" aria-hidden />
                  </div>
                )}
              </div>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <Field label="Each turn lasts" error={lenError}>
                  <div className="flex items-center gap-2">
                    <TextInput inputMode="numeric" value={draft.length_days} onChange={(e) => setDraft({ ...draft, length_days: e.target.value })} />
                    <span className="text-sm text-slate-500">days</span>
                  </div>
                </Field>
                <Field label="Handover time">
                  <TextInput type="time" value={draft.handover_time} onChange={(e) => setDraft({ ...draft, handover_time: e.target.value })} />
                </Field>
                <Field label="First handover">
                  <TextInput type="date" value={draft.starts_on} onChange={(e) => setDraft({ ...draft, starts_on: e.target.value })} />
                </Field>
                <Field label="Timezone">
                  <Select value={draft.timezone} onChange={(e) => setDraft({ ...draft, timezone: e.target.value })}>
                    {zones(draft.timezone).map((z) => (
                      <option key={z} value={z}>
                        {z.replace(/_/g, " ")}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
            </div>
            <SaveRow dirty={dirty} busy={busy} onSave={save} disabled={!canSave} label="Save rota">
              {view.rotation && (
                <Button variant="ghost" size="sm" icon={<Trash2 />} onClick={clearRota}>
                  Remove rota
                </Button>
              )}
            </SaveRow>
          </Card>

          <Strip view={view} toneOf={toneOf} />

          <Cover view={view} members={members} onChange={apply} />
        </>
      )}
    </div>
  );
}

function Strip({ view, toneOf }: { view: OnCall; toneOf: (id: number) => ChipTone }) {
  const weeks: OnCall["strip"][] = [];
  for (let i = 0; i < view.strip.length; i += 7) weeks.push(view.strip.slice(i, i + 7));
  const dayLabel = (ymd: string) => {
    const [y, m, d] = ymd.split("-").map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d, 12));
    return {
      short: dt.toLocaleDateString(undefined, { weekday: "short", timeZone: "UTC" }),
      day: dt.toLocaleDateString(undefined, { day: "numeric", month: "short", timeZone: "UTC" }),
      long: dt.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" }),
      num: String(d),
    };
  };
  const time = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", timeZone: view.timezone });
  return (
    <Card title="The next four weeks" icon={<CalendarRange />} description={`Times in ${view.timezone.replace(/_/g, " ")}.`}>
      {view.strip.every((d) => d.segments.length === 0) ? (
        <SectionEmpty>Nobody is on call in the next four weeks. Save a rota, or add cover.</SectionEmpty>
      ) : (
        <div className="space-y-1.5">
          {weeks.map((w, wi) => (
            <ol key={wi} className="grid grid-cols-7 gap-1" aria-label={`Week ${wi + 1}`}>
              {w.map((d) => {
                const l = dayLabel(d.date);
                const who = d.segments.map((s) => `${s.name}${s.source === "override" ? " (cover)" : ""} ${time(s.starts_at)} to ${time(s.ends_at)}`).join("; ");
                return (
                  <li key={d.date} className="min-w-0 rounded-lg border border-slate-100 bg-slate-50 p-1 sm:p-1.5" aria-label={`${l.long}: ${who || "nobody on call"}`}>
                    <p className="truncate text-2xs font-medium text-slate-500" aria-hidden>
                      <span className="sm:hidden">{l.num}</span>
                      <span className="hidden sm:inline">
                        {l.short} {l.day}
                      </span>
                    </p>
                    <div className="mt-1 flex flex-col gap-0.5" aria-hidden>
                      {d.segments.map((s, i) => (
                        <span
                          key={i}
                          data-tt={`${s.name}${s.source === "override" ? " (cover)" : ""}: ${time(s.starts_at)} to ${time(s.ends_at)}`}
                          className={`${chipClass(toneOf(s.user_id), "sm", `w-full justify-center truncate sm:justify-start ${s.source === "override" ? "border border-dashed border-current" : ""}`)}`}
                        >
                          <span className="sm:hidden">{initialsOf(s.name)}</span>
                          <span className="hidden truncate sm:inline">{s.name.split(/\s+/)[0]}</span>
                        </span>
                      ))}
                    </div>
                  </li>
                );
              })}
            </ol>
          ))}
        </div>
      )}
    </Card>
  );
}

function localInput(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function Cover({ view, members, onChange }: { view: OnCall; members: HdAssignmentMemberView[]; onChange: (v: OnCall) => void }) {
  const [who, setWho] = useState("");
  const [from, setFrom] = useState(localInput(new Date()));
  const [to, setTo] = useState(localInput(new Date(Date.now() + 86_400_000)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    const s = new Date(from);
    const en = new Date(to);
    if (!who) return setError("Choose who covers.");
    if (!(en > s)) return setError("The end must be after the start.");
    setBusy(true);
    try {
      const v = await sendJson<OnCall>(`/api/helpdesk/admin/assignment/teams/${view.team.id}/on-call/overrides`, "POST", { user_id: Number(who), starts_at: s.toISOString(), ends_at: en.toISOString() }, "Couldn't add the cover.");
      onChange(v);
      setWho("");
      toast("ok", "Cover added.");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove(o: Named) {
    try {
      onChange(await sendJson<OnCall>(`/api/helpdesk/admin/assignment/teams/${view.team.id}/on-call/overrides/${o.id}`, "DELETE", undefined, "Couldn't remove the cover."));
      toast("ok", "Cover removed.");
    } catch (err) {
      toast("error", (err as Error).message);
    }
  }

  return (
    <Card title="Cover" description="Someone stands in for the rota between two times: a swap, a holiday, a sick day.">
      {view.overrides.length > 0 && (
        <ul className="mb-4 divide-y divide-slate-100 rounded-lg border border-slate-200">
          {view.overrides.map((o) => (
            <li key={o.id} className="flex items-center gap-3 px-3 py-2">
              <span className="min-w-0 flex-1 text-sm">
                <span className="font-medium text-slate-900">{o.name}</span>
                <span className="text-slate-500">
                  {" "}
                  · {whenLabel(o.starts_at)} to {whenLabel(o.ends_at)}
                </span>
              </span>
              <button type="button" onClick={() => remove(o)} aria-label={`Remove ${o.name}'s cover`} data-tt="Remove" className={iconButtonClass("quiet", "sm", "hover-danger")}>
                <Trash2 aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={add} noValidate className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 lg:items-end">
        <Field label="Who covers">
          <Select value={who} onChange={(e) => setWho(e.target.value)}>
            <option value="">Choose someone</option>
            {members.map((m) => (
              <option key={m.user_id} value={m.user_id}>
                {m.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="From">
          <TextInput type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} />
        </Field>
        <Field label="Until">
          <TextInput type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} />
        </Field>
        <div>
          <Button type="submit" variant="secondary" icon={<Plus />} busy={busy}>
            Add cover
          </Button>
        </div>
        <FormError className="sm:col-span-2 lg:col-span-4">{error}</FormError>
      </form>
    </Card>
  );
}
