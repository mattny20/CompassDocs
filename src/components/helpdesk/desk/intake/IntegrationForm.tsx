"use client";

// The settings an integration has (agent P): name, team, default priority,
// the severity map, the dedup window, auto-resolve and reopen, the rate
// limit, and for automated mail the sender addresses, the subject pattern
// and whether mail without sender verdicts is accepted.
// Used by the create wizard's second step and the integration's page.

import { Field, Select, Textarea, TextInput, Toggle } from "@/components/form";
import { HD_PRIORITIES, HD_PRIORITY_LABEL, type HdPriority } from "@/lib/helpdesk/types";
import {
  HD_ALERT_SEVERITIES,
  HD_ALERT_SEVERITY_LABEL,
  HD_DEFAULT_SEVERITY_MAP,
  type HdIntegrationKind,
  type HdSeverityMap,
} from "@/lib/helpdesk/intake/shared";

export interface IntegrationDraft {
  name: string;
  default_team_id: number | null;
  default_priority: HdPriority;
  severity_map: HdSeverityMap;
  dedup_window_minutes: number;
  auto_resolve: boolean;
  reopen_on_repeat: boolean;
  rate_limit_per_minute: number;
  sender_addresses: string;
  subject_dedup_pattern: string;
  allow_unverified_mail: boolean;
}

export const DRAFT_DEFAULTS: IntegrationDraft = {
  name: "",
  default_team_id: null,
  default_priority: "normal",
  severity_map: { ...HD_DEFAULT_SEVERITY_MAP },
  dedup_window_minutes: 1440,
  auto_resolve: true,
  reopen_on_repeat: true,
  rate_limit_per_minute: 60,
  sender_addresses: "",
  subject_dedup_pattern: "",
  allow_unverified_mail: false,
};

const WINDOWS: { value: number; label: string }[] = [
  { value: 60, label: "1 hour" },
  { value: 240, label: "4 hours" },
  { value: 1440, label: "1 day" },
  { value: 4320, label: "3 days" },
  { value: 10080, label: "7 days" },
];

/** The body the API takes for a draft. */
export function draftBody(d: IntegrationDraft, kind: HdIntegrationKind): Record<string, unknown> {
  return {
    name: d.name.trim(),
    default_team_id: d.default_team_id,
    default_priority: d.default_priority,
    severity_map: d.severity_map,
    dedup_window_minutes: d.dedup_window_minutes,
    auto_resolve: d.auto_resolve,
    reopen_on_repeat: d.reopen_on_repeat,
    rate_limit_per_minute: d.rate_limit_per_minute,
    ...(kind === "email"
      ? {
          sender_addresses: d.sender_addresses.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean),
          subject_dedup_pattern: d.subject_dedup_pattern.trim(),
          allow_unverified_mail: d.allow_unverified_mail,
        }
      : {}),
  };
}

