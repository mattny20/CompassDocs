// Helpdesk 1.19.1: where the customer portal (agent V6, lib/helpdesk/portal)
// meets the 1.19.0 paths. Each is one call from a shared module:
//
//   portalRequesterNotice   lib/helpdesk/notify toRequester: a portal
//                           ticket's requester notices go to the contact by
//                           email only (no bell: they have no account, and
//                           no notification preferences to consult), with
//                           a sign-in link back to the request in the
//                           portal, agents named by first name. A blocked
//                           contact hears nothing. Request received, a
//                           reply (and "waiting on you"), solved, and a
//                           workflow's message to the requester, and "your
//                           request was joined with #N" (hd_merged, linking
//                           to the kept request); nothing else (approvals
//                           are the workspace's business). Only while the
//                           portal is open and the address passes its
//                           access rule and blocked domains: otherwise the
//                           ordinary requester email applies. A ticket a
//                           portal ticket was merged into, whose requester
//                           is that contact, is mailed the same way.
//   portalReplyAuthority    lib/helpdesk/inbound: an emailed reply from a
//                           portal contact threads into their own portal
//                           ticket even when Outside senders is off. The
//                           portal implies allowing its own contacts on
//                           their own tickets, nothing more: the sender
//                           check (DMARC/SPF/DKIM verdict, agent S2) still
//                           decides first, an address that belongs to a
//                           workspace account never takes this path, a
//                           blocked contact (by mailbox) is refused, and new
//                           tickets by email from contacts still follow
//                           Outside senders. It also covers the tickets a
//                           contact's ticket was merged into, and a closed
//                           portal ticket's follow-up opens as a portal
//                           ticket of the contact (createPortalFollowUp).
//                           Only while the portal is open and the address
//                           passes its rules; otherwise null.
//
// Server-only.

import "server-only";
import { hqOne, withTx } from "./db-core";
import { emailAllowed, firstName, PORTAL_PATH } from "./portal-shared";

/** The requester templates a portal contact receives. */
const PORTAL_TEMPLATES = new Set(["hd_request_received", "hd_reply", "hd_solved_csat", "hd_workflow_notify", "hd_merged"]);

interface ContactRow {
  id: number;
  email: string;
  blocked: number;
}

/**
 * The portal contact who counts for a ticket: its own contact, or (a
 * ticket portal tickets were merged into, with no contact of its own) the
 * contact of a ticket merged into it whose address is this ticket's
 * requester address. Undefined when none.
 */
async function contactForTicket(t: { id: number; portal_contact_id: number | null; requester_email: string }): Promise<ContactRow | undefined> {
  if (t.portal_contact_id) return hqOne<ContactRow>("SELECT id, email, blocked FROM hd_portal_contacts WHERE id = $1", [t.portal_contact_id]);
  if (!t.requester_email) return undefined;
  const { contactReachSql } = await import("./portal");
  return hqOne<ContactRow>(
    `SELECT c.id, c.email, c.blocked FROM hd_portal_contacts c
      WHERE lower(c.email) = lower($2)
        AND EXISTS (SELECT 1 FROM hd_tickets m WHERE m.merged_into IS NOT NULL AND m.portal_contact_id = c.id)
        AND $1::int IN ${contactReachSql("c.id")}
      LIMIT 1`,
    [t.id, t.requester_email]
  );
}

/** The portal is open and admits this address (access rule, blocked domains). */
async function portalAdmits(email: string): Promise<boolean> {
  const { getPortalSettings, portalOpen } = await import("./portal");
  const settings = await getPortalSettings();
  return (await portalOpen(settings)) && emailAllowed(email, settings);
}

/** Blocked itself, or another address of the same mailbox is. */
async function contactBlocked(c: ContactRow): Promise<boolean> {
  if (c.blocked) return true;
  const { isBlockedPortalMailbox } = await import("./portal");
  return isBlockedPortalMailbox(c.email);
}

/**
 * A requester notice on a portal ticket. Answers true when the ticket is a
 * portal ticket (the notice was handled here, sent or deliberately not),
 * false when the caller should carry on as before (not a portal ticket, or
 * the portal is off or no longer admits the address: the ordinary
 * requester email then applies).
 */
