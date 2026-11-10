// Helpdesk 1.20.2: several help addresses (mailboxes). Schema:
// lib/helpdesk/mailboxes-schema; the pure half (address rules, which listed
// address a mail was sent to): lib/helpdesk/mailboxes-shared. Server-only.
//
//   - Every listed address forwards to the one inbound webhook
//     (lib/helpdesk/inbound); the address a mail was sent to becomes the
//     ticket's mailbox (hd_tickets.mailbox_id) and, when nothing else picks
//     a team, its team.
//   - Mail to the requester and the people copied goes out under the
//     ticket's mailbox (lib/helpdesk/email): its name, its address when
//     "send from this address" is on, and its address plus the ticket's
//     token as Reply-To. A ticket with no mailbox of its own uses its
//     team's, else the default. Agent-only notices are unchanged.
//   - Upgrade: the single address of 1.20.1 (helpdesk_settings
//     .inbound_address / email_from_name) becomes the default mailbox the
//     first time this module is asked (mailboxesReady, once per process).
//     From then on the default mailbox is mirrored back into those two
//     settings (in the transaction that changes the mailboxes, only those
//     two keys), and a write to them (the old settings API) moves the
//     default mailbox, so both stay one fact and a 1.20.1 binary on the
//     same database keeps answering as before. With no mailbox at all the
//     old settings are read as they always were. A 1.20.1 address with a
//     plus tag (company+help@…) is listed without the tag.
//
// Mailbox addresses are the workspace's configuration, not personal data:
// retention, anonymise and the personal data export leave them alone.

import "server-only";
import { audit } from "../audit";
import type { AuditActor } from "../audit";
import { logEvent } from "../log";
import { hq, hqOne, withTx } from "./db-core";
import type { HdQueryable } from "./db-core";
import { HD_SETTINGS_KEY, getHelpdeskSettings } from "./settings";
import {
  MAILBOX_LIMITS,
  cleanMailboxAddress,
  cleanMailboxName,
  isOwnMailboxAddress,
  mailboxAddressProblem,
  mailboxForRecipients,
  mailboxForTicket,
  mailboxKey,
  matchMailbox,
} from "./mailboxes-shared";
import type { HdMailbox, HdMailboxOption, HdMailboxView, HdTicketMailbox, MailboxRecipientSource } from "./mailboxes-shared";

export type { HdMailbox, HdMailboxOption, HdMailboxView, HdTicketMailbox } from "./mailboxes-shared";

const COLS = "id, address, name, team_id, send_from, send_from_error, send_from_error_at, is_default, position, created_at, updated_at";
const ORDER = "ORDER BY position, id";

export class HdMailboxError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

// --- Upgrade seed ----------------------------------------------------------------

let readyPromise: Promise<void> | null = null;

/**
 * The 1.20.1 setting as a mailbox address: lower-cased and without its plus
 * tag. 1.20.1 took a tagged address (company+help@gmail.com) and answered
 * on company+hd-<token>@…; a mailbox is the address before the tag, and
 * every tagged form of it still matches (mailboxKey). Null when the setting
 * holds no address.
 */
export function legacyMailboxAddress(raw: unknown): string | null {
  return typeof raw === "string" ? cleanMailboxAddress(mailboxKey(raw)) : null;
}

/**
 * The 1.20.1 address becomes the default mailbox when none exists yet.
 * Idempotent (the address is unique); answers the mailbox it made, if any.
 * Exported for tests; everything else goes through mailboxesReady().
 */
export async function seedMailboxFromSettings(): Promise<HdMailbox | null> {
  const s = await getHelpdeskSettings();
  const address = legacyMailboxAddress(s.inbound_address);
  if (!address) return null;
  return withTx(async (client) => {
    const has = await client.query("SELECT 1 FROM hd_mailboxes LIMIT 1");
    if (has.rowCount) return null;
    const row = (
      await hq<HdMailbox>(
        `INSERT INTO hd_mailboxes (address, name, is_default) VALUES ($1, $2, true)
         ON CONFLICT DO NOTHING RETURNING ${COLS}`,
        [address, cleanMailboxName(s.email_from_name) || "Helpdesk"],
        client
      )
    )[0];
    return row ?? null;
  });
}

