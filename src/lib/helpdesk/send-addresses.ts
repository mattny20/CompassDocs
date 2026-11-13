// Helpdesk 1.20.5: send-from addresses. The list an admin keeps (Desk
// settings → Email) of addresses replies may go out From, and the pick each
// help address makes from it (hd_mailboxes.send_address_id; none = the
// workspace address). Schema: lib/helpdesk/mailboxes-schema; shapes and the
// address rules: lib/helpdesk/mailboxes-shared. Server-only.
//
//   - Mail still goes out through the one workspace mail server
//     (lib/smtp-config, Settings → Notifications → Email). A send-from
//     address is only the From of the mail: the mail provider must allow it
//     (a verified sender or domain). Reply-To stays the help address plus
//     the ticket's token, so answers come back into the desk whatever the
//     From is (lib/helpdesk/email).
//   - A refusal of the From by the provider sends the same mail from the
//     workspace address and is recorded here, on the send-from address
//     (last_error): logged and audited once per failure streak, cleared by
//     the next mail the provider accepts from it.
//   - Upgrade: up to 1.20.4 a help address had a switch, send_from ("replies
//     go out From this address"). Every help address with it on gets a
//     send-from address equal to its own address and picks it
//     (adoptLegacySendFrom, once per process and idempotent: the address is
//     unique). From then on hd_mailboxes.send_from is a mirror, true exactly
//     when the pick is the help address itself, and send_from_error(_at)
//     carry that pick's last_error(_at) (mirrorSendFrom, in the transaction
//     that changes either side), so a 1.20.4 binary on the same database
//     keeps sending as before. A disagreement between the old column and
//     the pick can then only come from a 1.20.4 binary's write: every write
//     here and in lib/helpdesk/mailboxes adopts it first, so that write is
//     not undone by the next mirror.
//
// Send-from addresses are the workspace's configuration, not personal data:
// retention, anonymise and the personal data export leave them alone.

import "server-only";
import { audit } from "../audit";
import type { AuditActor } from "../audit";
import { logEvent } from "../log";
import { hq, hqOne, withTx } from "./db-core";
import type { HdQueryable } from "./db-core";
import { MAILBOX_LIMITS, SEND_ADDRESS_LIMITS, cleanMailboxAddress, cleanMailboxName, sendAddressProblem } from "./mailboxes-shared";
import type { HdSendAddress, HdSendAddressView } from "./mailboxes-shared";

export type { HdSendAddress, HdSendAddressView } from "./mailboxes-shared";

const COLS = "id, address, name, last_error, last_error_at, created_at, updated_at";
const ORDER = "ORDER BY lower(address), id";

/** What the audit log and the page call "no send-from address picked". */
export const WORKSPACE_ADDRESS_LABEL = "The workspace address";

export class HdSendAddressError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

// --- On a caller's transaction (lib/helpdesk/mailboxes calls these too) ---------------

/**
 * Lock the help addresses, then the send-from addresses, in that order
 * (every writer of either takes them the same way, so two never deadlock).
 */
export async function lockSendAddresses(client: HdQueryable): Promise<void> {
  await client.query("SELECT id FROM hd_mailboxes ORDER BY position, id FOR UPDATE");
  await client.query("SELECT id FROM hd_send_addresses ORDER BY id FOR UPDATE");
}

/**
 * The id of the send-from address for `address`, made when it is not listed
 * yet (with no name of its own, so the help address's name stays the From
 * name). Not counted against SEND_ADDRESS_LIMITS: the upgrade and the old
 * `send_from: true` write must never fail on it. `carry` hands a refusal
 * recorded on the help address by 1.20.4 to an address made here.
 */
export async function ensureSendAddress(client: HdQueryable, address: string, carry?: { error: string; at: string | null }): Promise<number> {
  const clean = cleanMailboxAddress(address);
  if (!clean) throw new HdSendAddressError("That is not an email address.");
  const made = await hq<{ id: number }>(
    `INSERT INTO hd_send_addresses (address, last_error, last_error_at) VALUES ($1, $2, $3)
     ON CONFLICT (lower(address)) DO NOTHING RETURNING id`,
    [clean, carry?.error ?? "", carry?.error ? carry.at : null],
    client
  );
  if (made[0]) return made[0].id;
  return (await hq<{ id: number }>("SELECT id FROM hd_send_addresses WHERE lower(address) = $1", [clean], client))[0].id;
}

const OWN = "(s.id IS NOT NULL AND lower(s.address) = lower(m.address))";

