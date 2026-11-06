"use client";

// Settings → Notifications → Policies (1.19.0): the workspace notification
// policy. One card per section; each row is an event, each column a
// channel. A cell sets the default for everyone and who decides (the
// person, or the workspace locks it on or off); the delivery column sets
// whether the event's email is sent at once or waits in an hourly or daily
// digest, and whether people may change that. Security mail is always on.
// One Save for the page (it is one document: the policy).

import { useMemo, useState } from "react";
import { Lock, RotateCcw } from "lucide-react";
import { Card } from "@/components/Card";
import { Table, TABLE_HEAD_ROW, TH, TD, TR } from "@/components/Table";
import { Select } from "@/components/form";
import { SaveRow } from "@/components/SaveRow";
import { Button } from "@/components/Button";
import { Chip, EnterpriseBadge, chipClass } from "@/components/Chip";
import { toast } from "@/components/Toasts";
import { useUnsavedChanges } from "@/lib/use-unsaved";
import {
  NOTIFY_CHANNELS,
  NOTIFY_CHANNEL_HINT,
  NOTIFY_CHANNEL_LABEL,
  NOTIFY_MODES,
  NOTIFY_SECTIONS,
  NOTIFY_SECTION_INFO,
  compactPolicy,
  eventsInSection,
  policyCell,
  policyMode,
  type NotifyChannel,
  type NotifyControl,
  type NotifyEventDef,
  type NotifyMode,
  type NotifyPolicy,
  type NotifySection,
} from "@/lib/notify-policy-shared";
import { SECTION_ICON } from "./section-icons";

type CellValue = "on" | "off" | "locked_on" | "locked_off";

// Short, so a cell fits a phone-width column; the intro says what On and Off mean.
const CELL_LABEL: Record<CellValue, string> = {
  on: "On",
  off: "Off",
  locked_on: "Locked on",
  locked_off: "Locked off",
};

const MODE_SHORT: Record<NotifyMode, string> = { instant: "Instant", digest_hourly: "Hourly", digest_daily: "Daily" };

function cellValue(policy: NotifyPolicy, def: NotifyEventDef, ch: NotifyChannel): CellValue {
  const c = policyCell(policy, def, ch);
  if (c.control === "locked_on") return "locked_on";
  if (c.control === "locked_off") return "locked_off";
  return c.default ? "on" : "off";
}

function modeValue(policy: NotifyPolicy, def: NotifyEventDef): string {
  const m = policyMode(policy, def);
  return `${m.locked ? "locked" : "choose"}:${m.mode}`;
}

