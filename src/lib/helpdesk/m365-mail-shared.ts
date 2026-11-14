// Helpdesk 1.20.7: Microsoft 365 mailbox connection, the pure half. The
// shapes the Email settings page reads, the limits, and the Exchange Online
// PowerShell commands that limit the app registration to the help mailboxes
// (Microsoft's "RBAC for Applications"; nothing in Microsoft Graph can do
// that step, so the admin runs it once). No database, no server-only
// imports.

export const M365_MAIL_LIMITS = {
  mailboxes: 25,
  folder: 60,
  pollMin: 1,
  pollMax: 60,
  /** A message that fails this many times is left alone, with a visible error. */
  attempts: 5,
} as const;

export const M365_DEFAULTS = { after: "read", folder: "Processed", notifications: true, poll_minutes: 2 } as const;

/** With notifications working, the timer still reads every this many minutes as a safety net. */
export const M365_SAFETY_NET_MINUTES = 15;
/** Subscriptions are asked for this long and renewed a day before they end (Microsoft allows just under 7 days). */
export const M365_SUBSCRIPTION_MINUTES = 2 * 24 * 60;
export const M365_RENEW_BEFORE_MINUTES = 24 * 60;

/** The Exchange Online application roles the desk needs, and what each is for. */
export const M365_ROLES = [
  { role: "Application Mail.ReadWrite", graph: "Mail.ReadWrite", why: "read new mail, mark it read or move it" },
  { role: "Application Mail.Send", graph: "Mail.Send", why: "send replies as the mailbox" },
] as const;

/**
 * The Graph application permissions in an app token that, granted in Entra,
 * reach the mail of every mailbox in the organisation: the Mail.* family
 * (Mail.Read, Mail.ReadWrite, Mail.Send, Mail-Advanced.ReadWrite.All, ...)
 * and the mailbox-wide families beside it (MailboxItem.*.All,
 * MailboxFolder.*.All), whatever members Microsoft adds to them. The list
 * is Microsoft's role table for "RBAC for Applications in Exchange Online".
 */
export function tenantWideRoles(roles: readonly string[]): string[] {
  return roles.filter((r) => /^(Mail|Mail-Advanced|MailboxItem|MailboxFolder)\.[A-Za-z.]+$/.test(r)).slice(0, 20);
}

/**
 * A Microsoft 365 mailbox's address as the desk takes it: lower-cased, one
 * address, and a conservative character set (letters, digits, ".", "_",
 * "-" and "'" before the "@"). The address goes into commands an Exchange
 * administrator pastes into PowerShell and into Graph paths, so the
 * characters a shell or a path gives meaning to are never accepted, even
 * though an email address may hold them. Null when it does not fit.
 */
export function cleanM365Address(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const a = raw.trim().toLowerCase();
  if (!a || a.length > 200) return null;
  return /^[a-z0-9](?:[a-z0-9._'-]{0,62}[a-z0-9_'-])?@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(a) ? a : null;
}

/** Why a mailbox address typed into the form is refused ('' = fine). The API answers the same sentences. */
export function m365AddressProblem(raw: string): string {
  const a = raw.trim();
  if (!a) return "Enter the mailbox's address.";
  if (a.includes("+")) return "Leave out the + tag: enter the mailbox's main address.";
  if (!cleanM365Address(a)) return "Enter the mailbox's main address, such as help@yourcompany.com. Only letters, digits, dots, hyphens, underscores and apostrophes can come before the @.";
  return "";
}

/**
 * How Microsoft Graph is told which mailbox is meant, when it is not by the
 * address: the mailbox's object ID (a GUID; what Microsoft recommends, it
 * always names one mailbox) or its sign-in name (user principal name), held
 * to the same character set as an address. '' when nothing was typed, null
 * when what was typed is neither.
 */
export function cleanM365GraphId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim().toLowerCase();
  if (!v) return "";
  if (isGuid(v)) return v;
  return cleanM365Address(v);
}

export const M365_GRAPH_ID_PROBLEM = "Enter the mailbox's object ID (a GUID) or its sign-in name, such as help@yourcompany.com.";
/** Shown with an error that the address alone may explain. */
export const M365_GRAPH_ID_HINT = "If the mailbox's sign-in name is not this address, enter its object ID or sign-in name under Advanced.";

export const M365_APP_NAME = "CompassDocs Helpdesk Mail";
export const M365_SCOPE_NAME = "CompassDocs help mailboxes";

export type M365AfterIntake = "read" | "move";

/** Why new mail is read the way it is, in one word; the page turns it into a sentence. */
export type M365Mode = "idle" | "notifications" | "timer_off" | "timer_no_address" | "timer_refused" | "timer_pending";

export const M365_IDLE = "No help address lives here yet, so it is not being read.";

