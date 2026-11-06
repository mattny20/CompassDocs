"use client";

// Account → Notifications (1.19.0): everything a person controls about
// what reaches them, inside the workspace's policy (lib/notify-policy).
// A pause card (everything except security, with presets; it acts at once)
// and quiet hours; then one card per section: events × channels, with the
// section's email frequency in the card header. A channel the workspace
// locked shows disabled with "Set by your workspace". One Save for the page.

import { useMemo, useState } from "react";
import { CirclePause, ExternalLink, Headset, Lock, MoonStar, Play } from "lucide-react";
import { Card } from "@/components/Card";
import { Table, TABLE_HEAD_ROW, TH, TD, TR } from "@/components/Table";
import { Field, TextInput, Toggle } from "@/components/form";
import { SaveRow } from "@/components/SaveRow";
import { Button } from "@/components/Button";
import { Segmented } from "@/components/Segmented";
import { SubHeading } from "@/components/Heading";
import { toast } from "@/components/Toasts";
import { useUnsavedChanges } from "@/lib/use-unsaved";
import { WEEKDAY_SHORT } from "@/lib/helpdesk/notify-prefs-shared";
import {
  NOTIFY_CHANNELS,
  NOTIFY_CHANNEL_HINT,
  NOTIFY_CHANNEL_LABEL,
  NOTIFY_SECTION_INFO,
  PAUSE_PRESET_LABEL,
  eventsInSection,
  type NotifyChannel,
  type NotifyEventDef,
  type NotifyMode,
  type NotifySection,
  type PausePreset,
  type UserNotifyPrefs,
} from "@/lib/notify-policy-shared";
import { SECTION_ICON } from "./section-icons";

export type PolicyViewMap = Record<
  string,
  { channels: Partial<Record<NotifyChannel, { default: boolean; control: string }>>; mode: NotifyMode; modeLocked: boolean }
>;

type Freq = NotifyMode | "default";

const FREQ_OPTIONS: { value: Freq; label: string; hint: string }[] = [
  { value: "default", label: "Default", hint: "As your workspace set each of these emails" },
  { value: "instant", label: "Instant", hint: "Each email as it happens" },
  { value: "digest_hourly", label: "Hourly", hint: "One summary email an hour" },
  { value: "digest_daily", label: "Daily", hint: "One summary email a day, from 08:00" },
];

function fmtUntil(iso: string, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone }).format(new Date(iso));
  } catch {
    return new Date(iso).toUTCString();
  }
}

