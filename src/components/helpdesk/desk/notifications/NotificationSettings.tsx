"use client";

// Settings → Notifications in the desk (1.19.0): everything about what
// reaches one agent, and where. Cards: push on this device and the
// agent's devices; what reaches you where (events × Push / Email / Bell);
// new tickets per team; quiet hours; preview and sound; Install Desk.
// The header's Pause menu holds push and email for an hour, until 08:00
// tomorrow or until resumed. Every switch saves at once through PUT
// /api/helpdesk/me/notification-prefs (like Account → Notifications) and
// rolls back with the server's sentence when refused.

import { useCallback, useRef, useState } from "react";
import { BellOff, BellRing, Clock, Eye, Moon, Pause, Play, Users, Volume2 } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { Field, SectionEmpty, TextInput, Toggle } from "@/components/form";
import { Popover, MenuItem } from "@/components/Popover";
import { Segmented } from "@/components/Segmented";
import { toast } from "@/components/Toasts";
import { useFormatDate } from "@/components/SettingsProvider";
import {
  HD_CHANNEL_LABEL,
  HD_NOTIFY_CHANNELS,
  HD_NOTIFY_EVENT_INFO,
  HD_NOTIFY_EVENTS,
  WEEKDAY_SHORT,
  isPaused,
  type HdNotifyChannel,
  type HdNotifyEvent,
  type HdNotifyPrefs,
  type HdPauseRequest,
} from "@/lib/helpdesk/notify-prefs-shared";
import type { HdPushDevice } from "@/lib/helpdesk/push-shared";
import type { HdEffectiveMatrix, HdNotifyView as NotificationView } from "@/lib/helpdesk/notify-prefs";
import { sendJson } from "../api";
import { InstallDeskCard } from "../pwa/InstallDesk";
import { DevicesCard } from "./DevicesCard";

export type { HdNotifyView as NotificationView } from "@/lib/helpdesk/notify-prefs";

type Patch = {
  matrix?: Partial<Record<HdNotifyEvent, Partial<Record<HdNotifyChannel, boolean>>>>;
  teams?: Record<string, boolean>;
  quiet?: Partial<HdNotifyPrefs["quiet"]>;
  preview?: HdNotifyPrefs["preview"];
  sound?: boolean;
  pause?: HdPauseRequest;
  auto_follow?: boolean;
};

const DAY_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
/** Monday first, the way a working week reads. */
const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];

export function NotificationSettings({ initial, devices: initialDevices }: { initial: NotificationView; devices: HdPushDevice[] }) {
  const [view, setView] = useState<NotificationView>(initial);
  const [deviceCount, setDeviceCount] = useState(initialDevices.length);
  const saving = useRef(Promise.resolve());

  /** Optimistic: apply locally, send, roll back on refusal. Saves run one after another. */
  const save = useCallback(
    (patch: Patch, optimistic?: (v: NotificationView) => NotificationView, ok?: string) => {
      let before: NotificationView | null = null;
      if (optimistic) {
        setView((v) => {
          before = v;
          return optimistic(structuredClone(v));
        });
      }
      saving.current = saving.current.then(async () => {
        try {
          const next = await sendJson<NotificationView>("/api/helpdesk/me/notification-prefs", "PUT", patch, "Couldn't save your notification settings.");
          setView(next);
          if (ok) toast("ok", ok);
        } catch (e) {
          if (before) setView(before);
          toast("error", (e as Error).message);
        }
      });
      return saving.current;
    },
    []
  );

  const onCount = useCallback((n: number) => setDeviceCount(n), []);
  const prefs = view.prefs;
  const paused = view.paused_now && isPaused(prefs, new Date());

  return (
    <>
      <PageHeader
        icon={<BellRing />}
        title="Notifications"
        subtitle="Choose what reaches you about tickets, and where: this device, email or the bell."
        actions={<PauseMenu paused={paused} onPause={(p, ok) => save({ pause: p }, undefined, ok)} />}
      />
      {paused && <PausedBanner prefs={prefs} />}
      <div className="space-y-4">
        <DevicesCard initial={initialDevices} onCount={onCount} />
        <MatrixCard effective={view.effective} pushReady={deviceCount > 0} onToggle={(ev, ch, on) =>
          save({ matrix: { [ev]: { [ch]: on } } }, (v) => {
            v.prefs.matrix[ev][ch] = on;
            v.effective[ev][ch].on = on;
            return v;
          })
        } />
        <TeamsCard teams={view.teams} newTickets={view.effective.new_in_my_teams} onToggle={(id, on) =>
          save({ teams: { [String(id)]: on } }, (v) => {
            v.prefs.teams[String(id)] = on;
            v.teams = v.teams.map((t) => (t.id === id ? { ...t, on } : t));
            return v;
          })
        } />
        <FollowingCard prefs={prefs} onChange={(on) =>
          save({ auto_follow: on }, (v) => ({ ...v, prefs: { ...v.prefs, auto_follow: on } }))
        } />
        <QuietHoursCard prefs={prefs} timezone={view.timezone} onChange={(q) =>
          save({ quiet: q }, (v) => {
            v.prefs.quiet = { ...v.prefs.quiet, ...q };
            return v;
          })
        } />
        <PreviewCard prefs={prefs} onChange={(patch) =>
          save(patch, (v) => ({ ...v, prefs: { ...v.prefs, ...patch } }))
        } />
        <InstallDeskCard />
      </div>
    </>
  );
}