export interface M365MailboxView {
  id: number;
  address: string;
  /** The object ID or sign-in name Microsoft Graph is asked by, when one was given ('' = by the address). */
  graph_id: string;
  mode: M365Mode;
  /** Until when Microsoft keeps notifying (null = no subscription). */
  sub_expires_at: string | null;
  sub_error: string;
  sub_error_at: string | null;
  last_notified_at: string | null;
  last_poll_at: string | null;
  last_ok_at: string | null;
  last_error: string;
  last_error_at: string | null;
  taken_in: number;
  dropped: number;
  /** Messages given up on after the retry cap (still in the Inbox, unread). "Try again" starts them over. */
  failed: number;
  /** Messages waiting to be tried again (Microsoft was busy or unreachable, or the desk's own limits). */
  waiting: number;
  connected_at: string;
  /** The help addresses that live on this mailbox. */
  addresses: { id: number; address: string; send_via: boolean }[];
}

/** One of the last messages seen in a mailbox, for the diagnostic: how its sender check went. Never any content. */
export interface M365MessageDiag {
  /** When Exchange received it (else when the desk saw it). */
  at: string;
  /** The domain of the From address ('' when it had none). */
  sender_domain: string;
  /** "passed", "failed", "internal" (Exchange's own stamp), "none" (no result from Exchange), '' (not read that far). */
  check: "passed" | "failed" | "internal" | "none" | "";
  /** One line: what Exchange's headers said and how they were read. */
  reason: string;
  /** What became of it ("created", "appended", "ignored_auto", "waiting", "failed", …). */
  outcome: string;
}

export interface M365AccessCheck {
  at: string;
  /** Graph mail permissions granted in Entra itself: with any of these the app reaches every mailbox. */
  tenant_wide: string[];
  mailboxes: { address: string; ok: boolean; error: string }[];
  /** A mailbox the desk should NOT reach, when the admin named one. */
  probe: { address: string; reachable: boolean; note: string } | null;
}

export interface M365LinkView {
  /** The help address (hd_mailboxes.id). */
  mailbox_id: number;
  m365_mailbox_id: number;
  m365_address: string;
  /** "Send replies through Microsoft 365" is chosen and in force (no send-from address is picked instead). */
  send_via: boolean;
  send_error: string;
  send_error_at: string | null;
}

