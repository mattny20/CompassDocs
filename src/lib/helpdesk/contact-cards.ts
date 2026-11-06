// Helpdesk 1.19.0: contact cards, the server half. Server-only.
//
// A card is built from the person's CompassDocs directory entry (the user's
// linked entry, else the entry with their email), through the slots an
// admin mapped in Desk settings, Contact cards (helpdesk_contact_cards).
// The directory decides what the viewer may see: the person passes through
// viewerScope/personForViewer first, so an admins-only mobile or field is
// blank before any slot reads it, for agents and requesters alike. The
// audience then narrows the card to the parts that side is shown.
//
// Access (cardAudience): an agent who works the ticket sees the cards of
// the people on it (requester, contacts who wrote, approvers, people named
// in the form, the assignee and agents who replied); a requester sees only
// the card of the agent assigned to their request or who replied on it.
// Nobody else sees anything.
//
// VIP: a directory rule (a field value or an export marker) or the
// helpdesk's own list (people, groups, departments). isVip / vipInfo /
// vipMap answer for assignment rules, reports and the queue.

import "server-only";
import { getSetting, setSetting } from "../db";
import { userHolds } from "../access";
import { eePresent, featureEnabled } from "../ee";
import { getPersonById, listFields, type DirectoryField, type DirectoryPerson } from "../directory";
import { cellValue, matchesValue, rawValue, displayValue } from "../directory-display";
import { listMarkers } from "../directory-markers";
import { getOfficeConfig } from "../directory-offices-store";
import { officeBlock, officeKeyOf, officeProfileFor } from "../directory-offices";
import { personForViewer, viewerScope } from "../directory-viewer";
import type { Role, SessionUser } from "../types";
import { hq, hqOne } from "./db-core";
import { agentTeamIds, canWorkTicket, ticketRelation } from "./access";
import { HD_ROLE_LABEL, type HdRole } from "./roles-shared";
import type { HdAvailability, HdTicket } from "./types";
import {
  HD_CONTACT_CARDS_KEY,
  HD_CONTACT_RELATION_LABEL,
  cardInitials,
  defaultContactCardSettings,
  localTimeIn,
  sanitizeContactCardSettings,
  slackLinks,
  teamsLinks,
  telHref,
  validEmail,
  validTimeZone,
  webexLinks,
  type HdCardIm,
  type HdCardPart,
  type HdCardPhone,
  type HdContactCard,
  type HdContactCardSettings,
  type HdContactRelation,
  type HdTicketContacts,
} from "./contact-cards-shared";

export * from "./contact-cards-shared";

type Viewer = Pick<SessionUser, "id" | "role">;
type TicketRef = Pick<HdTicket, "id" | "number" | "requester_id" | "requester_name" | "requester_email" | "team_id" | "assignee_id"> & {
  team_name?: string | null;
  request_type_id?: number | null;
  form_answers?: unknown;
};

// --- Settings ------------------------------------------------------------------

export async function getContactCardSettings(): Promise<HdContactCardSettings> {
  const raw = await getSetting(HD_CONTACT_CARDS_KEY);
  if (!raw) return defaultContactCardSettings();
  try {
    return sanitizeContactCardSettings(JSON.parse(raw));
  } catch {
    return defaultContactCardSettings();
  }
}

/** Save (sanitised); returns the stored settings and the top-level keys that changed. */
export async function saveContactCardSettings(raw: unknown): Promise<{ settings: HdContactCardSettings; changed: string[] }> {
  const before = await getContactCardSettings();
  const merged = { ...before, ...((raw && typeof raw === "object" ? raw : {}) as object) };
  const settings = sanitizeContactCardSettings(merged);
  const changed = (Object.keys(settings) as (keyof HdContactCardSettings)[]).filter(
    (k) => JSON.stringify(settings[k]) !== JSON.stringify(before[k])
  );
  if (changed.length) await setSetting(HD_CONTACT_CARDS_KEY, JSON.stringify(settings));
  return { settings, changed };
}

// --- People ----------------------------------------------------------------------

interface UserRow {
  id: number;
  name: string;
  username: string;
  email: string;
  role: Role;
  directory_person_id: number | null;
}