export function NotificationPreferences({
  initial,
  policy,
  sections,
  webhookConfigured,
  timeZone,
  deskHref,
}: {
  initial: UserNotifyPrefs;
  policy: PolicyViewMap;
  /** The personal sections this person's workspace has (licensed). */
  sections: NotifySection[];
  webhookConfigured: boolean;
  timeZone: string;
  /** The desk's Notifications page, for helpdesk agents. */
  deskHref?: string | null;
}) {
  const [prefs, setPrefs] = useState<UserNotifyPrefs>(initial);
  const [busy, setBusy] = useState(false);
  const [pausing, setPausing] = useState(false);
  const snapshot = useMemo(() => JSON.stringify({ c: prefs.channels, d: prefs.digest, q: prefs.quiet }), [prefs]);
  const unsaved = useUnsavedChanges(snapshot);

  function update(fn: (p: UserNotifyPrefs) => void) {
    const next = structuredClone(prefs);
    fn(next);
    setPrefs(next);
    unsaved.markDirty();
  }

  function cell(def: NotifyEventDef, ch: NotifyChannel): { on: boolean; locked: boolean } {
    if (def.security) return { on: true, locked: true };
    const c = policy[def.id]?.channels[ch];
    if (!c) return { on: false, locked: true };
    if (c.control === "locked_on") return { on: true, locked: true };
    if (c.control === "locked_off") return { on: false, locked: true };
    return { on: prefs.channels[def.id]?.[ch] ?? c.default, locked: false };
  }

  function toggle(def: NotifyEventDef, ch: NotifyChannel) {
    const now = cell(def, ch);
    if (now.locked) return;
    const want = !now.on;
    const dflt = policy[def.id]?.channels[ch]?.default ?? false;
    update((p) => {
      const row = (p.channels[def.id] ??= {});
      // Back to the workspace default: no choice stored, so a later change of default reaches them.
      if (want === dflt) delete row[ch];
      else row[ch] = want;
      if (Object.keys(row).length === 0) delete p.channels[def.id];
    });
  }

  async function save() {
    setBusy(true);
    const res = await fetch("/api/account/notification-prefs", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prefs }),
    });
    setBusy(false);
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      toast("error", data?.error || "Couldn't save your notification preferences.");
      return;
    }
    setPrefs(data.prefs);
    unsaved.markClean(JSON.stringify({ c: data.prefs.channels, d: data.prefs.digest, q: data.prefs.quiet }));
    toast("ok", "Notification preferences saved.");
  }

  async function pause(preset: PausePreset) {
    setPausing(true);
    const res = await fetch("/api/account/notification-prefs", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pause: preset }),
    });
    setPausing(false);
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      toast("error", data?.error || "Couldn't change the pause.");
      return;
    }
    // Only the pause: unsaved edits elsewhere on the page stay.
    setPrefs((p) => ({ ...p, pause: data.prefs.pause }));
    toast("ok", preset === "off" ? "Notifications resumed." : "Notifications paused, except security.");
  }

  const paused = !!prefs.pause && (prefs.pause.until === null || Date.parse(prefs.pause.until) > Date.now());

  return (
    <div className="space-y-4">
      <Card id="pause" className="scroll-mt-6" icon={<CirclePause />} title="Pause and quiet hours" description="Take a break without changing your choices below.">
        <div className="space-y-5">
          <div>
            <SubHeading>Pause everything except security</SubHeading>
            {paused ? (
              <div className="mt-2 flex flex-wrap items-center gap-3 rounded-lg border border-compass-200 bg-compass-50/70 px-3 py-2 text-sm text-slate-700" role="status">
                <CirclePause className="h-4 w-4 text-compass-600" aria-hidden />
                <span>
                  Paused{" "}
                  {prefs.pause!.until ? <>until {fmtUntil(prefs.pause!.until, timeZone)}</> : <>until you resume</>}. The bell
                  keeps everything; security mail still arrives.
                </span>
                <Button variant="secondary" size="sm" icon={<Play />} busy={pausing} onClick={() => pause("off")} className="ml-auto">
                  Resume
                </Button>
              </div>
            ) : (
              <>
                <p className="mt-0.5 text-xs text-slate-500">
                  Email, push and chat stop; the bell keeps everything so nothing is lost.
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {(Object.keys(PAUSE_PRESET_LABEL) as Exclude<PausePreset, "off">[]).map((p) => (
                    <Button key={p} variant="secondary" size="sm" disabled={pausing} onClick={() => pause(p)}>
                      {PAUSE_PRESET_LABEL[p]}
                    </Button>
                  ))}
                </div>
              </>
            )}
          </div>

          <div className="border-t border-slate-100 pt-4">
            <Toggle
              label={
                <span className="inline-flex items-center gap-1.5">
                  <MoonStar className="h-4 w-4 text-compass-600" aria-hidden /> Quiet hours
                </span>
              }
              help={`Push waits, and instant email is held for a digest when they end. Urgent requests, read confirmations and security mail still come through. Times are in ${timeZone}.`}
              checked={prefs.quiet.enabled}
              onChange={(v) => update((p) => void (p.quiet.enabled = v))}
            />
            {prefs.quiet.enabled && (
              <div className="mt-3 space-y-3">
                <div className="flex flex-wrap gap-3">
                  <Field label="From" size="xs">
                    <TextInput type="time" value={prefs.quiet.start} onChange={(e) => update((p) => void (p.quiet.start = e.target.value || "18:00"))} />
                  </Field>
                  <Field label="Until" size="xs">
                    <TextInput type="time" value={prefs.quiet.end} onChange={(e) => update((p) => void (p.quiet.end = e.target.value || "08:00"))} />
                  </Field>
                </div>
                <fieldset>
                  <legend className="text-sm font-medium text-slate-800">Starting on</legend>
                  <div className="mt-1.5 flex flex-wrap gap-2">
                    {WEEKDAY_SHORT.map((label, d) => (
                      <label key={label} className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1 text-sm text-slate-700 has-[:checked]:border-compass-300 has-[:checked]:bg-compass-50 has-[:checked]:text-compass-700">
                        <input
                          type="checkbox"
                          className="h-4 w-4 accent-compass-600"
                          checked={prefs.quiet.days.includes(d)}
                          onChange={(e) =>
                            update((p) => {
                              p.quiet.days = e.target.checked ? [...new Set([...p.quiet.days, d])].sort() : p.quiet.days.filter((x) => x !== d);
                            })
                          }
                        />
                        {label}
                      </label>
                    ))}
                  </div>
                </fieldset>
              </div>
            )}
          </div>
        </div>
      </Card>

      {deskHref && (
        <p className="flex flex-wrap items-center gap-2 rounded-lg border border-compass-200 bg-compass-50/70 px-3 py-2 text-sm text-slate-700 print:hidden">
          <Headset className="h-4 w-4 text-compass-600" aria-hidden />
          <span>You work in the helpdesk desk: choose ticket notices, push devices and desk quiet hours there.</span>
          <a href={deskHref} target="_blank" rel="noopener" className="inline-flex items-center gap-1 font-medium text-compass-700 hover:underline">
            Desk notifications <ExternalLink className="h-3.5 w-3.5" aria-hidden />
            <span className="sr-only">(opens in a new tab)</span>
          </a>
        </p>
      )}

      {sections.map((section) => (
        <SectionCard
          key={section}
          section={section}
          prefs={prefs}
          policy={policy}
          cell={cell}
          onToggle={toggle}
          webhookConfigured={webhookConfigured}
          onFrequency={(m) =>
            update((p) => {
              if (m === "default") delete p.digest[section];
              else p.digest[section] = m;
            })
          }
        />
      ))}

      <SaveRow dirty={unsaved.dirty} busy={busy} onSave={save} label="Save preferences" />
    </div>
  );
}