// --- Pause ------------------------------------------------------------------------

function PauseMenu({ paused, onPause }: { paused: boolean; onPause: (p: HdPauseRequest, ok: string) => void }) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const pick = (p: HdPauseRequest, ok: string) => {
    setOpen(false);
    btn.current?.focus();
    onPause(p, ok);
  };
  if (paused) {
    return (
      <Button variant="secondary" icon={<Play />} onClick={() => onPause("off", "Notifications resumed.")} className="print:hidden">
        Resume notifications
      </Button>
    );
  }
  return (
    <div className="relative print:hidden">
      <Button
        ref={btn}
        variant="secondary"
        icon={<Pause />}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        Pause notifications
      </Button>
      <Popover open={open} onClose={() => setOpen(false)} triggerRef={btn} role="menu" label="Pause notifications" align="end" width="w-60" className="mt-1">
        <p className="px-2 pb-1 pt-1.5 text-xs text-slate-500">Push and email wait; the bell keeps everything.</p>
        <MenuItem icon={<Clock />} onClick={() => pick("1h", "Notifications paused for an hour.")}>
          For 1 hour
        </MenuItem>
        <MenuItem icon={<Moon />} onClick={() => pick("tomorrow", "Notifications paused until 08:00 tomorrow.")}>
          Until tomorrow at 08:00
        </MenuItem>
        <MenuItem icon={<BellOff />} onClick={() => pick("indefinite", "Notifications paused until you resume them.")}>
          Until I resume
        </MenuItem>
      </Popover>
    </div>
  );
}

/** The pause as state; Resume notifications is the header's one action. */
function PausedBanner({ prefs }: { prefs: HdNotifyPrefs }) {
  const fmt = useFormatDate();
  const until = prefs.pause?.until;
  return (
    <div className="notice-warn mb-4 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border px-3 py-2 text-sm" role="status">
      <BellOff className="h-4 w-4 shrink-0" aria-hidden />
      <p className="min-w-0 flex-1">
        {until ? `Notifications are paused until ${fmt.dateTime(until)}.` : "Notifications are paused until you resume them."} Push and email
        wait; the bell still collects everything.
      </p>
    </div>
  );
}

// --- Events × channels ------------------------------------------------------------