/** Wait for the schema and run the upgrade seed. Once per process (a failure is retried on the next call). */
export function mailboxesReady(): Promise<void> {
  if (!readyPromise) {
    readyPromise = seedMailboxFromSettings().then(
      (made) => {
        if (made) logEvent("info", "helpdesk.mailbox_seeded", { mailbox: made.id });
      },
      (e) => {
        readyPromise = null;
        throw e;
      }
    );
  }
  return readyPromise;
}

/** Tests: run the upgrade seed again on the next read. */
export function resetMailboxesReadyForTests(): void {
  readyPromise = null;
}

// --- Reads -----------------------------------------------------------------------

/** Every mailbox, in list order. With `client` the read stays on it (and the seed is the caller's business). */
export async function listMailboxes(client?: HdQueryable): Promise<HdMailbox[]> {
  if (!client) await mailboxesReady();
  return hq<HdMailbox>(`SELECT ${COLS} FROM hd_mailboxes ${ORDER}`, [], client);
}

export async function getMailbox(id: number, client?: HdQueryable): Promise<HdMailbox | undefined> {
  if (!client) await mailboxesReady();
  return hqOne<HdMailbox>(`SELECT ${COLS} FROM hd_mailboxes WHERE id = $1`, [id], client);
}

/** The Email settings page's list: each mailbox with its team's name and how many tickets carry it. */
export async function mailboxViews(): Promise<HdMailboxView[]> {
  await mailboxesReady();
  return hq<HdMailboxView>(
    `SELECT ${COLS.split(", ").map((c) => `m.${c}`).join(", ")}, tm.name AS team_name,
            (SELECT count(*)::int FROM hd_tickets t WHERE t.mailbox_id = m.id) AS tickets
       FROM hd_mailboxes m LEFT JOIN hd_teams tm ON tm.id = m.team_id
      ORDER BY m.position, m.id`
  );
}

type DeskUser = { id: number; role: import("../types").Role };

/**
 * Which mailboxes an agent may read and answer from: "all" with
 * tickets.view_all or settings.manage, else the ids of their teams. A
 * mailbox mapped to a team is that team's identity: an agent of another
 * team neither sees it listed nor sends a requester mail under it.
 */
export async function mailboxScope(user: DeskUser): Promise<"all" | number[]> {
  const { hdCan, roleFacts } = await import("./roles");
  if ((await hdCan(user, "tickets.view_all")) || (await hdCan(user, "settings.manage"))) return "all";
  return (await roleFacts(user)).teams;
}

/** Within the scope: the default, a mailbox with no team, or one of the agent's teams. */
export function mailboxInScope(m: { is_default: boolean; team_id: number | null }, scope: "all" | readonly number[]): boolean {
  return scope === "all" || m.is_default || m.team_id === null || scope.includes(m.team_id);
}

/**
 * What a ticket's "Answer from" offers this agent, and what the desk lists
 * for them (GET /api/helpdesk/mailboxes): the mailboxes in their scope,
 * short. `total` is how many are listed in all (the address is shown on a
 * ticket while there is more than one, whoever reads it).
 */
export async function mailboxOptionsFor(user: DeskUser): Promise<{ options: HdMailboxOption[]; total: number }> {
  const [boxes, scope] = await Promise.all([listMailboxes(), mailboxScope(user)]);
  return {
    options: boxes.filter((m) => mailboxInScope(m, scope)).map((m) => ({ id: m.id, address: m.address, name: m.name, is_default: m.is_default, send_from: m.send_from })),
    total: boxes.length,
  };
}

/** The mailboxes an agent may read and answer from, short (mailboxOptionsFor). */
export async function mailboxOptions(user: DeskUser): Promise<HdMailboxOption[]> {
  return (await mailboxOptionsFor(user)).options;
}

/** Team id -> the address of the first mailbox mapped to it (the Teams list's chip). */
export async function mailboxAddressByTeam(): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  for (const m of await listMailboxes()) if (m.team_id && !out.has(m.team_id)) out.set(m.team_id, m.address);
  return out;
}

/** Whether an address is one of ours (a listed mailbox, the 1.20.1 address, or any ticket reply address). */
export async function isOwnAddress(address: string): Promise<boolean> {
  const a = (address ?? "").trim().toLowerCase();
  if (!a) return false;
  const boxes: { address: string }[] = await listMailboxes();
  if (isOwnMailboxAddress(boxes, a)) return true;
  // No mailbox yet (or the old setting names another address): the old setting counts too.
  const legacy = legacyMailboxAddress((await getHelpdeskSettings()).inbound_address);
  return legacy ? isOwnMailboxAddress([{ address: legacy }], a) : false;
}