async function userRow(userId: number | null): Promise<UserRow | undefined> {
  if (!userId) return undefined;
  return hqOne<UserRow>("SELECT id, name, username, email, role, directory_person_id FROM users WHERE id = $1", [userId]);
}

/** The visible directory entry for a user (their linked entry, else the one with their email). */
export async function directoryPersonFor(userId: number | null, email = ""): Promise<DirectoryPerson | undefined> {
  const row = await hqOne<{ id: number }>(
    `SELECT p.id FROM directory_people p
      WHERE p.hidden = 0 AND (
            p.id = (SELECT directory_person_id FROM users WHERE id = $1::int)
         OR ($2 <> '' AND lower(p.email) = lower($2)
             AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id = $1::int AND u.directory_person_id IS NOT NULL)))
      ORDER BY (p.id = (SELECT directory_person_id FROM users WHERE id = $1::int)) DESC NULLS LAST, p.id
      LIMIT 1`,
    [userId, email.trim()]
  );
  if (!row) return undefined;
  const p = await getPersonById(row.id);
  return p && !p.hidden ? p : undefined;
}

// --- VIP ---------------------------------------------------------------------------

export interface HdVipInfo {
  vip: boolean;
  reason: string;
}
const NOT_VIP: HdVipInfo = { vip: false, reason: "" };

interface VipContext {
  settings: HdContactCardSettings;
  fields: DirectoryField[];
  markerRule: { key: string; value: string; label: string } | null;
  groupNames: Map<number, string>;
}

async function vipContext(settings?: HdContactCardSettings, fields?: DirectoryField[]): Promise<VipContext> {
  const s = settings ?? (await getContactCardSettings());
  const f = fields ?? (await listFields());
  let markerRule: VipContext["markerRule"] = null;
  if (s.vip.rule === "marker" && s.vip.marker_id) {
    const m = (await listMarkers(f)).find((x) => x.id === s.vip.marker_id);
    if (m) markerRule = { key: m.key, value: m.value, label: m.label };
  }
  const groupIds = s.vip.list.filter((e) => e.kind === "group").map((e) => e.group_id!);
  const groupNames = new Map<number, string>();
  if (groupIds.length) {
    for (const g of await hq<{ id: number; name: string }>("SELECT id, name FROM groups WHERE id = ANY($1)", [groupIds])) groupNames.set(g.id, g.name);
  }
  return { settings: s, fields: f, markerRule, groupNames };
}

function ruleMatch(ctx: VipContext, person: DirectoryPerson | undefined): HdVipInfo | null {
  if (!person) return null;
  const { vip } = ctx.settings;
  const hasValue = (key: string, want: string) =>
    want ? matchesValue(person, key, want, ctx.fields) : cellValue(person, key, ctx.fields).trim() !== "";
  if (vip.rule === "field" && vip.field && hasValue(vip.field, vip.value)) {
    const field = ctx.fields.find((x) => x.key === vip.field);
    // An admins-only field never shows its value through the reason.
    const label = field?.label ?? vip.field;
    const detail = field?.visibility === "admins" ? "" : vip.value ? ` is ${vip.value}` : "";
    return { vip: true, reason: field?.visibility === "admins" ? "Directory VIP rule" : `Directory: ${label}${detail}` };
  }
  if (vip.rule === "marker" && ctx.markerRule && hasValue(ctx.markerRule.key, ctx.markerRule.value)) {
    return { vip: true, reason: `Directory: ${ctx.markerRule.label}` };
  }
  return null;
}

function listMatch(ctx: VipContext, userId: number | null, groups: Set<number>, person: DirectoryPerson | undefined): HdVipInfo | null {
  const note = (n: string) => (n ? `: ${n}` : "");
  for (const e of ctx.settings.vip.list) {
    if (e.kind === "user" && userId && e.user_id === userId) return { vip: true, reason: `VIP list${note(e.note)}` };
  }
  for (const e of ctx.settings.vip.list) {
    if (e.kind === "group" && groups.has(e.group_id!)) {
      return { vip: true, reason: `VIP list: ${ctx.groupNames.get(e.group_id!) ?? "a group"}${e.note ? ` (${e.note})` : ""}` };
    }
    if (e.kind === "department" && person && person.department.trim().toLowerCase() === e.department!.toLowerCase()) {
      return { vip: true, reason: `VIP list: ${person.department}${e.note ? ` (${e.note})` : ""}` };
    }
  }
  return null;
}