export function NotificationPolicyPanel({
  initial,
  licensed,
  canManage = true,
}: {
  initial: NotifyPolicy;
  /** Licensed features ("policy_ack", "training", "helpdesk"). */
  licensed: string[];
  /** Holds notification.policy_manage; without it the policy is read-only. */
  canManage?: boolean;
}) {
  const [policy, setPolicy] = useState<NotifyPolicy>(initial);
  const [busy, setBusy] = useState(false);
  const snapshot = useMemo(() => JSON.stringify(compactPolicy(policy)), [policy]);
  const unsaved = useUnsavedChanges(snapshot);

  function update(fn: (p: NotifyPolicy) => void) {
    const next = structuredClone(policy);
    fn(next);
    setPolicy(next);
    unsaved.markDirty();
  }

  function setCell(def: NotifyEventDef, ch: NotifyChannel, v: CellValue) {
    update((p) => {
      const ev = (p.events[def.id] ??= {});
      const cells = (ev.channels ??= {});
      const control: NotifyControl = v === "locked_on" ? "locked_on" : v === "locked_off" ? "locked_off" : "choose";
      // A lock keeps the default it had, so unlocking returns to it.
      const prior = policyCell(p, def, ch).default;
      cells[ch] = { control, default: v === "on" ? true : v === "off" ? false : prior };
    });
  }

  function setMode(def: NotifyEventDef, v: string) {
    const [control, mode] = v.split(":") as ["choose" | "locked", NotifyMode];
    update((p) => {
      const ev = (p.events[def.id] ??= {});
      ev.mode = mode;
      ev.mode_control = control;
    });
  }

  async function save() {
    setBusy(true);
    const res = await fetch("/api/admin/notifications/policy", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ policy: compactPolicy(policy) }),
    });
    setBusy(false);
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      toast("error", data?.error || "Couldn't save the notification policy.");
      return;
    }
    setPolicy(data.policy);
    unsaved.markClean(JSON.stringify(compactPolicy(data.policy)));
    toast("ok", "Notification policy saved.");
  }

  function reset() {
    setPolicy({ v: 1, events: {} });
    unsaved.markDirty();
  }

  return (
    <div className="space-y-5">
      <div className="space-y-1 text-sm text-slate-600">
        <p>
          Set what everyone receives and whether people may change it. <strong>On</strong> and{" "}
          <strong>Off</strong> are the defaults each person can change; <strong>Locked on</strong>{" "}
          and <strong>Locked off</strong> decide for everyone and show as{" "}
          <strong>Set by your workspace</strong> on their Notifications page.
        </p>
        <p>
          Email delivery sends at once or gathers emails into an hourly or daily digest. Agents
          choose desk notices on the desk&apos;s own Notifications page, within this policy.
        </p>
      </div>
      {!canManage && (
        <p className="text-sm text-slate-600">
          You can view the policy. Changing it needs the <strong>Change notification policies</strong> permission.
        </p>
      )}
      <fieldset disabled={!canManage} className="min-w-0 space-y-5">
        {NOTIFY_SECTIONS.map((section) => (
          <PolicySection
            key={section}
            section={section}
            policy={policy}
            licensed={!NOTIFY_SECTION_INFO[section].feature || licensed.includes(NOTIFY_SECTION_INFO[section].feature!)}
            onCell={setCell}
            onMode={setMode}
          />
        ))}
      </fieldset>
      {canManage && (
        <SaveRow dirty={unsaved.dirty} busy={busy} onSave={save} label="Save policy">
          <Button variant="secondary" icon={<RotateCcw />} onClick={reset} disabled={busy}>
            Reset to defaults
          </Button>
        </SaveRow>
      )}
    </div>
  );
}