/** A matcher for many addresses at once (one read): lib/helpdesk/ccs asks it for every Cc of a mail. */
export async function ownAddressMatcher(): Promise<(address: string) => boolean> {
  const boxes: { address: string }[] = [...(await listMailboxes())];
  const legacy = legacyMailboxAddress((await getHelpdeskSettings()).inbound_address);
  if (legacy) boxes.push({ address: legacy });
  return (address: string) => isOwnMailboxAddress(boxes, address);
}

// --- Inbound: which address a mail was sent to ---------------------------------------

/**
 * The mailbox a new ticket from this email belongs to: the listed address
 * it was sent to, else the default. Null when no mailbox is listed.
 * `matched` says whether a recipient named it (false = the default stood in).
 */
export async function mailboxForInbound(email: MailboxRecipientSource): Promise<{ mailbox: HdMailbox; matched: boolean } | null> {
  const boxes = await listMailboxes();
  if (!boxes.length) return null;
  const hit = mailboxForRecipients(boxes, email);
  if (hit) return { mailbox: hit, matched: true };
  const def = boxes.find((m) => m.is_default) ?? boxes[0];
  return { mailbox: def, matched: false };
}

// --- Outbound: the identity a ticket's mail goes out under ---------------------------

export interface OutboundIdentity {
  /** The mailbox; null = the 1.20.1 settings stood in (none is listed). */
  mailboxId: number | null;
  /** The From name. */
  name: string;
  /** The address replies come back to (plus the ticket's token); '' = none set. */
  address: string;
  /** Send From `address` itself, not the workspace transport's address. */
  sendFrom: boolean;
  /** The last mail From `address` was refused (cleared by the next one accepted). */
  sendFromFailing?: boolean;
}

/**
 * Whose name and address a mail carries. `ticketId` given: the ticket's
 * mailbox (its own, else its team's, else the default). Without it (mail
 * not about a ticket, or an agent-only notice): the default mailbox's name
 * and address over the workspace's own From address, as before 1.20.2.
 */
export async function outboundIdentity(ticketId?: number | null): Promise<OutboundIdentity> {
  const boxes = await listMailboxes();
  if (!boxes.length) {
    const s = await getHelpdeskSettings();
    return { mailboxId: null, name: s.email_from_name, address: s.inbound_address, sendFrom: false };
  }
  if (ticketId) {
    const t = await hqOne<{ mailbox_id: number | null; team_id: number | null }>("SELECT mailbox_id, team_id FROM hd_tickets WHERE id = $1", [ticketId]);
    const m = mailboxForTicket(boxes, t ?? {})!;
    return { mailboxId: m.id, name: m.name, address: m.address, sendFrom: m.send_from, sendFromFailing: m.send_from_error !== "" };
  }
  const def = boxes.find((m) => m.is_default) ?? boxes[0];
  return { mailboxId: def.id, name: def.name, address: def.address, sendFrom: false };
}

/** The mailbox a ticket shows ("came in on" / "Answer from"): its own, else its team's, else the default. Null when none is listed. */
export async function ticketMailbox(ticket: { mailbox_id?: number | null; team_id?: number | null }): Promise<(HdTicketMailbox & { own: boolean }) | null> {
  const boxes = await listMailboxes();
  const m = mailboxForTicket(boxes, ticket);
  return m ? { id: m.id, address: m.address, name: m.name, own: m.id === ticket.mailbox_id } : null;
}

/**
 * Sending From a mailbox's address was refused and the mail went out from
 * the workspace address instead. Recorded on the mailbox; logged and
 * audited only when this starts a failure streak (the stored error was
 * empty), so a provider that refuses every mail writes one audit row.
 */