function MatrixCard({
  effective,
  pushReady,
  onToggle,
}: {
  effective: HdEffectiveMatrix;
  pushReady: boolean;
  onToggle: (ev: HdNotifyEvent, ch: HdNotifyChannel, on: boolean) => void;
}) {
  const anyLock = HD_NOTIFY_EVENTS.some((ev) => HD_NOTIFY_CHANNELS.some((ch) => effective[ev][ch].locked));
  return (
    <Card
      id="events"
      className="scroll-mt-6"
      title="What reaches you where"
      icon={<Eye />}
      description="Push goes to the devices above, email to your account's address, and the bell is the desk's inbox."
    >
      {!pushReady && (
        <p id="push-off-reason" className="mb-3 text-sm text-slate-600">
          Push switches take effect once you turn on notifications on a device.
        </p>
      )}
      <div className="-mx-1 overflow-x-auto px-1">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs font-semibold uppercase tracking-wider text-slate-500">
              <th scope="col" className="pb-2 pr-2 font-semibold">
                Event
              </th>
              {HD_NOTIFY_CHANNELS.map((ch) => (
                <th key={ch} scope="col" className="w-14 pb-2 text-center font-semibold sm:w-20">
                  {HD_CHANNEL_LABEL[ch]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {HD_NOTIFY_EVENTS.map((ev) => {
              const info = HD_NOTIFY_EVENT_INFO[ev];
              return (
                <tr key={ev}>
                  <th scope="row" className="py-2.5 pr-2 text-left font-normal">
                    <span className="block font-medium text-slate-800">{info.label}</span>
                    <span className="block text-xs text-slate-500">{info.hint}</span>
                  </th>
                  {HD_NOTIFY_CHANNELS.map((ch) => {
                    const cell = effective[ev][ch];
                    const label = `${info.label} by ${HD_CHANNEL_LABEL[ch].toLowerCase()}`;
                    if (ch === "email" && !info.email) {
                      return (
                        <td key={ch} className="py-2.5 text-center">
                          <span className="text-slate-500" data-tt="No email is sent for this event" aria-label="No email for this event" role="img">
                            –
                          </span>
                        </td>
                      );
                    }
                    if (cell.locked) {
                      return (
                        <td key={ch} className="py-2.5 text-center">
                          <span className="inline-flex" data-tt="Set by your workspace" tabIndex={0} role="note" aria-label={`${label}: ${cell.on ? "on" : "off"}, set by your workspace`}>
                            <input type="checkbox" checked={cell.on} disabled readOnly tabIndex={-1} aria-hidden className="h-4 w-4" />
                          </span>
                        </td>
                      );
                    }
                    return (
                      <td key={ch} className="py-2.5 text-center">
                        <input
                          type="checkbox"
                          checked={cell.on}
                          onChange={(e) => onToggle(ev, ch, e.target.checked)}
                          aria-label={label}
                          aria-describedby={ch === "push" && !pushReady ? "push-off-reason" : undefined}
                          className="h-4 w-4"
                        />
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {anyLock && <p className="mt-3 text-xs text-slate-500">Dimmed switches are set by your workspace for everyone.</p>}
    </Card>
  );
}

// --- Teams ------------------------------------------------------------------------

function TeamsCard({
  teams,
  newTickets,
  onToggle,
}: {
  teams: NotificationView["teams"];
  newTickets: HdEffectiveMatrix["new_in_my_teams"];
  onToggle: (id: number, on: boolean) => void;
}) {
  const allOff = !newTickets.push.on && !newTickets.email.on && !newTickets.bell.on;
  return (
    <Card
      id="teams"
      className="scroll-mt-6"
      title="New tickets by team"
      icon={<Users />}
      description="Which of your teams' new tickets you hear about. Tickets assigned to you always reach you."
    >
      {teams.length === 0 ? (
        <SectionEmpty>You're not in a helpdesk team yet. A helpdesk manager adds you to teams in the desk's settings.</SectionEmpty>
      ) : (
        <div className="space-y-3">
          {allOff && <p className="text-sm text-slate-600">New in my teams is switched off for every channel above, so these switches have no effect now.</p>}
          {teams.map((t) => (
            <Toggle key={t.id} label={t.name} help={t.on ? "New tickets reach you" : "New tickets don't reach you"} checked={t.on} onChange={(on) => onToggle(t.id, on)} />
          ))}
        </div>
      )}
    </Card>
  );
}

// --- Quiet hours ------------------------------------------------------------------

function QuietHoursCard({
  prefs,
  timezone,
  onChange,
}: {
  prefs: HdNotifyPrefs;
  timezone: string;
  onChange: (q: Partial<HdNotifyPrefs["quiet"]>) => void;
}) {
  const q = prefs.quiet;
  const [start, setStart] = useState(q.start);
  const [end, setEnd] = useState(q.end);
  const valid = (t: string) => /^([01]\d|2[0-3]):[0-5]\d$/.test(t);
  const commit = (field: "start" | "end", value: string) => {
    if (valid(value) && value !== q[field]) onChange({ [field]: value });
  };
  const overnight = valid(start) && valid(end) && start > end;
  return (
    <Card
      id="quiet-hours"
      className="scroll-mt-6"
      title="Quiet hours"
      icon={<Moon />}
      description={`Hold back push and email at set times. Times are in your time zone, ${timezone}.`}
    >
      <div className="space-y-4">
        <Toggle label="Use quiet hours" help="The bell still collects everything; you catch up when quiet hours end." checked={q.enabled} onChange={(on) => onChange({ enabled: on })} />
        <fieldset disabled={!q.enabled} className="space-y-4 disabled:opacity-60">
          <legend className="sr-only">Quiet hours schedule</legend>
          <div className="flex flex-wrap items-start gap-4">
            <Field label="From" size="xs" error={valid(start) ? undefined : "Use a time like 18:00."}>
              <TextInput type="time" value={start} onChange={(e) => setStart(e.target.value)} onBlur={(e) => commit("start", e.target.value)} />
            </Field>
            <Field label="Until" size="xs" error={valid(end) ? undefined : "Use a time like 08:00."} help={overnight ? "The next morning" : undefined}>
              <TextInput type="time" value={end} onChange={(e) => setEnd(e.target.value)} onBlur={(e) => commit("end", e.target.value)} />
            </Field>
          </div>
          <fieldset>
            <legend className="mb-1 text-xs font-medium text-slate-500">On these days</legend>
            <div className="flex flex-wrap gap-2">
              {DAY_ORDER.map((d) => {
                const on = q.days.includes(d);
                return (
                  <label
                    key={d}
                    className={`inline-flex cursor-pointer items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-sm transition ${
                      on ? "border-compass-300 bg-compass-50 text-compass-700" : "border-slate-200 text-slate-700 hover:bg-slate-50"
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={(e) => onChange({ days: e.target.checked ? [...q.days, d] : q.days.filter((x) => x !== d) })}
                      className="h-4 w-4"
                    />
                    <span aria-hidden>{WEEKDAY_SHORT[d]}</span>
                    <span className="sr-only">{DAY_LONG[d]}</span>
                  </label>
                );
              })}
            </div>
            <p className="mt-1 text-xs text-slate-500">
              {overnight ? "A night's quiet hours belong to the day they start on." : "Choose the days quiet hours apply."} Same start and end
              time means the whole day.
            </p>
          </fieldset>
          <Toggle
            label="Let urgent tickets and SLA breaches through"
            help="Urgent-priority tickets and missed SLA targets still reach you during quiet hours."
            checked={q.breakthrough}
            onChange={(on) => onChange({ breakthrough: on })}
          />
        </fieldset>
      </div>
    </Card>
  );
}

// --- Following (1.19.1, agent V3) ------------------------------------------------

function FollowingCard({ prefs, onChange }: { prefs: HdNotifyPrefs; onChange: (on: boolean) => void }) {
  return (
    <Card id="following" className="scroll-mt-6" title="Following" icon={<Eye />} description="Tickets you follow tell you about new replies, notes and status changes (Tickets I follow, above).">
      <Toggle
        label="Follow tickets I reply to"
        help="Replying or adding a note follows the ticket. Unfollow from the ticket's header at any time; that ticket won't follow you again."
        checked={prefs.auto_follow !== false}
        onChange={onChange}
      />
    </Card>
  );
}

// --- Preview and sound ------------------------------------------------------------

function PreviewCard({ prefs, onChange }: { prefs: HdNotifyPrefs; onChange: (p: Pick<Patch, "preview" | "sound">) => void }) {
  return (
    <Card id="preview" className="scroll-mt-6" title="Preview and sound" icon={<Volume2 />} description="How push notifications look and sound on your devices.">
      <div className="space-y-4">
        <div>
          <p id="preview-label" className="mb-1 text-xs font-medium text-slate-500">
            Preview
          </p>
          <Segmented
            label="Preview"
            value={prefs.preview}
            onChange={(v) => onChange({ preview: v })}
            options={[
              { value: "full", label: "Show ticket details" },
              { value: "private", label: "Private" },
            ]}
            className="flex-wrap"
          />
          <div className="mt-3 max-w-sm rounded-lg border border-slate-200 bg-canvas p-3" aria-label="Example notification" role="img">
            <p className="text-sm font-semibold text-slate-800">
              {prefs.preview === "private" ? "New ticket #1048" : "New in IT: #1048 VPN keeps dropping"}
            </p>
            <p className="text-xs text-slate-600">{prefs.preview === "private" ? "Open the desk to read it." : "From Priya Shah"}</p>
          </div>
          <p className="mt-1 text-xs text-slate-500">
            Private keeps subjects and names off lock screens; the notification shows only the ticket number.
          </p>
        </div>
        <Toggle label="Play a sound" help="Off: notifications arrive silently, where the device allows it." checked={prefs.sound} onChange={(on) => onChange({ sound: on })} />
      </div>
    </Card>
  );
}