async function groupsOf(userIds: number[]): Promise<Map<number, Set<number>>> {
  const out = new Map<number, Set<number>>();
  if (!userIds.length) return out;
  for (const r of await hq<{ user_id: number; group_id: number }>("SELECT user_id, group_id FROM group_members WHERE user_id = ANY($1)", [userIds])) {
    if (!out.has(r.user_id)) out.set(r.user_id, new Set());
    out.get(r.user_id)!.add(r.group_id);
  }
  return out;
}

function vipEnabled(s: HdContactCardSettings): boolean {
  return s.vip.rule !== "off" || s.vip.list.length > 0;
}

/** Is this person a VIP, and why ("VIP list: Board member", "Directory: Tier is Partner")? */
export async function vipInfo(userId: number | null, email = "", ctxIn?: VipContext, personIn?: DirectoryPerson | null): Promise<HdVipInfo> {
  const ctx = ctxIn ?? (await vipContext());
  if (!vipEnabled(ctx.settings)) return NOT_VIP;
  const person = personIn === null ? undefined : personIn ?? (await directoryPersonFor(userId, email));
  const groups = userId ? (await groupsOf([userId])).get(userId) ?? new Set<number>() : new Set<number>();
  return listMatch(ctx, userId, groups, person) ?? ruleMatch(ctx, person) ?? NOT_VIP;
}

export async function isVip(userId: number | null, email = ""): Promise<boolean> {
  return (await vipInfo(userId, email)).vip;
}

/** VIP answers for many users at once (queue rows, reports). Users who are not VIPs are present with vip false. */
export async function vipMap(userIds: (number | null | undefined)[]): Promise<Map<number, HdVipInfo>> {
  const ids = [...new Set(userIds.filter((x): x is number => typeof x === "number" && x > 0))];
  const out = new Map<number, HdVipInfo>();
  if (!ids.length) return out;
  const ctx = await vipContext();
  if (!vipEnabled(ctx.settings)) {
    for (const id of ids) out.set(id, NOT_VIP);
    return out;
  }
  const [groups, links] = await Promise.all([
    groupsOf(ids),
    hq<{ user_id: number; person_id: number | null }>(
      `SELECT u.id AS user_id,
              COALESCE(u.directory_person_id,
                       (SELECT p.id FROM directory_people p WHERE p.hidden = 0 AND u.email <> '' AND lower(p.email) = lower(u.email) ORDER BY p.id LIMIT 1)) AS person_id
         FROM users u WHERE u.id = ANY($1)`,
      [ids]
    ),
  ]);
  const needPerson = ctx.settings.vip.rule !== "off" || ctx.settings.vip.list.some((e) => e.kind === "department");
  for (const l of links) {
    const person = needPerson && l.person_id ? await getPersonById(l.person_id) : undefined;
    const p = person && !person.hidden ? person : undefined;
    out.set(l.user_id, listMatch(ctx, l.user_id, groups.get(l.user_id) ?? new Set(), p) ?? ruleMatch(ctx, p) ?? NOT_VIP);
  }
  for (const id of ids) if (!out.has(id)) out.set(id, NOT_VIP);
  return out;
}

// --- Who is on a ticket ---------------------------------------------------------

interface TicketPerson {
  user_id: number | null;
  name: string;
  email: string;
  relation: HdContactRelation;
  relation_label?: string;
}