export async function recordSendFromFailure(mailboxId: number, error: string): Promise<boolean> {
  const text = error.replace(/\s+/g, " ").trim().slice(0, MAILBOX_LIMITS.error) || "The mail provider refused the address.";
  const first = await hqOne<{ address: string }>(
    "UPDATE hd_mailboxes SET send_from_error = $2, send_from_error_at = now() WHERE id = $1 AND send_from_error = '' RETURNING address",
    [mailboxId, text]
  );
  if (!first) return false;
  logEvent("warn", "helpdesk.mailbox_send_from_failed", { mailbox: mailboxId, address: first.address, error: text });
  await audit({
    actor: { name: "helpdesk email" },
    action: "helpdesk.mailbox.send_from_failed",
    targetType: "helpdesk_mailbox",
    targetId: mailboxId,
    targetLabel: first.address,
    details: { address: first.address, error: text, sent_from: "workspace address" },
  }).catch(() => {});
  return true;
}

/** A mail From the mailbox's address was accepted: the failure streak is over. */
export async function clearSendFromFailure(mailboxId: number): Promise<void> {
  await hq("UPDATE hd_mailboxes SET send_from_error = '', send_from_error_at = NULL WHERE id = $1 AND send_from_error <> ''", [mailboxId]);
}

// --- The 1.20.1 settings, kept in step ------------------------------------------------

/**
 * Write the default mailbox's address and name into the old settings (so a
 * rollback, and every old reader, sees them). Runs on the caller's
 * transaction, after its mailbox writes: the removal of the last address
 * and the cleared setting commit together (a crash in between would seed
 * the address back on the next start). The settings row is locked and only
 * these two keys are replaced in what is stored, so a settings save that
 * commits meanwhile (a rotated inbound secret, the hours) is never written
 * over with an older copy. Callers hold the mailbox rows FOR UPDATE, which
 * puts two changes of the default in order.
 */
async function mirrorDefaultToSettings(client: HdQueryable): Promise<void> {
  const boxes = await hq<{ address: string; name: string; is_default: boolean }>(`SELECT address, name, is_default FROM hd_mailboxes ${ORDER}`, [], client);
  const def = boxes.find((m) => m.is_default) ?? boxes[0];
  const read = async () => (await client.query<{ value: string }>("SELECT value FROM settings WHERE key = $1 FOR UPDATE", [HD_SETTINGS_KEY])).rows[0];
  let row = await read();
  if (!row) {
    if (!def) return;
    await client.query("INSERT INTO settings (key, value) VALUES ($1, '{}') ON CONFLICT (key) DO NOTHING", [HD_SETTINGS_KEY]);
    row = await read();
  }
  let stored: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(row?.value || "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) stored = parsed as Record<string, unknown>;
  } catch {
    stored = {};
  }
  const next: Record<string, unknown> = { ...stored, inbound_address: def ? def.address : "" };
  if (def) next.email_from_name = def.name || "Helpdesk";
  if (next.inbound_address === stored.inbound_address && next.email_from_name === stored.email_from_name) return;
  await client.query("UPDATE settings SET value = $2 WHERE key = $1", [HD_SETTINGS_KEY, JSON.stringify(next)]);
}

/**
 * The old settings were written (the settings API's inbound_address /
 * email_from_name, or a test): move the default mailbox to match. An
 * address that is already listed becomes the default; otherwise the
 * default's address changes (its tickets stay on it), or the first mailbox
 * is made. Clearing the address (empty once trimmed) removes the mailbox
 * only while it is the only one. A value that is not empty and not an
 * address changes nothing here: it never counts as "cleared" (the settings
 * API refuses it with 400 before it is stored). No audit of its own: the
 * settings write is audited.
 */