export interface M365MailView {
  connected: boolean;
  tenant: string;
  client_id: string;
  /** The enterprise application's object ID (the commands need it); '' until the app has signed in once. */
  sp_object_id: string;
  secret_set: boolean;
  secret_expires: string;
  setup: "one_click" | "manual" | "";
  /** False while Microsoft is still activating a new app registration. */
  verified: boolean;
  after: M365AfterIntake;
  folder: string;
  notifications: boolean;
  poll_minutes: number;
  /** Where Microsoft would send notifications ('' = this desk has no address Microsoft can reach). */
  notify_url_ok: boolean;
  notify_origin: string;
  mailboxes: M365MailboxView[];
  links: M365LinkView[];
  access: M365AccessCheck | null;
  /**
   * Graph mail permissions the app's own token carries (granted in Entra): with any, it reaches EVERY mailbox. Read
   * when the connection is saved and again every half hour, without anyone pressing Check access.
   */
  tenant_wide: string[];
  tenant_wide_at: string | null;
  limit: number;
  /** Mailboxes are still listed from a connection that was removed. */
  orphaned: boolean;
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isGuid = (v: string) => GUID.test(v.trim());

/** Why what was typed into the manual form is refused ('' = fine). The API answers the same sentences. */
export function m365CredentialsProblem(raw: { tenant?: unknown; client_id?: unknown; secret?: unknown }, secretOptional = false): string {
  const tenant = typeof raw.tenant === "string" ? raw.tenant.trim() : "";
  const client = typeof raw.client_id === "string" ? raw.client_id.trim() : "";
  const secret = typeof raw.secret === "string" ? raw.secret.trim() : "";
  if (!tenant) return "Enter the tenant ID.";
  if (!isGuid(tenant) && !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i.test(tenant)) return "The tenant is its ID (a GUID) or a domain such as contoso.onmicrosoft.com.";
  if (!isGuid(client)) return "The application (client) ID is a GUID. Copy it from the app registration's Overview page.";
  if (!secret && !secretOptional) return "Enter the client secret's value.";
  if (secret.length > 400) return "That is too long to be a client secret.";
  return "";
}

/** A folder name as stored: no slashes or control characters, at most 60 characters. */
export function cleanFolderName(raw: unknown): string {
  return typeof raw === "string" ? raw.replace(/[\u0000-\u001f\\/]/g, " ").replace(/\s{2,}/g, " ").trim().slice(0, M365_MAIL_LIMITS.folder) : "";
}

/**
 * A value as a PowerShell single-quoted literal: nothing inside one is
 * expanded or run, and the only character with meaning, the quote, is
 * doubled.
 */
export const psLiteral = (v: string) => `'${v.replace(/'/g, "''")}'`;

/**
 * The recipient filter that names exactly these mailboxes, as PowerShell
 * will read it once the literal around it is opened: each address is a
 * quoted string of the filter language (its own quotes doubled). The
 * property is EmailAddresses, as Microsoft's list of filterable properties
 * asks ("Don't use the PrimarySmtpAddress property; use the EmailAddresses
 * property instead"); a complete address needs no "smtp:" before it. It
 * matches the one mailbox that holds the address, as its main address or
 * as an alias.
 */
export function scopeFilter(addresses: readonly string[]): string {
  return addresses.map((a) => `EmailAddresses -eq ${psLiteral(a)}`).join(" -or ");
}

/**
 * The Exchange Online PowerShell block that lets the app reach the help
 * mailboxes and nothing else. `first`: the whole setup (register the app's
 * service principal in Exchange, make the scope, assign the two roles);
 * otherwise only the scope is rewritten (a mailbox was added or removed).
 * Null when there is nothing to name yet.
 *
 * An admin copies this into a shell, so every value is a single-quoted
 * literal (the filter is one too, with the addresses' quotes doubled again
 * inside it), and an address that is not a plain mailbox address
 * (cleanM365Address) is left out rather than written.
 *
 * The last lines look, not change. Get-EXOMailbox prints each mailbox's
 * sign-in name and object ID (for the "Object ID or sign-in name" field).
 * Test-ServicePrincipalAuthorization shows what the app may do with the
 * first mailbox (its -Resource takes a name, a distinguished name or a
 * GUID: the object ID when the desk has it, else the address).
 */
export function restrictCommands(opts: { clientId: string; spObjectId: string; addresses: readonly string[]; first: boolean; graphIds?: Readonly<Record<string, string>> }): string | null {
  const addresses = [...new Set(opts.addresses.map((a) => cleanM365Address(a)).filter((a): a is string => !!a))];
  if (!addresses.length || !isGuid(opts.clientId) || !isGuid(opts.spObjectId)) return null;
  const app = psLiteral(opts.spObjectId.trim().toLowerCase());
  const scope = psLiteral(M365_SCOPE_NAME);
  const filter = psLiteral(scopeFilter(addresses));
  const known = cleanM365GraphId(opts.graphIds?.[addresses[0]] ?? "") || "";
  const look = addresses.map((a) => `Get-EXOMailbox -Identity ${psLiteral(a)} | Format-List UserPrincipalName, ExternalDirectoryObjectId`);
  const test = `Test-ServicePrincipalAuthorization -Identity ${app} -Resource ${psLiteral(isGuid(known) ? known : addresses[0])} | Format-Table RoleName, GrantedPermissions, AllowedResourceScope, InScope`;
  if (!opts.first) {
    return [`Connect-ExchangeOnline`, `Set-ManagementScope -Identity ${scope} -RecipientRestrictionFilter ${filter}`, ...look, test].join("\n");
  }
  return [
    `Connect-ExchangeOnline`,
    `New-ServicePrincipal -AppId ${psLiteral(opts.clientId.trim().toLowerCase())} -ObjectId ${app} -DisplayName ${psLiteral(M365_APP_NAME)}`,
    `New-ManagementScope -Name ${scope} -RecipientRestrictionFilter ${filter}`,
    ...M365_ROLES.map((r) => `New-ManagementRoleAssignment -Name ${psLiteral(`CompassDocs ${r.graph}`)} -App ${app} -Role ${psLiteral(r.role)} -CustomResourceScope ${scope}`),
    ...look,
    test,
  ].join("\n");
}

/** One sentence for how a mailbox's new mail arrives. */
export function modeSentence(mode: M365Mode, pollMinutes: number, origin: string): string {
  if (mode === "idle") return M365_IDLE;
  const every = pollMinutes === 1 ? "every minute" : `every ${pollMinutes} minutes`;
  if (mode === "notifications") return `Microsoft tells the desk when mail arrives. The desk also checks every ${M365_SAFETY_NET_MINUTES} minutes.`;
  if (mode === "timer_off") return `Notifications are off, so the desk checks ${every}.`;
  if (mode === "timer_no_address") return `Microsoft can't reach this desk${origin ? ` at ${origin}` : ""} (it needs a public https address), so the desk checks ${every}.`;
  if (mode === "timer_refused") return `Microsoft refused notifications for this mailbox, so the desk checks ${every}.`;
  return `Notifications are being set up. Until then the desk checks ${every}.`;
}