/** The people on a ticket an agent can reach: requester first, then contacts, approvers, form people. */
async function ticketPeople(t: TicketRef): Promise<TicketPerson[]> {
  const out: TicketPerson[] = [];
  const seen = new Set<string>();
  const add = (p: TicketPerson) => {
    const k = p.user_id ? `u${p.user_id}` : `e${p.email.toLowerCase()}`;
    if ((!p.user_id && !p.email) || seen.has(k)) return;
    seen.add(k);
    out.push(p);
  };
  add({ user_id: t.requester_id, name: t.requester_name, email: t.requester_email, relation: "requester" });
  // The people copied on it (1.19.1, agent V3, lib/helpdesk/ccs).
  const { listCcs } = await import("./ccs");
  for (const c of (await listCcs(t.id)).slice(0, 6)) {
    add({ user_id: c.userId, name: c.name, email: c.email, relation: "contact", relation_label: "CC" });
  }
  if (t.assignee_id) {
    const a = await userRow(t.assignee_id);
    if (a) add({ user_id: a.id, name: a.name || a.username, email: a.email, relation: "assignee" });
  }
  // Everyone else who wrote on it: agents who replied, people who wrote in by email.
  const authors = await hq<{ author_id: number | null; author_name: string; author_email: string; agent: boolean }>(
    `SELECT m.author_id, max(m.author_name) AS author_name, max(m.author_email) AS author_email,
            bool_or(m.kind = 'internal' OR m.via = 'desk') AS agent
       FROM hd_messages m
      WHERE m.ticket_id = $1 AND m.kind <> 'system' AND (m.author_id IS NOT NULL OR m.author_email <> '')
      GROUP BY m.author_id, CASE WHEN m.author_id IS NULL THEN lower(m.author_email) END
      ORDER BY min(m.created_at)
      LIMIT 20`,
    [t.id]
  );
  for (const a of authors) {
    add({ user_id: a.author_id, name: a.author_name, email: a.author_email ?? "", relation: a.agent ? "agent" : "contact" });
  }
  const approvers = await hq<{ id: number; name: string; username: string; email: string }>(
    `SELECT DISTINCT u.id, u.name, u.username, u.email
       FROM hd_approvals a JOIN users u ON u.id = COALESCE(a.decided_by, a.approver_user_id)
      WHERE a.ticket_id = $1 LIMIT 10`,
    [t.id]
  ).catch(() => []);
  for (const a of approvers) add({ user_id: a.id, name: a.name || a.username, email: a.email, relation: "approver" });
  // People named in the form ("New starter's manager").
  if (t.request_type_id) {
    const rt = await hqOne<{ form: { key: string; label: string; type: string }[] }>("SELECT form FROM hd_request_types WHERE id = $1", [t.request_type_id]);
    const answers = (t.form_answers && typeof t.form_answers === "object" ? t.form_answers : {}) as Record<string, unknown>;
    const named = (Array.isArray(rt?.form) ? rt!.form : []).filter((f) => f.type === "user" && Number.isSafeInteger(Number(answers[f.key])) && Number(answers[f.key]) > 0);
    for (const f of named.slice(0, 6)) {
      const u = await userRow(Number(answers[f.key]));
      if (u) add({ user_id: u.id, name: u.name || u.username, email: u.email, relation: "contact", relation_label: String(f.label).slice(0, 60) });
    }
  }
  return out.slice(0, 12);
}

/** The agents a requester may see: the assignee, and agents who replied in public (and whose reply they can read). */
async function helpingAgents(t: TicketRef): Promise<TicketPerson[]> {
  const out: TicketPerson[] = [];
  if (t.assignee_id) {
    const a = await userRow(t.assignee_id);
    if (a) out.push({ user_id: a.id, name: a.name || a.username, email: a.email, relation: "assignee" });
  }
  const repliers = await hq<{ author_id: number; name: string; username: string; email: string }>(
    `SELECT m.author_id, u.name, u.username, u.email
       FROM hd_messages m JOIN users u ON u.id = m.author_id
      WHERE m.ticket_id = $1 AND m.kind = 'public' AND m.author_id IS NOT NULL
        AND m.author_id IS DISTINCT FROM $2::int
        AND COALESCE(m.review_state, '') NOT IN ('pending', 'returned')
      GROUP BY m.author_id, u.name, u.username, u.email
      ORDER BY max(m.created_at) DESC
      LIMIT 5`,
    [t.id, t.requester_id]
  );
  for (const r of repliers) {
    if (out.some((o) => o.user_id === r.author_id)) continue;
    // Only people who work the ticket count as "helping": an approver's question is not an agent.
    const u = await userRow(r.author_id);
    if (!u || !(await canWorkTicket({ id: u.id, role: u.role }, t).catch(() => false))) continue;
    out.push({ user_id: r.author_id, name: r.name || r.username, email: r.email, relation: "agent" });
  }
  return out;
}