export async function syncDefaultMailboxFromSettings(next: { inbound_address: string; email_from_name: string }, changed: readonly string[]): Promise<void> {
  if (!changed.includes("inbound_address") && !changed.includes("email_from_name")) return;
  await mailboxesReady().catch(() => {});
  await withTx(async (client) => {
    const boxes = await hq<HdMailbox>(`SELECT ${COLS} FROM hd_mailboxes ${ORDER} FOR UPDATE`, [], client);
    const def = boxes.find((m) => m.is_default);
    const name = cleanMailboxName(next.email_from_name) || "Helpdesk";
    const typed = (next.inbound_address ?? "").trim();
    if (changed.includes("inbound_address") && !typed) {
      // Cleared: the only address goes with it; with several listed nothing is removed.
      if (def && boxes.length === 1) {
        await client.query("DELETE FROM hd_mailboxes WHERE id = $1", [def.id]);
        return;
      }
    } else if (changed.includes("inbound_address")) {
      const address = legacyMailboxAddress(typed);
      const listed = address ? matchMailbox(boxes, address) : undefined;
      if (!address) {
        // Not an address: no mailbox moves, and none is removed.
      } else if (listed && !listed.is_default) {
        await client.query("UPDATE hd_mailboxes SET is_default = false WHERE is_default");
        await client.query("UPDATE hd_mailboxes SET is_default = true, updated_at = now() WHERE id = $1", [listed.id]);
      } else if (!listed && def) {
        await client.query("UPDATE hd_mailboxes SET address = $2, send_from_error = '', send_from_error_at = NULL, updated_at = now() WHERE id = $1", [def.id, address]);
      } else if (!listed) {
        await client.query("INSERT INTO hd_mailboxes (address, name, is_default) VALUES ($1, $2, true) ON CONFLICT DO NOTHING", [address, name]);
        return;
      }
    }
    if (changed.includes("email_from_name")) {
      const target = (await hq<{ id: number }>("SELECT id FROM hd_mailboxes WHERE is_default", [], client))[0];
      if (target) await client.query("UPDATE hd_mailboxes SET name = $2, updated_at = now() WHERE id = $1", [target.id, name]);
    }
  });
}

// --- Writes (the Email settings page) --------------------------------------------------

export interface MailboxInput {
  address?: unknown;
  name?: unknown;
  team_id?: unknown;
  send_from?: unknown;
  is_default?: unknown;
}

interface CleanInput {
  address?: string;
  name?: string;
  team_id?: number | null;
  send_from?: boolean;
  is_default?: boolean;
}

/** Validate a create or edit body. Throws HdMailboxError with the sentence the form shows. */
export function validateMailboxInput(raw: MailboxInput, mode: "create" | "update"): CleanInput {
  const out: CleanInput = {};
  if (raw.address !== undefined || mode === "create") {
    if (typeof raw.address !== "string") throw new HdMailboxError("Enter the address people write to.");
    const problem = mailboxAddressProblem(raw.address);
    if (problem) throw new HdMailboxError(problem);
    out.address = cleanMailboxAddress(raw.address)!;
  }
  if (raw.name !== undefined || mode === "create") {
    if (raw.name !== undefined && typeof raw.name !== "string") throw new HdMailboxError("The name is text.");
    if (typeof raw.name === "string" && raw.name.trim().length > MAILBOX_LIMITS.name) throw new HdMailboxError(`Keep the name under ${MAILBOX_LIMITS.name} characters.`);
    const name = cleanMailboxName(raw.name ?? "");
    if (!name) throw new HdMailboxError("Give the address a name: it is who replies are from.");
    out.name = name;
  }
  if (raw.team_id !== undefined) {
    if (raw.team_id === null || raw.team_id === "") out.team_id = null;
    else {
      const n = Number(raw.team_id);
      if (!Number.isInteger(n) || n <= 0) throw new HdMailboxError("team_id must be a team's id or null.");
      out.team_id = n;
    }
  }
  for (const k of ["send_from", "is_default"] as const) {
    if (raw[k] === undefined) continue;
    if (typeof raw[k] !== "boolean") throw new HdMailboxError(`${k} is true or false.`);
    out[k] = raw[k] as boolean;
  }
  return out;
}

export interface MailboxActor {
  actor: AuditActor;
  ip?: string | null;
}

async function teamName(client: HdQueryable, id: number | null | undefined): Promise<string | null> {
  if (!id) return null;
  const t = (await hq<{ name: string }>("SELECT name FROM hd_teams WHERE id = $1", [id], client))[0];
  if (!t) throw new HdMailboxError("That team no longer exists.");
  return t.name;
}

const clash = (e: unknown) => (e as { code?: string }).code === "23505";