export async function portalRequesterNotice(
  ticketId: number,
  template: string,
  vars: Record<string, string>,
  origin?: string
): Promise<boolean> {
  const t = await hqOne<{ id: number; number: number; team_id: number | null; portal_contact_id: number | null; requester_email: string }>(
    "SELECT id, number, team_id, portal_contact_id, requester_email FROM hd_tickets WHERE id = $1",
    [ticketId]
  );
  if (!t) return false;
  const c = await contactForTicket(t);
  if (!c) return false;
  // A blocked contact hears nothing, by the portal or otherwise.
  if (await contactBlocked(c)) return true;
  if (!(await portalAdmits(c.email))) return false;
  if (!PORTAL_TEMPLATES.has(template)) return true;
  const { getPortalSettings, portalBrand, portalLinkOrigin } = await import("./portal");
  const brand = await portalBrand(await getPortalSettings());
  const base = await portalLinkOrigin(origin ?? "");
  // "Joined with #N" links to the kept request, which the contact now reaches.
  const target = template === "hd_merged" && /^\d{1,10}$/.test(vars.target_number ?? "") ? vars.target_number : String(t.number);
  const out: Record<string, string> = {
    ...vars,
    org_name: brand.name,
    // Opening it signs in first when the browser has no portal session, then lands here.
    ticket_url: `${base}${PORTAL_PATH}/requests/${target}`,
  };
  if (out.author_name) out.author_name = firstName(out.author_name) || "Support";
  if (out.agent_name) out.agent_name = firstName(out.agent_name) || "Support";
  const { sendHelpdeskTemplate } = await import("./email");
  await sendHelpdeskTemplate(c.email, template, out, { ticketId: t.id, number: t.number, teamId: t.team_id }, base || origin);
  return true;
}

export interface PortalAuthority {
  /** The contact writes as the requester (or, on a ticket theirs was merged into, as a CC does). */
  allowed: boolean;
  /** The sender is a blocked portal contact (by mailbox): refused as anyone on the ticket. */
  blocked: boolean;
  /** The contact, when allowed: a closed ticket's follow-up is opened for them. */
  contactId: number | null;
}

const NOT_ALLOWED: PortalAuthority = { allowed: false, blocked: false, contactId: null };

/**
 * May an (authenticated, account-less) sender write into this ticket as
 * its requester? Null when no portal ticket or contact is involved, or the
 * portal is off or does not admit the address (the caller's own rules
 * apply). Allowed for the contact of `ticket`, or of a ticket merged into
 * it (a chain of merges included: the mail may answer the merged ticket's
 * thread or the kept ticket's CC notice), when not blocked. Not allowed for
 * anyone else on a portal ticket, and never for a blocked contact.
 */
export async function portalReplyAuthority(
  ticket: { id: number; requester_id: number | null; requester_email: string; portal_contact_id?: number | null },
  fromEmail: string
): Promise<PortalAuthority | null> {
  const from = fromEmail.trim().toLowerCase();
  const { getContactByEmail, contactReaches } = await import("./portal");
  const sender = from ? await getContactByEmail(from) : undefined;
  const portalTicket = !!ticket.portal_contact_id;
  if (!sender) return portalTicket ? NOT_ALLOWED : null;
  if (await contactBlocked(sender)) return { allowed: false, blocked: true, contactId: null };
  if (!(await portalAdmits(from))) return null;
  // A portal ticket with a workspace requester is not the contact's to answer.
  if (portalTicket && ticket.requester_id !== null) return NOT_ALLOWED;
  if (await contactReaches(sender.id, ticket.id)) return { allowed: true, blocked: false, contactId: sender.id };
  return portalTicket ? NOT_ALLOWED : null;
}

/** Is this address a blocked portal contact (by mailbox)? (Inbound email opens no ticket for them.) */
export async function portalContactBlocked(fromEmail: string): Promise<boolean> {
  const { isBlockedPortalMailbox } = await import("./portal");
  return isBlockedPortalMailbox(fromEmail.trim());
}

/**
 * Inbound email (lib/helpdesk/inbound): a portal contact's reply to a
 * closed ticket they reach opens the desk's usual follow-up ticket, but as
 * a portal ticket of theirs (source portal_external, portal_contact_id set
 * in the insert transaction, so the received notice is the portal's and
 * the request shows in the portal). Outside senders does not apply: the
 * contact's authority on the closed ticket was checked first.
 */
export async function createPortalFollowUp(
  contactId: number,
  input: { subject: string; body: string; name: string; email: string; teamId: number | null; emailMessageId: string | null; closedNumber: number },
  ctx: { origin?: string }
): Promise<{ id: number; number: number }> {
  const { insertTicketTx } = await import("./tickets");
  const row = await withTx(async (client) => {
    const r = await insertTicketTx(client, {
      subject: input.subject,
      body: input.body,
      requester: { id: null, name: input.name, email: input.email },
      via: "email",
      source: "portal_external",
      source_ref: { follow_up_of: input.closedNumber },
      team_id: input.teamId,
      email_message_id: input.emailMessageId,
    });
    await client.query("UPDATE hd_tickets SET portal_contact_id = $2 WHERE id = $1", [r.id, contactId]);
    return r;
  });
  const { afterTicketCreated } = await import("./events");
  await afterTicketCreated(row, { origin: ctx.origin, actorId: null, actorName: input.name });
  return { id: row.id, number: row.number };
}