/**
 * The audience this viewer reads a person's card in, on this ticket, or
 * null when they may not see it at all.
 */
export async function cardAudience(viewer: Viewer, t: TicketRef, personUserId: number | null, email = ""): Promise<{ audience: "agent" | "requester"; person: TicketPerson } | null> {
  const relation = await ticketRelation(viewer, t);
  const match = (list: TicketPerson[]) =>
    list.find((p) => (personUserId ? p.user_id === personUserId : !p.user_id && email !== "" && p.email.toLowerCase() === email.toLowerCase()));
  if (relation === "agent") {
    const p = match(await ticketPeople(t));
    return p ? { audience: "agent", person: p } : null;
  }
  if (relation === "requester" || relation === "cc") {
    if (!personUserId) return null;
    const p = match(await helpingAgents(t));
    return p ? { audience: "requester", person: p } : null;
  }
  return null;
}

// --- The card ----------------------------------------------------------------------

/** The QR the directory profile shows: the (redacted) vCard itself, no photo, so a phone camera adds the contact. */
async function contactQr(person: DirectoryPerson, fields: DirectoryField[]): Promise<string> {
  const [{ default: QRCode }, { buildVCard }, { getAppSettings }, domain] = await Promise.all([
    import("qrcode"),
    import("../vcard"),
    import("../settings-store"),
    getSetting("custom_domain"),
  ]);
  const settings = await getAppSettings();
  const origin = domain?.trim() ? `https://${domain.trim()}` : "";
  const text = buildVCard({
    person,
    fields,
    company: settings.company_name || "",
    profileUrl: origin ? `${origin}/directory/${person.id}` : "",
    office: null,
    photo: false,
  });
  return QRCode.toDataURL(text, { margin: 1, width: 220, errorCorrectionLevel: "M" });
}

function officeTimezone(
  settings: HdContactCardSettings,
  person: DirectoryPerson,
  officeKey: string,
  profileValues: Record<string, string> | undefined
): string | null {
  if (settings.fields.timezone) {
    const v = rawValue(person, settings.fields.timezone).trim();
    if (validTimeZone(v)) return v;
  }
  const mapped = settings.office_timezones[officeKey.toLowerCase()];
  if (mapped && validTimeZone(mapped)) return mapped;
  for (const [k, v] of Object.entries(profileValues ?? {})) {
    if (/^(time_?zone|tz)$/i.test(k) && validTimeZone(v.trim())) return v.trim();
  }
  return null;
}

async function deskTeam(userId: number, audience: "agent" | "requester"): Promise<{ team: HdContactCard["team"]; availability: HdAvailability | null }> {
  const { hdRoleOf } = await import("./roles");
  const role = await hdRoleOf(userId).catch(() => null);
  if (!role) return { team: null, availability: null };
  const teams = await hq<{ name: string }>(
    "SELECT t.name FROM hd_team_members m JOIN hd_teams t ON t.id = m.team_id WHERE m.user_id = $1 ORDER BY t.position, t.name",
    [userId]
  );
  const avail = await hqOne<{ availability: HdAvailability }>("SELECT availability FROM hd_agent_prefs WHERE user_id = $1", [userId]);
  // A requester reads the rung, not the ladder: a newbie is an agent to them.
  const shown: Record<HdRole, string> = { newbie: "Agent", agent: "Agent", team_lead: "Team lead", manager: "Manager", admin: "Admin" };
  return {
    team: { names: teams.map((t) => t.name), role_label: audience === "agent" ? HD_ROLE_LABEL[role.role] : shown[role.role] },
    availability: avail?.availability ?? "available",
  };
}