/** Add an address. The first one is the default whatever was asked. Audited (helpdesk.mailbox.created). */
export async function createMailbox(raw: MailboxInput, by: MailboxActor): Promise<HdMailbox> {
  const input = validateMailboxInput(raw, "create");
  await mailboxesReady();
  let team: string | null = null;
  let row: HdMailbox;
  try {
    row = await withTx(async (client) => {
      const boxes = await hq<{ id: number; address: string; is_default: boolean; position: number }>("SELECT id, address, is_default, position FROM hd_mailboxes ORDER BY position, id FOR UPDATE", [], client);
      if (boxes.length >= MAILBOX_LIMITS.mailboxes) throw new HdMailboxError(`Up to ${MAILBOX_LIMITS.mailboxes} addresses.`);
      if (matchMailbox(boxes, input.address!)) throw new HdMailboxError("That address is already listed.", 409);
      team = await teamName(client, input.team_id);
      const makeDefault = input.is_default === true || !boxes.some((b) => b.is_default);
      if (makeDefault) await client.query("UPDATE hd_mailboxes SET is_default = false WHERE is_default");
      const position = boxes.reduce((n, b) => Math.max(n, b.position), -1) + 1;
      const made = (
        await hq<HdMailbox>(
          `INSERT INTO hd_mailboxes (address, name, team_id, send_from, is_default, position)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${COLS}`,
          [input.address, input.name, input.team_id ?? null, input.send_from === true, makeDefault, position],
          client
        )
      )[0];
      await mirrorDefaultToSettings(client);
      return made;
    });
  } catch (e) {
    if (clash(e)) throw new HdMailboxError("That address is already listed.", 409);
    throw e;
  }
  await audit({
    actor: by.actor,
    action: "helpdesk.mailbox.created",
    targetType: "helpdesk_mailbox",
    targetId: row.id,
    targetLabel: row.address,
    details: { address: row.address, name: row.name, team: team ?? "No team (use routing)", send_from: row.send_from, is_default: row.is_default },
    ip: by.ip ?? null,
  });
  return row;
}

/**
 * Edit an address. Making it the default takes the default from the other;
 * the default can't be switched off here (make another one the default).
 * Audited (helpdesk.mailbox.updated, the changed fields from → to).
 */
export async function updateMailbox(id: number, raw: MailboxInput, by: MailboxActor): Promise<HdMailbox | undefined> {
  const input = validateMailboxInput(raw, "update");
  await mailboxesReady();
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  let row: HdMailbox | undefined;
  try {
    row = await withTx(async (client) => {
      const boxes = await hq<HdMailbox>(`SELECT ${COLS} FROM hd_mailboxes ${ORDER} FOR UPDATE`, [], client);
      const before = boxes.find((b) => b.id === id);
      if (!before) return undefined;
      const sets: string[] = [];
      const params: unknown[] = [id];
      const set = (col: string, v: unknown) => {
        params.push(v);
        sets.push(`${col} = $${params.length}`);
      };
      if (input.address !== undefined && input.address !== before.address) {
        const other = matchMailbox(boxes.filter((b) => b.id !== id), input.address);
        if (other) throw new HdMailboxError("That address is already listed.", 409);
        set("address", input.address);
        changes.address = { from: before.address, to: input.address };
      }
      if (input.name !== undefined && input.name !== before.name) {
        set("name", input.name);
        changes.name = { from: before.name, to: input.name };
      }
      if (input.team_id !== undefined && input.team_id !== before.team_id) {
        const to = await teamName(client, input.team_id);
        const from = before.team_id ? ((await hq<{ name: string }>("SELECT name FROM hd_teams WHERE id = $1", [before.team_id], client))[0]?.name ?? null) : null;
        set("team_id", input.team_id);
        changes.team = { from: from ?? "No team (use routing)", to: to ?? "No team (use routing)" };
      }
      if (input.send_from !== undefined && input.send_from !== before.send_from) {
        set("send_from", input.send_from);
        changes.send_from = { from: before.send_from, to: input.send_from };
      }
      if (input.is_default !== undefined && input.is_default !== before.is_default) {
        if (!input.is_default) throw new HdMailboxError("Make another address the default instead: one address is always the default.");
        await client.query("UPDATE hd_mailboxes SET is_default = false WHERE is_default");
        set("is_default", true);
        changes.is_default = { from: false, to: true };
      }
      if (!sets.length) return before;
      // A changed address or sending choice starts with a clean slate.
      if (changes.address || changes.send_from) sets.push("send_from_error = ''", "send_from_error_at = NULL");
      sets.push("updated_at = now()");
      const saved = (await hq<HdMailbox>(`UPDATE hd_mailboxes SET ${sets.join(", ")} WHERE id = $1 RETURNING ${COLS}`, params, client))[0];
      await mirrorDefaultToSettings(client);
      return saved;
    });
  } catch (e) {
    if (clash(e)) throw new HdMailboxError("That address is already listed.", 409);
    throw e;
  }
  if (!row) return undefined;
  if (Object.keys(changes).length) {
    await audit({
      actor: by.actor,
      action: "helpdesk.mailbox.updated",
      targetType: "helpdesk_mailbox",
      targetId: row.id,
      targetLabel: row.address,
      details: { changes },
      ip: by.ip ?? null,
    });
  }
  return row;
}