/**
 * Take over what the old column says where it disagrees with the pick: the
 * upgrade from 1.20.4 (send_from on, nothing picked yet), and any later
 * write by a 1.20.4 binary on the same database. send_from on: the help
 * address picks the send-from address equal to itself, made when missing.
 * send_from off while the pick is the address itself: back to the workspace
 * address. Idempotent. Answers how many help addresses it moved.
 */
export async function adoptLegacySendFrom(client: HdQueryable): Promise<number> {
  const rows = await hq<{ id: number; address: string; send_from: boolean; send_from_error: string; send_from_error_at: string | null }>(
    `SELECT m.id, m.address, m.send_from, m.send_from_error, m.send_from_error_at
       FROM hd_mailboxes m LEFT JOIN hd_send_addresses s ON s.id = m.send_address_id
      WHERE m.send_from IS DISTINCT FROM ${OWN}
      ORDER BY m.position, m.id
        FOR UPDATE OF m`,
    [],
    client
  );
  let moved = 0;
  for (const m of rows) {
    if (!m.send_from) {
      await client.query("UPDATE hd_mailboxes SET send_address_id = NULL WHERE id = $1", [m.id]);
      moved++;
    } else if (cleanMailboxAddress(m.address)) {
      const id = await ensureSendAddress(client, m.address, { error: m.send_from_error, at: m.send_from_error_at });
      await client.query("UPDATE hd_mailboxes SET send_address_id = $2 WHERE id = $1", [m.id, id]);
      moved++;
    }
  }
  return moved;
}

/**
 * Write the 1.20.2 columns from the pick: send_from true exactly when the
 * picked send-from address is the help address itself, and then its
 * last_error(_at) as send_from_error(_at) ('' and NULL otherwise). One
 * statement that touches only rows that differ. Run it last in every
 * transaction that changes a pick, a help address's address or a send-from
 * address; a refusal recorded or cleared runs it on its own.
 */
export async function mirrorSendFrom(client?: HdQueryable): Promise<void> {
  await hq(
    `UPDATE hd_mailboxes t
        SET send_from = x.own,
            send_from_error = CASE WHEN x.own THEN x.err ELSE '' END,
            send_from_error_at = CASE WHEN x.own THEN x.err_at END
       FROM (SELECT m.id, ${OWN} AS own, COALESCE(s.last_error, '') AS err, s.last_error_at AS err_at
               FROM hd_mailboxes m LEFT JOIN hd_send_addresses s ON s.id = m.send_address_id) x
      WHERE x.id = t.id
        AND (t.send_from IS DISTINCT FROM x.own
             OR t.send_from_error IS DISTINCT FROM (CASE WHEN x.own THEN x.err ELSE '' END)
             OR t.send_from_error_at IS DISTINCT FROM (CASE WHEN x.own THEN x.err_at END))`,
    [],
    client
  );
}

// --- Upgrade ---------------------------------------------------------------------------

let readyPromise: Promise<void> | null = null;

/**
 * The upgrade from the send_from switch, once per process (a failure is
 * retried on the next call). lib/helpdesk/mailboxes mailboxesReady() waits
 * for it, so every read of a help address sees its pick.
 */
export function sendAddressesReady(): Promise<void> {
  if (!readyPromise) {
    readyPromise = (async () => {
      // Nothing to adopt (every start but the first): no lock is taken.
      const due = await hq(`SELECT 1 FROM hd_mailboxes m LEFT JOIN hd_send_addresses s ON s.id = m.send_address_id WHERE m.send_from IS DISTINCT FROM ${OWN} LIMIT 1`);
      if (!due.length) return;
      const moved = await withTx(async (client) => {
        await lockSendAddresses(client);
        const n = await adoptLegacySendFrom(client);
        await mirrorSendFrom(client);
        return n;
      });
      if (moved) logEvent("info", "helpdesk.send_addresses_adopted", { mailboxes: moved });
    })().catch((e) => {
      readyPromise = null;
      throw e;
    });
  }
  return readyPromise;
}

/** Tests: run the upgrade again on the next read. */
export function resetSendAddressesReadyForTests(): void {
  readyPromise = null;
}

// --- Reads -----------------------------------------------------------------------------

/** Every send-from address, by address. With `client` the read stays on it. */
export async function listSendAddresses(client?: HdQueryable): Promise<HdSendAddress[]> {
  if (!client) await sendAddressesReady();
  return hq<HdSendAddress>(`SELECT ${COLS} FROM hd_send_addresses ${ORDER}`, [], client);
}

export async function getSendAddress(id: number, client?: HdQueryable): Promise<HdSendAddress | undefined> {
  if (!client) await sendAddressesReady();
  return hqOne<HdSendAddress>(`SELECT ${COLS} FROM hd_send_addresses WHERE id = $1`, [id], client);
}