async function earlierTickets(viewer: Viewer, t: TicketRef, person: TicketPerson): Promise<HdContactCard["earlier_tickets"]> {
  if (!person.user_id && !person.email) return null;
  const teams = await agentTeamIds(viewer);
  const params: unknown[] = [person.user_id, person.email, t.id];
  let scope = "";
  if (teams !== "all") {
    params.push(teams, viewer.id);
    scope = `AND (team_id = ANY($4) OR assignee_id = $5)`;
  }
  const where = `id <> $3 AND parent_ticket_id IS NULL
      AND (($1::int IS NOT NULL AND requester_id = $1) OR ($1::int IS NULL AND $2 <> '' AND lower(requester_email) = lower($2))) ${scope}`;
  const [agg, recent] = await Promise.all([
    hqOne<{ n: number; last_at: string | null }>(`SELECT count(*)::int AS n, max(created_at) AS last_at FROM hd_tickets WHERE ${where}`, params),
    hq<{ number: number; subject: string; status: string; created_at: string }>(
      `SELECT number, subject, status, created_at FROM hd_tickets WHERE ${where} ORDER BY created_at DESC LIMIT 5`,
      params
    ),
  ]);
  const link = person.user_id ? `/desk?requester=${person.user_id}` : `/desk?requester_email=${encodeURIComponent(person.email)}`;
  return { count: agg?.n ?? 0, last_at: agg?.last_at ?? null, link, recent };
}

/**
 * One person's card for this viewer. The caller decides access
 * (cardAudience); this only assembles, through the directory's visibility
 * rules and the audience's parts.
 */