function SectionCard({
  section,
  prefs,
  policy,
  cell,
  onToggle,
  onFrequency,
  webhookConfigured,
}: {
  section: NotifySection;
  prefs: UserNotifyPrefs;
  policy: PolicyViewMap;
  cell: (def: NotifyEventDef, ch: NotifyChannel) => { on: boolean; locked: boolean };
  onToggle: (def: NotifyEventDef, ch: NotifyChannel) => void;
  onFrequency: (m: Freq) => void;
  webhookConfigured: boolean;
}) {
  const info = NOTIFY_SECTION_INFO[section];
  const events = eventsInSection(section);
  const channels = NOTIFY_CHANNELS.filter((ch) => events.some((e) => e.channels[ch] !== undefined));
  const digestable = events.filter((e) => e.digest);
  const free = digestable.filter((e) => !policy[e.id]?.modeLocked);
  const freq: Freq = prefs.digest[section] ?? "default";
  const Icon = SECTION_ICON[section];
  const label = info.label;
  const rowLocked = (def: NotifyEventDef) => !def.security && channels.some((ch) => def.channels[ch] !== undefined && cell(def, ch).locked);

  // A render helper, not a component: a component defined here would remount (and drop focus) on every render.
  function channelBox(def: NotifyEventDef, ch: NotifyChannel) {
    const c = cell(def, ch);
    const name = `${def.label} by ${NOTIFY_CHANNEL_LABEL[ch].toLowerCase()}${c.locked ? " (set by your workspace)" : ""}`;
    return (
      <span className="inline-flex items-center justify-center gap-1" data-tt={c.locked ? (def.security ? "Security mail is always sent" : "Set by your workspace") : undefined}>
        <input
          type="checkbox"
          checked={c.on}
          disabled={c.locked}
          onChange={() => onToggle(def, ch)}
          aria-label={name}
          className="h-4 w-4 accent-compass-600 disabled:opacity-60"
        />
        {c.locked && <Lock className="h-3 w-3 text-slate-500" aria-hidden />}
      </span>
    );
  }

  return (
    <Card
      id={`notify-${section.replace(/_/g, "-")}`}
      className="scroll-mt-6"
      padding="none"
      icon={<Icon />}
      title={label}
      description={info.description}
    >
      {digestable.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-slate-100 px-4 py-2.5">
          <span className="text-sm font-medium text-slate-700" aria-hidden>
            Email frequency
          </span>
          {free.length > 0 ? (
            <Segmented size="sm" label={`Email frequency for ${label}`} options={FREQ_OPTIONS} value={freq} onChange={onFrequency} className="flex-wrap" />
          ) : (
            <span className="inline-flex items-center gap-1 text-xs text-slate-500">
              <Lock className="h-3 w-3" aria-hidden /> Set by your workspace
            </span>
          )}
        </div>
      )}
      {/* Phones: one block per event, its channels as labelled boxes in a row. */}
      <ul className="divide-y divide-slate-100 sm:hidden">
        {events.map((def) => (
          <li key={def.id} className="px-4 py-3">
            <RowLabel def={def} anyLocked={rowLocked(def)} />
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-2">
              {channels
                .filter((ch) => def.channels[ch] !== undefined)
                .map((ch) => (
                  <label key={ch} className="inline-flex items-center gap-1.5 text-sm text-slate-700">
                    {channelBox(def, ch)}
                    {NOTIFY_CHANNEL_LABEL[ch]}
                  </label>
                ))}
            </div>
          </li>
        ))}
      </ul>
      <div className="hidden sm:block">
        <Table scroll minWidth={`${14 + channels.length * 4.5}rem`}>
          <thead>
            <tr className={TABLE_HEAD_ROW}>
              <th scope="col" className={TH}>
                Event
              </th>
              {channels.map((ch) => (
                <th key={ch} scope="col" className={`${TH} w-20 text-center`}>
                  <span data-tt={ch === "webhook" && !webhookConfigured ? `${NOTIFY_CHANNEL_HINT[ch]} (not set up yet)` : NOTIFY_CHANNEL_HINT[ch]}>
                    {NOTIFY_CHANNEL_LABEL[ch]}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {events.map((def) => (
              <tr key={def.id} className={TR}>
                <td className={TD}>
                  <RowLabel def={def} anyLocked={rowLocked(def)} />
                </td>
                {channels.map((ch) => (
                  <td key={ch} className={`${TD} text-center`}>
                    {def.channels[ch] === undefined ? (
                      <span className="text-slate-500" data-tt="Not sent this way">
                        <span aria-hidden>–</span>
                        <span className="sr-only">Not sent by {NOTIFY_CHANNEL_LABEL[ch].toLowerCase()}</span>
                      </span>
                    ) : (
                      channelBox(def, ch)
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </Table>
      </div>
    </Card>
  );
}

function RowLabel({ def, anyLocked }: { def: NotifyEventDef; anyLocked: boolean }) {
  return (
    <>
      <span className="block font-medium text-slate-800">{def.label}</span>
      <span className="block text-xs text-slate-500">{def.hint}</span>
      {(anyLocked || def.security) && (
        <span className="mt-0.5 inline-flex items-center gap-1 text-2xs text-slate-500">
          <Lock className="h-3 w-3" aria-hidden /> {def.security ? "Always sent" : "Set by your workspace"}
        </span>
      )}
    </>
  );
}
