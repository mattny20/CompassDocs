// GET   /api/helpdesk/admin/settings   → { settings, inbound_path }
// PATCH /api/helpdesk/admin/settings   any of { timezone, days, start, end, holidays, outside_senders,
//         inbound_address, csat_enabled, email_from_name, setup_steps_done, rotate_inbound_secret: true,
//         trust_unverified_senders }
//         → { settings, inbound_path }. Audited (helpdesk.settings.updated,
//         changed keys only; helpdesk.inbound.secret_rotated for a new secret).
// settings.trust_unverified_senders is the email channel's sender check
// (lib/helpdesk/inbound, its own settings key): match mail to accounts
// even when the provider reports no SPF/DKIM/DMARC result. Off by default.
// Helpdesk 1.19.0 (desk capabilities: settings.manage for everything;
// business hours sla.manage, email channel channels.manage, survey
// csat.manage). The inbound secret is part of the
// webhook path (POST /api/helpdesk/inbound/<secret>), and that path is the
// only credential the webhook takes: it is returned only to holders of
// channels.manage or settings.manage (null for anyone else, e.g. a Manager
// with sla.manage or csat.manage), and never logged.

import { NextResponse } from "next/server";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { getInboundAuthSettings, saveInboundAuthSettings } from "@/lib/helpdesk/inbound";
import { readJson } from "@/lib/helpdesk/access";
import { hdAnyCapGate, hdCan, HD_FORBIDDEN } from "@/lib/helpdesk/roles";
import type { HdCap } from "@/lib/helpdesk/roles";
import { getHelpdeskSettings, markSetupSteps, newInboundSecret, publicSettings, saveHelpdeskSettings, validTimezone } from "@/lib/helpdesk/settings";
import type { HdSettings } from "@/lib/helpdesk/types";
import { badRequest } from "@/lib/helpdesk/routes";

export const dynamic = "force-dynamic";

type Gate = Parameters<typeof hdCan>[0];

/** The webhook path, for those who may manage the email channel; null for everyone else. */
async function inboundPath(gate: Gate, s: HdSettings): Promise<string | null> {
  if (!s.inbound_secret) return null;
  if (!(await hdCan(gate, "channels.manage")) && !(await hdCan(gate, "settings.manage"))) return null;
  return `/api/helpdesk/inbound/${s.inbound_secret}`;
}

async function view(gate: Gate, s: HdSettings) {
  const auth = await getInboundAuthSettings();
  return { settings: { ...publicSettings(s), trust_unverified_senders: auth.trust_unverified_senders }, inbound_path: await inboundPath(gate, s) };
}

/** Which desk capability each key needs (settings.manage covers them all). */
const KEY_CAP: Partial<Record<keyof HdSettings | "rotate_inbound_secret" | "trust_unverified_senders", HdCap>> = {
  timezone: "sla.manage",
  days: "sla.manage",
  start: "sla.manage",
  end: "sla.manage",
  holidays: "sla.manage",
  outside_senders: "channels.manage",
  inbound_address: "channels.manage",
  email_from_name: "channels.manage",
  rotate_inbound_secret: "channels.manage",
  trust_unverified_senders: "channels.manage",
  csat_enabled: "csat.manage",
  setup_steps_done: "settings.manage",
};
const READERS: HdCap[] = ["settings.manage", "sla.manage", "channels.manage", "csat.manage"];

export async function GET() {
  const gate = await hdAnyCapGate(READERS);
  if (gate instanceof NextResponse) return gate;
  const s = await getHelpdeskSettings();
  return NextResponse.json(await view(gate, s));
}

const KEYS: (keyof HdSettings)[] = [
  "timezone",
  "days",
  "start",
  "end",
  "holidays",
  "outside_senders",
  "inbound_address",
  "csat_enabled",
  "email_from_name",
  "setup_steps_done",
];

export async function PATCH(req: Request) {
  const gate = await hdAnyCapGate(READERS);
  if (gate instanceof NextResponse) return gate;
  const b = await readJson(req, 64 * 1024);
  if (!b) return badRequest("Send the settings as JSON.");
  if (!(await hdCan(gate, "settings.manage"))) {
    for (const [k, cap] of Object.entries(KEY_CAP)) {
      if (b[k] !== undefined && cap && !(await hdCan(gate, cap))) return NextResponse.json({ error: HD_FORBIDDEN }, { status: 403 });
    }
  }
  // Reject what normalising would silently replace, so a typo is an error rather than a default.
  if (b.timezone !== undefined && (typeof b.timezone !== "string" || !validTimezone(b.timezone))) return badRequest("Unknown time zone.");
  for (const k of ["start", "end"] as const) {
    if (b[k] !== undefined && (typeof b[k] !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(b[k] as string))) return badRequest("Times are HH:MM.");
  }
  if (b.start !== undefined && b.end !== undefined && String(b.end) <= String(b.start)) return badRequest("The day must end after it starts.");
  if (b.days !== undefined && (!Array.isArray(b.days) || !b.days.length || b.days.some((d) => !Number.isInteger(d) || d < 1 || d > 7))) {
    return badRequest("Working days are 1 (Monday) to 7 (Sunday).");
  }
  if (b.trust_unverified_senders !== undefined && typeof b.trust_unverified_senders !== "boolean") return badRequest("trust_unverified_senders is true or false.");
  if (b.holidays !== undefined && (!Array.isArray(b.holidays) || b.holidays.length > 366 || b.holidays.some((d) => typeof d !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(d)))) {
    return badRequest("Holidays are YYYY-MM-DD dates.");
  }
  const patch: Partial<HdSettings> = {};
  for (const k of KEYS) if (b[k] !== undefined) (patch as Record<string, unknown>)[k] = b[k];
  const rotate = b.rotate_inbound_secret === true;
  if (rotate) patch.inbound_secret = newInboundSecret();
  const { settings, changed } = await saveHelpdeskSettings(patch);
  const visible: string[] = changed.filter((k) => k !== "inbound_secret");
  if (b.trust_unverified_senders !== undefined) {
    const r = await saveInboundAuthSettings({ trust_unverified_senders: b.trust_unverified_senders === true });
    if (r.changed) visible.push("trust_unverified_senders");
  }
  if (visible.length) {
    await audit({
      actor: actorFrom(gate),
      action: "helpdesk.settings.updated",
      targetType: "helpdesk_settings",
      targetLabel: "Helpdesk settings",
      details: { changed: visible },
      ip: ipFrom(req),
    });
  }
  if (rotate) {
    await audit({
      actor: actorFrom(gate),
      action: "helpdesk.inbound.secret_rotated",
      targetType: "helpdesk_settings",
      targetLabel: "Helpdesk email address",
      ip: ipFrom(req),
    });
  }
  // The settings hours are the default calendar's now (lib/helpdesk/calendars, agent L): mirror the change there.
  const hourKeys = (["timezone", "days", "start", "end", "holidays"] as const).filter((k) => changed.includes(k));
  if (hourKeys.length) {
    const { applyLegacyHoursToDefaultCalendar } = await import("@/lib/helpdesk/calendars");
    await applyLegacyHoursToDefaultCalendar(Object.fromEntries(hourKeys.map((k) => [k, settings[k]])));
  }
  // Ticking the checklist: hours/email/csat as the admin saves each.
  if (hourKeys.length) await markSetupSteps(["hours"]);
  if (rotate || changed.includes("inbound_address")) await markSetupSteps(["email"]);
  if (changed.includes("csat_enabled")) await markSetupSteps(["csat"]);
  const fresh = await getHelpdeskSettings();
  return NextResponse.json(await view(gate, fresh));
}