export function IntegrationForm({
  kind,
  draft,
  teams,
  onChange,
}: {
  kind: HdIntegrationKind;
  draft: IntegrationDraft;
  teams: { id: number; name: string }[];
  onChange: (patch: Partial<IntegrationDraft>) => void;
}) {
  const windows = WINDOWS.some((w) => w.value === draft.dedup_window_minutes)
    ? WINDOWS
    : [...WINDOWS, { value: draft.dedup_window_minutes, label: `${draft.dedup_window_minutes} minutes` }];
  return (
    <div className="space-y-5">
      <Field label="Name" help="Agents see it as the ticket's requester, e.g. Monitoring (Grafana)." size="md">
        <TextInput value={draft.name} onChange={(e) => onChange({ name: e.target.value })} maxLength={80} placeholder="Monitoring" autoComplete="off" />
      </Field>
      {kind === "email" && (
        <>
          <Field label="Sender addresses" help="The exact From addresses of the automated mail, one per line. Mail from them is accepted even though it is automated." size="lg">
            <Textarea rows={3} value={draft.sender_addresses} onChange={(e) => onChange({ sender_addresses: e.target.value })} placeholder="alerts@backup.example.com" />
          </Field>
          <Field
            label="Subject pattern (optional)"
            help="A regular expression whose first group names the alert, e.g. Job (\w+) failed. Empty: the subject without [RESOLVED], [FIRING] and numbers."
            size="lg"
          >
            <TextInput value={draft.subject_dedup_pattern} onChange={(e) => onChange({ subject_dedup_pattern: e.target.value })} maxLength={300} className="font-mono" autoComplete="off" />
          </Field>
          <Toggle
            label="Accept mail without SPF or DKIM results"
            help="Off (recommended): the mail provider must report that the sender's domain passed SPF, DKIM or DMARC, or the mail is refused. Turn on only if your provider reports no results; anyone can then forge these sender addresses. A failed check is always refused."
            checked={draft.allow_unverified_mail}
            onChange={(v) => onChange({ allow_unverified_mail: v })}
          />
        </>
      )}
      <div className="flex flex-wrap gap-4">
        <Field label="Team" help="Where its tickets land." size="sm" className="w-full sm:w-64">
          <Select value={draft.default_team_id ?? ""} onChange={(e) => onChange({ default_team_id: e.target.value ? Number(e.target.value) : null })}>
            <option value="">No team</option>
            {teams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Default priority" help="When the alert's severity isn't mapped." size="sm" className="w-full sm:w-64">
          <Select value={draft.default_priority} onChange={(e) => onChange({ default_priority: e.target.value as HdPriority })}>
            {HD_PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {HD_PRIORITY_LABEL[p]}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <fieldset>
        <legend className="mb-1 block text-xs font-medium text-slate-500">Severity to priority</legend>
        <div className="grid max-w-xl grid-cols-2 gap-3 sm:grid-cols-4">
          {HD_ALERT_SEVERITIES.map((s) => (
            <Field key={s} label={HD_ALERT_SEVERITY_LABEL[s]}>
              <Select
                value={draft.severity_map[s] ?? ""}
                onChange={(e) => {
                  const next = { ...draft.severity_map };
                  if (e.target.value) next[s] = e.target.value as HdPriority;
                  else delete next[s];
                  onChange({ severity_map: next });
                }}
              >
                <option value="">Default</option>
                {HD_PRIORITIES.map((p) => (
                  <option key={p} value={p}>
                    {HD_PRIORITY_LABEL[p]}
                  </option>
                ))}
              </Select>
            </Field>
          ))}
        </div>
        <p className="mt-1 text-xs text-slate-500">Tools&apos; own words are read as these four: Sev0 and P1 are Critical, error and P2 High, warn Warning, info and low Info.</p>
      </fieldset>
      <Field label="Repeat window" help="A repeat within this time reopens a solved ticket; later, it opens a new one." size="sm">
        <Select value={draft.dedup_window_minutes} onChange={(e) => onChange({ dedup_window_minutes: Number(e.target.value) })}>
          {windows.map((w) => (
            <option key={w.value} value={w.value}>
              {w.label}
            </option>
          ))}
        </Select>
      </Field>
      <div className="space-y-4">
        <Toggle
          label="Solve the ticket when the alert resolves"
          help="Adds a note either way. A ticket someone has replied on stays open for a person to close."
          checked={draft.auto_resolve}
          onChange={(v) => onChange({ auto_resolve: v })}
        />
        <Toggle
          label="Reopen a solved ticket when the alert fires again"
          help="Within the repeat window. Off: every repeat after solving opens a new ticket."
          checked={draft.reopen_on_repeat}
          onChange={(v) => onChange({ reopen_on_repeat: v })}
        />
      </div>
      <Field label="Rate limit" help="Alerts a minute; more are refused with 429 so a storm can't flood the desk." size="md">
        <TextInput
          type="number"
          min={1}
          max={600}
          value={draft.rate_limit_per_minute}
          onChange={(e) => onChange({ rate_limit_per_minute: Math.max(1, Math.min(600, Number(e.target.value) || 1)) })}
          className="max-w-40"
        />
      </Field>
    </div>
  );
}

export function draftFrom(v: {
  name: string;
  default_team_id: number | null;
  default_priority: HdPriority;
  severity_map: HdSeverityMap;
  dedup_window_minutes: number;
  auto_resolve: boolean;
  reopen_on_repeat: boolean;
  rate_limit_per_minute: number;
  sender_addresses: string[];
  subject_dedup_pattern: string;
  allow_unverified_mail?: boolean;
}): IntegrationDraft {
  return {
    name: v.name,
    default_team_id: v.default_team_id,
    default_priority: v.default_priority,
    severity_map: { ...v.severity_map },
    dedup_window_minutes: v.dedup_window_minutes,
    auto_resolve: v.auto_resolve,
    reopen_on_repeat: v.reopen_on_repeat,
    rate_limit_per_minute: v.rate_limit_per_minute,
    sender_addresses: v.sender_addresses.join("\n"),
    subject_dedup_pattern: v.subject_dedup_pattern,
    allow_unverified_mail: v.allow_unverified_mail === true,
  };
}