/** The Email settings page's list: each send-from address with the help addresses that picked it. */
export async function sendAddressViews(): Promise<HdSendAddressView[]> {
  await sendAddressesReady();
  return hq<HdSendAddressView>(
    `SELECT ${COLS.split(", ").map((c) => `s.${c}`).join(", ")},
            COALESCE((SELECT json_agg(json_build_object('id', m.id, 'address', m.address) ORDER BY m.position, m.id)
                        FROM hd_mailboxes m WHERE m.send_address_id = s.id), '[]'::json) AS used_by
       FROM hd_send_addresses s
      ORDER BY lower(s.address), s.id`
  );
}

// --- A refusal by the mail provider ----------------------------------------------------

/**
 * Sending From a send-from address was refused and the mail went out from
 * the workspace address instead. Recorded on the address; logged and
 * audited only when this starts a failure streak (the stored refusal was
 * empty), so a provider that refuses every mail writes one audit row
 * however many help addresses send from it. `helpAddress` is the help
 * address whose mail was refused (none for a test of the address alone).
 */
export async function recordSendAddressFailure(id: number, error: string, helpAddress?: string | null): Promise<boolean> {
  const text = error.replace(/\s+/g, " ").trim().slice(0, MAILBOX_LIMITS.error) || "The mail provider refused the address.";
  const first = await hqOne<{ address: string }>(
    "UPDATE hd_send_addresses SET last_error = $2, last_error_at = now() WHERE id = $1 AND last_error = '' RETURNING address",
    [id, text]
  );
  if (!first) return false;
  await mirrorSendFrom().catch(() => {});
  logEvent("warn", "helpdesk.send_address_refused", { send_address: id, address: first.address, error: text });
  await audit({
    actor: { name: "helpdesk email" },
    action: "helpdesk.send_address.refused",
    targetType: "helpdesk_send_address",
    targetId: id,
    targetLabel: first.address,
    details: { address: first.address, error: text, sent_from: "workspace address", ...(helpAddress ? { help_address: helpAddress } : {}) },
  }).catch(() => {});
  return true;
}

/** A mail From the send-from address was accepted: the failure streak is over. */
export async function clearSendAddressFailure(id: number): Promise<void> {
  const cleared = await hq("UPDATE hd_send_addresses SET last_error = '', last_error_at = NULL WHERE id = $1 AND last_error <> '' RETURNING id", [id]);
  if (cleared.length) await mirrorSendFrom().catch(() => {});
}

// --- Writes (the Email settings page) --------------------------------------------------

export interface SendAddressInput {
  address?: unknown;
  name?: unknown;
}

interface CleanInput {
  address?: string;
  name?: string;
}

/** Validate a create or edit body. Throws HdSendAddressError with the sentence the form shows. */
export function validateSendAddressInput(raw: SendAddressInput, mode: "create" | "update"): CleanInput {
  const out: CleanInput = {};
  if (raw.address !== undefined || mode === "create") {
    if (typeof raw.address !== "string") throw new HdSendAddressError("Enter the address to send from.");
    const problem = sendAddressProblem(raw.address);
    if (problem) throw new HdSendAddressError(problem);
    out.address = cleanMailboxAddress(raw.address)!;
  }
  if (raw.name !== undefined) {
    // Optional: null or '' = the help address's name.
    if (raw.name !== null && typeof raw.name !== "string") throw new HdSendAddressError("The name is text.");
    if (typeof raw.name === "string" && raw.name.trim().length > MAILBOX_LIMITS.name) throw new HdSendAddressError(`Keep the name under ${MAILBOX_LIMITS.name} characters.`);
    out.name = cleanMailboxName(raw.name ?? "");
  }
  return out;
}

export interface SendAddressActor {
  actor: AuditActor;
  ip?: string | null;
}

const clash = (e: unknown) => (e as { code?: string }).code === "23505";
const LISTED = "That address is already on the list.";
const nameOrNone = (name: string) => name || "None (the help address's name)";