function PolicySection({
  section,
  policy,
  licensed,
  onCell,
  onMode,
}: {
  section: NotifySection;
  policy: NotifyPolicy;
  licensed: boolean;
  onCell: (def: NotifyEventDef, ch: NotifyChannel, v: CellValue) => void;
  onMode: (def: NotifyEventDef, v: string) => void;
}) {
  const info = NOTIFY_SECTION_INFO[section];
  const events = eventsInSection(section);
  const channels = NOTIFY_CHANNELS.filter((ch) => events.some((e) => e.channels[ch] !== undefined));
  const anyDigest = events.some((e) => e.digest);
  const Icon = SECTION_ICON[section];
  const id = `policy-${section.replace(/_/g, "-")}`;

  // Render helpers (not components, so a select keeps focus across renders).
  function channelControl(def: NotifyEventDef, ch: NotifyChannel) {
    if (def.channels[ch] === undefined) {
      return (
        <span className="text-slate-500" data-tt="Not sent this way">
          <span aria-hidden>–</span>
          <span className="sr-only">Not sent by {NOTIFY_CHANNEL_LABEL[ch].toLowerCase()}</span>
        </span>
      );
    }
    if (def.security) {
      return (
        <span className={chipClass("ok", "sm")} data-tt="Security mail is always sent">
          <Lock className="h-3 w-3" aria-hidden /> Always on
        </span>
      );
    }
    return (
      <Select
        dense
        value={cellValue(policy, def, ch)}
        onChange={(e) => onCell(def, ch, e.target.value as CellValue)}
        aria-label={`${def.label} by ${NOTIFY_CHANNEL_LABEL[ch].toLowerCase()}`}
      >
        {(Object.keys(CELL_LABEL) as CellValue[]).map((v) => (
          <option key={v} value={v}>
            {CELL_LABEL[v]}
          </option>
        ))}
      </Select>
    );
  }

  function deliveryControl(def: NotifyEventDef) {
    if (def.digest) {
      return (
        <Select dense value={modeValue(policy, def)} onChange={(e) => onMode(def, e.target.value)} aria-label={`${def.label}: email delivery`}>
          <optgroup label="Person chooses">
            {NOTIFY_MODES.map((m) => (
              <option key={m} value={`choose:${m}`}>
                {MODE_SHORT[m]}
              </option>
            ))}
          </optgroup>
          <optgroup label="Locked for everyone">
            {NOTIFY_MODES.map((m) => (
              <option key={m} value={`locked:${m}`}>
                {MODE_SHORT[m]}, locked
              </option>
            ))}
          </optgroup>
        </Select>
      );
    }
    if (def.channels.email !== undefined) {
      return (
        <span className="text-sm text-slate-500" data-tt={def.evidence ? "Sent at once: the email is part of the compliance record" : "Always sent at once"}>
          Instant
        </span>
      );
    }
    return (
      <span className="text-slate-500" data-tt="No email for this event">
        <span aria-hidden>–</span>
        <span className="sr-only">No email</span>
      </span>
    );
  }

  const label = (def: NotifyEventDef) => (
    <>
      <span className="block font-medium text-slate-800">{def.label}</span>
      <span className="block text-xs text-slate-500">{def.hint}</span>
      {def.audience && (
        <Chip tone="neutral" size="sm" className="mt-1">
          {def.audience}
        </Chip>
      )}
    </>
  );

  return (
    <Card
      id={id}
      className="scroll-mt-6"
      padding="none"
      icon={<Icon />}
      title={info.label}
      description={licensed ? info.description : `${info.description} Applies once the feature is licensed.`}
      actions={licensed ? undefined : <EnterpriseBadge />}
    >
      {/* Phones: one block per event, its channels as labelled selects in a grid. */}
      <ul className="divide-y divide-slate-100 sm:hidden">
        {events.map((def) => (
          <li key={def.id} className="px-4 py-3">
            {label(def)}
            <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-2">
              {channels
                .filter((ch) => def.channels[ch] !== undefined)
                .map((ch) => (
                  <div key={ch} className="min-w-0">
                    <span className="mb-0.5 block text-xs font-medium text-slate-600" aria-hidden>
                      {NOTIFY_CHANNEL_LABEL[ch]}
                    </span>
                    {channelControl(def, ch)}
                  </div>
                ))}
              {def.digest && (
                <div className="min-w-0">
                  <span className="mb-0.5 block text-xs font-medium text-slate-600" aria-hidden>
                    Email delivery
                  </span>
                  {deliveryControl(def)}
                </div>
              )}
            </div>
          </li>
        ))}
      </ul>
      <div className="hidden sm:block">
        <Table scroll minWidth={`${14 + channels.length * 7 + (anyDigest ? 9 : 0)}rem`}>
          <thead>
            <tr className={TABLE_HEAD_ROW}>
              <th scope="col" className={TH}>
                Event
              </th>
              {channels.map((ch) => (
                <th key={ch} scope="col" className={`${TH} w-28`}>
                  <span data-tt={NOTIFY_CHANNEL_HINT[ch]}>{NOTIFY_CHANNEL_LABEL[ch]}</span>
                </th>
              ))}
              {anyDigest && (
                <th scope="col" className={`${TH} w-36`}>
                  Email delivery
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {events.map((def) => (
              <tr key={def.id} className={TR}>
                <td className={TD}>{label(def)}</td>
                {channels.map((ch) => (
                  <td key={ch} className={TD}>
                    {channelControl(def, ch)}
                  </td>
                ))}
                {anyDigest && <td className={TD}>{deliveryControl(def)}</td>}
              </tr>
            ))}
          </tbody>
        </Table>
      </div>
    </Card>
  );
}