/** How many tickets carry the mailbox (the remove dialog's count). */
export async function mailboxTicketCount(id: number): Promise<number> {
  return (await hqOne<{ n: number }>("SELECT count(*)::int AS n FROM hd_tickets WHERE mailbox_id = $1", [id]))?.n ?? 0;
}

/**
 * Remove an address. Its tickets move to the default (when the default
 * itself goes, the next address in the list becomes the default first).
 * The last address can always be removed: the desk then has none, as before
 * one was set. Audited (helpdesk.mailbox.deleted, with the tickets moved).
 */
export async function deleteMailbox(id: number, by: MailboxActor): Promise<{ mailbox: HdMailbox; moved: number; moved_to: HdMailbox | null } | undefined> {
  await mailboxesReady();
  const out = await withTx(async (client) => {
    const boxes = await hq<HdMailbox>(`SELECT ${COLS} FROM hd_mailboxes ${ORDER} FOR UPDATE`, [], client);
    const gone = boxes.find((b) => b.id === id);
    if (!gone) return undefined;
    const rest = boxes.filter((b) => b.id !== id);
    let heir: HdMailbox | null = rest.find((b) => b.is_default) ?? null;
    if (!heir && rest.length) {
      heir = rest[0];
      await client.query("UPDATE hd_mailboxes SET is_default = false WHERE is_default");
      await client.query("UPDATE hd_mailboxes SET is_default = true, updated_at = now() WHERE id = $1", [heir.id]);
      heir = { ...heir, is_default: true };
    }
    const moved = (await client.query("UPDATE hd_tickets SET mailbox_id = $2 WHERE mailbox_id = $1", [id, heir?.id ?? null])).rowCount ?? 0;
    await client.query("DELETE FROM hd_mailboxes WHERE id = $1", [id]);
    await mirrorDefaultToSettings(client);
    return { mailbox: gone, moved, moved_to: heir };
  });
  if (!out) return undefined;
  await audit({
    actor: by.actor,
    action: "helpdesk.mailbox.deleted",
    targetType: "helpdesk_mailbox",
    targetId: out.mailbox.id,
    targetLabel: out.mailbox.address,
    details: { address: out.mailbox.address, tickets_moved: out.moved, moved_to: out.moved_to?.address ?? null, was_default: out.mailbox.is_default },
    ip: by.ip ?? null,
  });
  return out;
}

// --- A ticket's "Answer from" ----------------------------------------------------------

/**
 * Change the address a ticket is answered from. Null = work it out again
 * (the team's mailbox, else the default). Answers the change for the
 * caller's audit and timeline, or null when nothing changed. Throws
 * HdMailboxError(400) for an unknown mailbox.
 */
export async function setTicketMailbox(ticketId: number, mailboxId: number | null): Promise<{ from: HdTicketMailbox | null; to: HdTicketMailbox | null } | null> {
  const boxes = await listMailboxes();
  const short = (m: HdMailbox | undefined): HdTicketMailbox | null => (m ? { id: m.id, address: m.address, name: m.name } : null);
  const next = mailboxId === null ? undefined : boxes.find((m) => m.id === mailboxId);
  if (mailboxId !== null && !next) throw new HdMailboxError("That address is no longer listed.");
  const before = await hqOne<{ mailbox_id: number | null; team_id: number | null }>("SELECT mailbox_id, team_id FROM hd_tickets WHERE id = $1", [ticketId]);
  if (!before) return null;
  if ((before.mailbox_id ?? null) === mailboxId) return null;
  const was = mailboxForTicket(boxes, before);
  await hq("UPDATE hd_tickets SET mailbox_id = $2, updated_at = now() WHERE id = $1", [ticketId, mailboxId]);
  const now = mailboxId === null ? mailboxForTicket(boxes, { team_id: before.team_id }) : next;
  // The same address either way (the default made explicit): stored, but nothing to tell.
  if (was?.id === now?.id) return null;
  return { from: short(was), to: short(now) };
}