export async function contactCardFor(
  viewer: Viewer,
  personUserId: number | null,
  opts: {
    ticket: TicketRef;
    audience: "agent" | "requester";
    fallback?: { name: string; email: string };
    relation?: HdContactRelation;
    relation_label?: string;
    settings?: HdContactCardSettings;
  }
): Promise<HdContactCard> {
  const settings = opts.settings ?? (await getContactCardSettings());
  const audience = opts.audience;
  const show = new Set<HdCardPart>(audience === "agent" ? settings.agent_sees : settings.requester_sees);
  const u = await userRow(personUserId);
  const name = (u ? u.name || u.username : "") || opts.fallback?.name || opts.fallback?.email || "Someone";
  const accountEmail = u?.email || opts.fallback?.email || "";
  const relation = opts.relation ?? (personUserId && personUserId === opts.ticket.requester_id ? "requester" : "contact");
  const fields = await listFields();
  // 1.19.1 (agent V6): a customer-portal contact is not in the directory,
  // whatever entry shares the address: name and email only.
  const portalContact = !u && (await (await import("./portal")).isPortalContactEmail(accountEmail));
  const stored = portalContact ? undefined : await directoryPersonFor(u?.id ?? null, accountEmail);

  const [readDir, readPhoto] = await Promise.all([
    userHolds(viewer, "directory.read", { legacyMin: "viewer" }).catch(() => false),
    userHolds(viewer, "directory.photo_read", { legacyMin: "viewer" }).catch(() => false),
  ]);

  const card: HdContactCard = {
    user_id: u?.id ?? null,
    directory_id: null,
    name,
    initials: cardInitials(name),
    photo_url: null,
    pronouns: "",
    title: "",
    department: "",
    office: null,
    manager: null,
    vip: { vip: false, reason: "" },
    presence: false,
    phones: [],
    email: "",
    im: [],
    extra: [],
    profile_url: null,
    vcard_url: null,
    qr: "",
    calendar_href: null,
    team: null,
    availability: null,
    earlier_tickets: null,
    relation,
    relation_label: opts.relation_label || HD_CONTACT_RELATION_LABEL[relation],
    audience,
    minimal: !stored,
  };

  // Directory visibility first: what this viewer may not see is gone before any slot reads it.
  const scope = await viewerScope(viewer, fields);
  const person = stored ? personForViewer(scope, stored) : undefined;
  const vfields = scope.fields;
  const val = (key: string) => (person && key && !scope.hidden.has(key) ? cellValue(person, key, vfields).trim() : "");
  const raw = (key: string) => (person && key && !scope.hidden.has(key) ? rawValue(person, key).trim() : "");

  // Email: the mapped field, else the account's own address (the person is a user of this workspace).
  const dirEmail = val(settings.fields.email);
  const emailHidden = !!person && settings.fields.email === "email" && scope.hidden.has("email");
  const email = dirEmail || (emailHidden ? "" : accountEmail);
  if (show.has("email") && validEmail(email)) card.email = email;

  if (person) {
    card.directory_id = person.id;
    if (show.has("photo") && readPhoto && person.photo) {
      card.photo_url = `/api/directory/${person.id}/photo?size=large&v=${Math.floor((Date.parse(person.updated_at) || 0) / 1000)}`;
    }
    if (show.has("pronouns")) card.pronouns = val(settings.fields.pronouns);
    if (show.has("title")) card.title = val(settings.fields.title);
    if (show.has("department")) card.department = val(settings.fields.department);
    if (show.has("office") && settings.fields.office) {
      const officeRaw = raw(settings.fields.office);
      if (officeRaw) {
        const officeField = fields.find((f) => f.key === settings.fields.office);
        const offices = await getOfficeConfig();
        const key = officeKeyOf(officeRaw, officeField);
        const profile = officeProfileFor(offices, key);
        const display = profile ? officeBlock(profile, offices.fields, officeField).name : officeField ? displayValue(officeField, officeRaw) : officeRaw;
        const tz = officeTimezone(settings, person, key, profile?.values);
        const lt = show.has("local_time") ? localTimeIn(tz) : null;
        card.office = { name: display, timezone: show.has("local_time") ? tz : null, local_time: lt?.time ?? null, utc_offset: lt?.offset ?? null };
      }
    } else if (show.has("local_time")) {
      const tz = officeTimezone(settings, person, "", undefined);
      const lt = localTimeIn(tz);
      if (lt) card.office = { name: "", timezone: tz, local_time: lt.time, utc_offset: lt.offset };
    }
    if (show.has("manager") && settings.fields.manager && !scope.hidden.has(settings.fields.manager)) {
      const ref = person.links?.[settings.fields.manager]?.[0];
      if (ref) card.manager = { name: ref.name, directory_id: readDir ? ref.id : null };
    }
    const phone = (kind: HdCardPhone["kind"], label: string, value: string) => {
      if (value) card.phones.push({ kind, label, value, tel_href: telHref(value) });
    };
    if (show.has("desk_phone")) phone("desk", "Desk phone", val(settings.fields.desk_phone));
    if (show.has("cell_phone")) phone("cell", "Cell phone", val(settings.fields.cell_phone));
    if (show.has("extra")) {
      for (const key of settings.extra) {
        const f = vfields.find((x) => x.key === key);
        const v = val(key);
        if (!f || !v) continue;
        if (f.display === "phone") phone("other", f.label, v);
        else card.extra.push({ key, label: f.label, value: v });
      }
    }
    if (show.has("profile") && readDir) card.profile_url = `/directory/${person.id}`;
    if (show.has("vcard") && readDir) {
      card.vcard_url = `/api/directory/${person.id}/vcard`;
      card.qr = await contactQr(person, vfields).catch(() => "");
    }
    if (show.has("presence") && person.source === "graph" && eePresent()) {
      const on = await featureEnabled("directory_sync").catch(() => false);
      if (on) {
        const { getDirectoryGraphConfig } = await import("../directory-config");
        card.presence = (await getDirectoryGraphConfig().catch(() => ({ presence: false }))).presence;
      }
    }
  }

  // IM. Teams by email/UPN (Microsoft-synced people, or everyone), or a mapped field.
  const im: HdCardIm[] = [];
  if (show.has("teams") && settings.teams.mode !== "off") {
    let upn = "";
    if (settings.teams.mode === "field") upn = val(settings.teams.field);
    else if (settings.teams.mode === "everyone" || person?.source === "graph") upn = email;
    const l = teamsLinks(upn);
    if (l) im.push({ kind: "teams", label: "Teams", href: l.href, app_href: l.app_href, value: upn });
  }
  if (show.has("webex") && settings.webex.mode !== "off") {
    const v = settings.webex.mode === "email" ? email : val(settings.webex.field);
    const l = webexLinks(v);
    if (l) im.push({ kind: "webex", label: l.label, href: l.href, value: l.value });
  }
  if (show.has("slack") && settings.slack.mode === "field") {
    const l = slackLinks(val(settings.slack.field), settings.slack.domain, settings.slack.team_id);
    if (l) im.push({ kind: "slack", label: "Slack", href: l.href, ...(l.app_href ? { app_href: l.app_href } : {}), value: l.value });
  }
  card.im = im;
  if (show.has("teams") && settings.teams.mode !== "off" && person?.source === "graph" && validEmail(email)) {
    card.calendar_href = `https://outlook.office.com/calendar/deeplink/compose?to=${encodeURIComponent(email)}&subject=${encodeURIComponent(`Meeting with ${name}`)}`;
  }

  // Desk side: their teams and availability (when they are an agent).
  if (u && (show.has("team") || show.has("availability"))) {
    const d = await deskTeam(u.id, audience);
    if (show.has("team")) card.team = d.team;
    if (show.has("availability")) card.availability = d.availability;
  }

  if (audience === "agent") {
    card.vip = await vipInfo(u?.id ?? null, accountEmail, undefined, stored ?? null);
    if (relation === "requester" || relation === "contact") {
      card.earlier_tickets = await earlierTickets(viewer, opts.ticket, { user_id: u?.id ?? null, name, email: accountEmail, relation });
    }
  }
  return card;
}