/** Add a send-from address. Audited (helpdesk.send_address.created). */
export async function createSendAddress(raw: SendAddressInput, by: SendAddressActor): Promise<HdSendAddress> {
  const input = validateSendAddressInput(raw, "create");
  await sendAddressesReady();
  let row: HdSendAddress;
  try {
    row = await withTx(async (client) => {
      await lockSendAddresses(client);
      const all = await hq<{ address: string }>("SELECT address FROM hd_send_addresses", [], client);
      if (all.some((s) => s.address.toLowerCase() === input.address)) throw new HdSendAddressError(LISTED, 409);
      if (all.length >= SEND_ADDRESS_LIMITS.addresses) throw new HdSendAddressError(`Up to ${SEND_ADDRESS_LIMITS.addresses} send-from addresses. Remove one you no longer use first.`);
      return (await hq<HdSendAddress>(`INSERT INTO hd_send_addresses (address, name) VALUES ($1, $2) RETURNING ${COLS}`, [input.address, input.name ?? ""], client))[0];
    });
  } catch (e) {
    if (clash(e)) throw new HdSendAddressError(LISTED, 409);
    throw e;
  }
  await audit({
    actor: by.actor,
    action: "helpdesk.send_address.created",
    targetType: "helpdesk_send_address",
    targetId: row.id,
    targetLabel: row.address,
    details: { address: row.address, name: nameOrNone(row.name) },
    ip: by.ip ?? null,
  });
  return row;
}

/**
 * Edit a send-from address. The help addresses that picked it keep it; a
 * changed address starts with no refusal held against it. Audited
 * (helpdesk.send_address.updated, the changed fields from → to).
 */
export async function updateSendAddress(id: number, raw: SendAddressInput, by: SendAddressActor): Promise<HdSendAddress | undefined> {
  const input = validateSendAddressInput(raw, "update");
  await sendAddressesReady();
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  let row: HdSendAddress | undefined;
  try {
    row = await withTx(async (client) => {
      await lockSendAddresses(client);
      await adoptLegacySendFrom(client);
      const before = await getSendAddress(id, client);
      if (!before) return undefined;
      const sets: string[] = [];
      const params: unknown[] = [id];
      const set = (col: string, v: unknown) => {
        params.push(v);
        sets.push(`${col} = $${params.length}`);
      };
      if (input.address !== undefined && input.address !== before.address) {
        const other = await hqOne("SELECT 1 FROM hd_send_addresses WHERE lower(address) = $1 AND id <> $2", [input.address, id], client);
        if (other) throw new HdSendAddressError(LISTED, 409);
        set("address", input.address);
        sets.push("last_error = ''", "last_error_at = NULL");
        changes.address = { from: before.address, to: input.address };
      }
      if (input.name !== undefined && input.name !== before.name) {
        set("name", input.name);
        changes.name = { from: nameOrNone(before.name), to: nameOrNone(input.name) };
      }
      if (!sets.length) return before;
      sets.push("updated_at = now()");
      const saved = (await hq<HdSendAddress>(`UPDATE hd_send_addresses SET ${sets.join(", ")} WHERE id = $1 RETURNING ${COLS}`, params, client))[0];
      await mirrorSendFrom(client);
      return saved;
    });
  } catch (e) {
    if (clash(e)) throw new HdSendAddressError(LISTED, 409);
    throw e;
  }
  if (!row) return undefined;
  if (Object.keys(changes).length) {
    await audit({
      actor: by.actor,
      action: "helpdesk.send_address.updated",
      targetType: "helpdesk_send_address",
      targetId: row.id,
      targetLabel: row.address,
      details: { changes },
      ip: by.ip ?? null,
    });
  }
  return row;
}

/**
 * Remove a send-from address. The help addresses that picked it go back to
 * the workspace address (the page asks first and names them). Audited
 * (helpdesk.send_address.deleted, with those help addresses).
 */
export async function deleteSendAddress(id: number, by: SendAddressActor): Promise<{ send_address: HdSendAddress; released: { id: number; address: string }[] } | undefined> {
  await sendAddressesReady();
  const out = await withTx(async (client) => {
    await lockSendAddresses(client);
    await adoptLegacySendFrom(client);
    const gone = await getSendAddress(id, client);
    if (!gone) return undefined;
    const released = await hq<{ id: number; address: string }>(
      `WITH freed AS (UPDATE hd_mailboxes SET send_address_id = NULL, updated_at = now() WHERE send_address_id = $1 RETURNING id, address, position)
       SELECT id, address FROM freed ORDER BY position, id`,
      [id],
      client
    );
    await client.query("DELETE FROM hd_send_addresses WHERE id = $1", [id]);
    await mirrorSendFrom(client);
    return { send_address: gone, released };
  });
  if (!out) return undefined;
  await audit({
    actor: by.actor,
    action: "helpdesk.send_address.deleted",
    targetType: "helpdesk_send_address",
    targetId: out.send_address.id,
    targetLabel: out.send_address.address,
    details: {
      address: out.send_address.address,
      help_addresses: out.released.map((m) => m.address),
      ...(out.released.length ? { they_now_send_from: WORKSPACE_ADDRESS_LABEL } : {}),
    },
    ip: by.ip ?? null,
  });
  return out;
}