type AnswerFromUser = { id: number; name?: string; username?: string; role: import("../types").Role };
type AnswerFromTicket = { id: number; number: number; subject: string; team_id: number | null; merged_into?: number | null };
type AnswerFromRefusal = { error: string; status: number };

/**
 * The ticket PATCH's `mailbox_id` (the side panel's "Answer from"), checked
 * and nothing written: the agent needs tickets.reply_public in the ticket's
 * team (who may answer the requester may choose the address it is from); a
 * merged ticket is read-only; and the address must be one they may answer
 * from (mailboxScope: the default, one with no team, or one of their
 * teams', any with tickets.view_all). Answers { error, status } for a
 * refusal, else the mailbox id to store (null = work it out again).
 */
export async function checkAnswerFrom(user: AnswerFromUser, ticket: AnswerFromTicket, raw: unknown): Promise<AnswerFromRefusal | { id: number | null }> {
  let id: number | null = null;
  if (raw !== null) {
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0) return { error: "mailbox_id must be an address's id or null.", status: 400 };
    id = n;
  }
  const { hdCan, HD_FORBIDDEN } = await import("./roles");
  if (!(await hdCan(user, "tickets.reply_public", { teamId: ticket.team_id }))) return { error: HD_FORBIDDEN, status: 403 };
  if (ticket.merged_into) return { error: `#${ticket.number} was merged into another ticket. Change the address on that one.`, status: 409 };
  if (id !== null) {
    const box = (await listMailboxes()).find((m) => m.id === id);
    if (!box) return { error: "That address is no longer listed.", status: 400 };
    if (!mailboxInScope(box, await mailboxScope(user))) {
      return { error: "That address belongs to another team. Answer from one of your own teams' addresses, or the default.", status: 403 };
    }
  }
  return { id };
}

/**
 * Store what checkAnswerFrom allowed. Leaves an agents-only timeline line
 * and an audit row (helpdesk.ticket.mailbox_changed). The ticket PATCH
 * calls it last, once every other check has passed and the other fields
 * are saved, so a refused request changes nothing. Answers whether anything
 * changed ({ error, status } only when the address was removed meanwhile).
 */
export async function applyAnswerFrom(
  user: AnswerFromUser,
  ticket: AnswerFromTicket,
  id: number | null,
  opts: { ip?: string | null } = {}
): Promise<AnswerFromRefusal | { changed: boolean }> {
  let change: Awaited<ReturnType<typeof setTicketMailbox>>;
  try {
    change = await setTicketMailbox(ticket.id, id);
  } catch (e) {
    if (e instanceof HdMailboxError) return { error: e.message, status: e.status };
    throw e;
  }
  if (!change) return { changed: false };
  const who = user.name || user.username || "Someone";
  const { addSystemMessage } = await import("./messages");
  const { mdInline } = await import("./md-inline");
  await addSystemMessage(
    ticket.id,
    `${mdInline(who)} changed the address this ticket is answered from: ${mdInline(change.from?.address ?? "none")} to ${mdInline(change.to?.address ?? "none")}`,
    { internal: true }
  );
  await audit({
    actor: { id: user.id, name: who, role: user.role },
    action: "helpdesk.ticket.mailbox_changed",
    targetType: "helpdesk_ticket",
    targetId: ticket.id,
    targetLabel: `#${ticket.number} ${ticket.subject}`.slice(0, 200),
    details: { number: ticket.number, from: change.from?.address ?? null, to: change.to?.address ?? null },
    ip: opts.ip ?? null,
  });
  return { changed: true };
}

/** checkAnswerFrom, then applyAnswerFrom: a change of the address alone. */
export async function changeAnswerFrom(
  user: AnswerFromUser,
  ticket: AnswerFromTicket,
  raw: unknown,
  opts: { ip?: string | null } = {}
): Promise<AnswerFromRefusal | { changed: boolean }> {
  const checked = await checkAnswerFrom(user, ticket, raw);
  if ("error" in checked) return checked;
  return applyAnswerFrom(user, ticket, checked.id, opts);
}