/** Every card this viewer may see on a ticket: the agent's contacts stack, or the requester's "Who's helping you". */
export async function ticketContactCards(viewer: Viewer, t: TicketRef): Promise<HdTicketContacts | null> {
  const relation = await ticketRelation(viewer, t);
  // A CC (1.19.1) sees "Who's helping you" as the requester does.
  if (relation !== "agent" && relation !== "requester" && relation !== "cc") return null;
  const settings = await getContactCardSettings();
  const team = t.team_name ?? (t.team_id ? (await hqOne<{ name: string }>("SELECT name FROM hd_teams WHERE id = $1", [t.team_id]))?.name ?? null : null);
  if (relation === "agent") {
    const people = (await ticketPeople(t)).filter((p) => p.relation !== "assignee" && p.relation !== "agent");
    const contacts: HdContactCard[] = [];
    for (const p of people) {
      contacts.push(
        await contactCardFor(viewer, p.user_id, {
          ticket: t,
          audience: "agent",
          fallback: { name: p.name, email: p.email },
          relation: p.relation,
          relation_label: p.relation_label,
          settings,
        })
      );
    }
    return { audience: "agent", contacts, team_name: team, assigned: !!t.assignee_id };
  }
  const agents = await helpingAgents(t);
  const contacts: HdContactCard[] = [];
  for (const p of agents.slice(0, 3)) {
    contacts.push(await contactCardFor(viewer, p.user_id, { ticket: t, audience: "requester", relation: p.relation, settings }));
  }
  return { audience: "requester", contacts, team_name: team, assigned: !!t.assignee_id };
}

/** Plain helper for the settings page: the people, groups and departments a VIP list names. */
export async function vipListLabels(s: HdContactCardSettings): Promise<{ users: Record<number, string>; groups: Record<number, string> }> {
  const userIds = s.vip.list.filter((e) => e.kind === "user").map((e) => e.user_id!);
  const groupIds = s.vip.list.filter((e) => e.kind === "group").map((e) => e.group_id!);
  const [users, groups] = await Promise.all([
    userIds.length ? hq<{ id: number; name: string; username: string }>("SELECT id, name, username FROM users WHERE id = ANY($1)", [userIds]) : [],
    groupIds.length ? hq<{ id: number; name: string }>("SELECT id, name FROM groups WHERE id = ANY($1)", [groupIds]) : [],
  ]);
  return {
    users: Object.fromEntries(users.map((u) => [u.id, u.name || u.username])),
    groups: Object.fromEntries(groups.map((g) => [g.id, g.name])),
  };
}
